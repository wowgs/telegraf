package hostdash

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/metric"
)

func statusesByID(l layout) map[string]sectionStatus {
	out := make(map[string]sectionStatus)
	for _, s := range l.Statuses {
		out[s.ID] = s
	}
	return out
}

// TestSectionStatus: a section is "no data" when its input has no point,
// "errors" when the failed gathers of its input grew, "bad" or "warn" by a
// check of its own measurement, and the worst one wins.
func TestSectionStatus(t *testing.T) {
	f := mustFields(t, nil, nil, []string{"internal_gather.gather_errors"})
	st := testStore(f)
	sections := []sectionConfig{
		{Measurement: "pressure", Input: "kernel", Page: "Load", Title: "Pressure"},
		{Measurement: "kernel", Page: "Load", Title: "Kernel"},
		{Measurement: "disk", Page: "Storage"},
		{Measurement: "mem", Page: "Memory"},
		{Measurement: "nvidia_smi", Page: "GPU"}, // no metrics: no data
		{Measurement: "internal_gather", Input: "internal", Page: "Telegraf"},
	}
	checks := []checkConfig{
		{Field: "pressure.total", Warn: new(5.0)},
		{Field: "disk.used_percent", Warn: new(80.0), Bad: new(95.0)},
		{Field: "mem.available", Of: "mem.total", Below: true, Warn: new(0.15), Bad: new(0.05)},
	}
	for i := range 2 {
		at := t0.Add(time.Duration(i) * 10 * time.Second)
		st.add([]telegraf.Metric{
			metric.New("pressure", map[string]string{"resource": "cpu"}, map[string]any{"total": uint64(10 + i)}, at),
			metric.New("disk", map[string]string{"path": "/"}, map[string]any{"used_percent": 91.0}, at),
			metric.New("disk", map[string]string{"path": "/boot"}, map[string]any{"used_percent": 20.0}, at),
			metric.New("mem", nil, map[string]any{"available": uint64(40), "total": uint64(1000)}, at),
			// the kernel input failed to gather once between the two readings
			metric.New("internal_gather", map[string]string{"input": "kernel"}, map[string]any{"gather_errors": int64(3 + i)}, at),
			metric.New("internal_gather", map[string]string{"input": "disk"}, map[string]any{"gather_errors": int64(7)}, at),
			metric.New("internal_gather", map[string]string{"input": "mem"}, map[string]any{"gather_errors": int64(0)}, at),
			metric.New("internal_gather", map[string]string{"input": "nvidia_smi"}, map[string]any{"gather_errors": int64(0)}, at),
			metric.New("internal_gather", map[string]string{"input": "internal"}, map[string]any{"gather_errors": int64(0)}, at),
		}, at)
	}
	l := st.layout(testPage(sections, checks), t0.Add(20*time.Second))
	s := statusesByID(l)

	require.Equal(t, "errors", s["Load/pressure"].Status, "its input kernel failed to gather")
	require.Equal(t, []string{"kernel: gather_errors grew", "pressure.total max 11 ≥ 5"}, s["Load/pressure"].Reasons)
	require.Equal(t, "errors", s["Load/kernel"].Status, "the same input: no data of its own measurement is not no data")
	require.Equal(t, []string{"kernel: gather_errors grew"}, s["Load/kernel"].Reasons, "the check of pressure is not a reason of kernel")
	require.Equal(t, "Kernel", s["Load/kernel"].Title)
	require.Equal(t, "warn", s["Storage/disk"].Status, "the max of 91 and 20 is over warn, not over bad; its old errors did not grow")
	require.Equal(t, []string{"disk.used_percent max 91 ≥ 80"}, s["Storage/disk"].Reasons)
	require.Equal(t, "bad", s["Memory/mem"].Status)
	require.Equal(t, []string{"mem.available/total min 0.04 < 0.05"}, s["Memory/mem"].Reasons)
	require.Equal(t, "no data", s["GPU/nvidia_smi"].Status)
	require.Equal(t, "ok", s["Telegraf/internal_gather"].Status)

	// One entry per section, in the order of the config, with the ids of the
	// sections of the layout.
	ids := make([]string, 0, len(l.Statuses))
	for _, x := range l.Statuses {
		ids = append(ids, x.ID)
	}
	require.Equal(t, []string{"Load/pressure", "Load/kernel", "Storage/disk", "Memory/mem", "GPU/nvidia_smi", "Telegraf/internal_gather"}, ids)
	for _, tab := range l.Tabs[1:] {
		for _, sec := range tab.Sections {
			require.Contains(t, s, sec.ID, "every section of the layout has a status")
		}
	}
}

func TestWorstStatusWins(t *testing.T) {
	require.Equal(t, "no data", worse("errors", "no data"))
	require.Equal(t, "errors", worse("errors", "bad"))
	require.Equal(t, "warn", worse("ok", "warn"))
}

func TestCheckAggregates(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	for _, v := range []float64{10, 20, 30} {
		st.add([]telegraf.Metric{metric.New("m", map[string]string{"k": string(rune('a' + int(v)/10))}, map[string]any{"x": v}, t0)}, t0)
	}
	gs := make([]*group, 0, len(st.groups))
	for _, g := range st.groups {
		gs = append(gs, g)
	}
	for agg, want := range map[string]string{"max": "bad", "avg": "warn", "min": "ok", "sum": "bad"} {
		c := checkConfig{Field: "m.x", Agg: agg, Warn: new(15.0), Bad: new(25.0)}
		level, _ := c.evaluate(gs)
		require.Equal(t, want, level, agg)
	}
	level, reason := (&checkConfig{Field: "m.missing", Bad: new(1.0)}).evaluate(gs)
	require.Equal(t, "ok", level, "no value is not a failed check")
	require.Empty(t, reason)
}

func TestValidateInputsAndChecks(t *testing.T) {
	h := valid(&Hostdash{DefaultPage: "Other", Sections: []sectionConfig{
		{Measurement: "kernel", Page: "CPU"},
		{Measurement: "pressure", Input: "kernel", Page: "Load"},
	}})
	require.ErrorContains(t, h.validate(), `input "kernel" is on the tabs "CPU" and "Load"`)
	h.Sections[0].Page = "Load"
	require.NoError(t, h.validate())

	for check, msg := range map[checkConfig]string{
		{Field: "used_percent", Bad: new(1.0)}:                    "is not measurement.field",
		{Field: "disk.used_percent"}:                              "no warn and no bad",
		{Field: "disk.used_percent", Agg: "p95", Bad: new(1.0)}:   "agg must be max, min, avg or sum",
		{Field: "mem.available", Of: "disk.total", Bad: new(1.0)}: `of "disk.total" is not a field of "mem"`,
	} {
		h.Checks = []checkConfig{check}
		require.ErrorContains(t, h.validate(), msg, check.Field)
	}
	h.Checks = []checkConfig{{Field: "mem.available", Of: "mem.total", Below: true, Warn: new(0.1)}}
	require.NoError(t, h.validate())
}

// TestStatusMatchesLayout: /api/status gives the same statuses as the layout
// without building the panels.
func TestStatusMatchesLayout(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{metric.New("disk", map[string]string{"path": "/"}, map[string]any{"used_percent": 91.0}, t0)}, t0)
	sections := []sectionConfig{{Measurement: "disk", Page: "Storage"}, {Measurement: "mem", Page: "Memory"}}
	checks := []checkConfig{{Field: "disk.used_percent", Warn: new(80.0)}}
	l := st.layout(testPage(sections, checks), t0)
	s := st.status(testPage(sections, checks), t0)
	require.Equal(t, l.Statuses, s.Statuses)
	require.Equal(t, l.Series, s.Series)
	require.Equal(t, l.Silent, s.Silent)
}

// TestUnitsFollowReload: the unit of a series is kept on the series and
// looked up again when the configuration changes.
func TestUnitsFollowReload(t *testing.T) {
	st := testStore(mustFields(t, map[string]string{"mem.*": "B"}, nil, nil))
	st.add([]telegraf.Metric{metric.New("mem", nil, map[string]any{"used": 1.0}, t0)}, t0)
	unit := func() string { return st.layout(testPage(nil, nil), t0).Tabs[1].Sections[0].Units["used"] }
	require.Equal(t, "B", unit())
	st.configure(time.Hour, mustFields(t, map[string]string{"mem.used": "KiB"}, nil, nil))
	require.Equal(t, "KiB", unit())
}

// TestInputNotGathered: a section whose input internal_gather never names (a
// typo in input) gets a warn, since its errors could never show.
func TestInputNotGathered(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("pressure", nil, map[string]any{"total": 1.0}, t0),
		metric.New("internal_gather", map[string]string{"input": "kernel"}, map[string]any{"gather_errors": int64(0)}, t0),
	}, t0)
	sections := []sectionConfig{{Measurement: "pressure", Input: "kernal", Page: "Load"}}
	s := statusesByID(st.layout(testPage(sections, nil), t0))["Load/pressure"]
	require.Equal(t, "warn", s.Status)
	require.Contains(t, s.Reasons, "input kernal not in internal_gather")
	sections[0].Input = "kernel"
	require.Equal(t, "ok", statusesByID(st.layout(testPage(sections, nil), t0))["Load/pressure"].Status)
}

// TestStatusOrderIsTheTabOrder: measurements without a section come in the
// same natural order on the Overview as on their tab.
func TestStatusOrderIsTheTabOrder(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("disk10", nil, map[string]any{"v": 1.0}, t0),
		metric.New("disk2", nil, map[string]any{"v": 1.0}, t0),
	}, t0)
	l := st.layout(testPage(nil, nil), t0)
	tab, overview := make([]string, 0, len(l.Tabs[1].Sections)), make([]string, 0, len(l.Statuses))
	for _, s := range l.Tabs[1].Sections {
		tab = append(tab, s.ID)
	}
	for _, s := range l.Statuses {
		overview = append(overview, s.ID)
	}
	require.Equal(t, []string{"Other/disk2", "Other/disk10"}, tab)
	require.Equal(t, tab, overview)
}

// TestEmptySectionsAreInTheLayout: every section of the config is in the
// layout, also without data, so a tab with no data yet is still a tab.
func TestEmptySectionsAreInTheLayout(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{metric.New("cpu", nil, map[string]any{"v": 1.0}, t0)}, t0)
	sections := []sectionConfig{
		{Measurement: "nvidia_smi", Page: "GPU"},
		{Measurement: "cpu", Page: "CPU"},
	}
	l := st.layout(testPage(sections, nil), t0)
	tabs := make([]string, 0, len(l.Tabs))
	for _, tab := range l.Tabs {
		tabs = append(tabs, tab.ID)
	}
	require.Equal(t, []string{"overview", "GPU", "CPU"}, tabs, "the order of the config")
	require.True(t, l.Tabs[1].Sections[0].Empty)
	require.False(t, l.Tabs[2].Sections[0].Empty)
	require.Equal(t, statusOrder, l.StatusOrder)
}
