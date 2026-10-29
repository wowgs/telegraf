package hostdash

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/stretchr/testify/require"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/metric"
	"github.com/influxdata/telegraf/plugins/outputs"
	"github.com/influxdata/telegraf/testutil"
)

var t0 = time.Unix(1_700_000_000, 0)

func mustFields(t *testing.T, units map[string]string, scales map[string]float64, counters []string) *fields {
	t.Helper()
	f, err := newFields(units, scales, counters)
	require.NoError(t, err)
	return f
}

func testStore(f *fields) *store {
	st := newStore()
	st.configure(time.Hour, f)
	return st
}

func seriesOf(st *store, key, fieldName string) *series {
	return st.groups[key].series[fieldName]
}

// pt is a point as the tests compare them.
type pt struct {
	t int64
	v float64
}

// pointsOf is the points of a series, oldest first.
func pointsOf(s *series) []pt {
	out := make([]pt, 0, s.points.len())
	for i := range s.points.len() {
		out = append(out, pt{s.points.at(i), s.points.v[s.points.lo+i]})
	}
	return out
}

// testPage is the prepared config of a page with these sections and checks.
func testPage(sections []sectionConfig, checks []checkConfig) *pageConfig {
	return (&Hostdash{Title: "box", DefaultPage: "Other", Sections: sections, Checks: checks}).compile()
}

// TestGaugeKeepsValuesAndEveryTag: every tag is an ordinary tag of the group;
// the plugin reads no tag of its own.
func TestGaugeKeepsValuesAndEveryTag(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("mem", map[string]string{"ui_page": "Box"}, map[string]any{"used": int64(10)}, t0),
		metric.New("mem", map[string]string{"ui_page": "Box"}, map[string]any{"used": int64(12)}, t0.Add(2*time.Second)),
	}, t0)
	require.Len(t, st.groups, 1)
	for _, g := range st.groups {
		require.Equal(t, map[string]string{"ui_page": "Box"}, g.tags)
		require.Equal(t, []pt{{t0.UnixMilli(), 10}, {t0.Add(2 * time.Second).UnixMilli(), 12}}, pointsOf(g.series["used"]))
	}
}

func TestCounterBecomesRateAndSkipsReset(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, []string{"net.bytes_*"}))
	tags := map[string]string{"interface": "eth0"}
	values := []uint64{1000, 3000, 500, 1500}
	ms := make([]telegraf.Metric, 0, len(values))
	for i, v := range values { // 500: the counter was reset
		ms = append(ms, metric.New("net", tags, map[string]any{"bytes_recv": v}, t0.Add(time.Duration(i)*2*time.Second)))
	}
	st.add(ms, t0)
	s := seriesOf(st, "net,interface=eth0", "bytes_recv")
	require.Equal(t, counter, s.kind)
	// 1000→3000 in 2 s = 1000 B/s; 3000→500 is a reset and gives no point; 500→1500 in 2 s = 500 B/s.
	require.Equal(t, []pt{{t0.Add(2 * time.Second).UnixMilli(), 1000}, {t0.Add(6 * time.Second).UnixMilli(), 500}}, pointsOf(s))
}

func TestMetricTypeDoesNotMakeACounter(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("system", nil, map[string]any{"uptime": uint64(100)}, t0, telegraf.Counter),
		metric.New("system", nil, map[string]any{"uptime": uint64(102)}, t0.Add(2*time.Second), telegraf.Counter),
	}, t0)
	s := seriesOf(st, "system", "uptime")
	require.Equal(t, gauge, s.kind)
	require.Equal(t, 2, s.points.len())
}

func TestScaleFromConfig(t *testing.T) {
	st := testStore(mustFields(t, nil, map[string]float64{"linux_cpu.*_freq": 1000}, nil))
	st.add([]telegraf.Metric{
		metric.New("linux_cpu", map[string]string{"cpu": "0"}, map[string]any{"scaling_cur_freq": uint64(2400000)}, t0),
	}, t0)
	require.InDelta(t, 2.4e9, pointsOf(seriesOf(st, "linux_cpu,cpu=0", "scaling_cur_freq"))[0].v, 1)
}

func TestUnitLookupPrefersExactThenLongest(t *testing.T) {
	f := mustFields(t, map[string]string{"mem.*": "B", "mem.*_percent": "%", "mem.used_percent": "x"}, nil, nil)
	require.Equal(t, "x", f.unit("mem", "used_percent"))
	require.Equal(t, "%", f.unit("mem", "available_percent"))
	require.Equal(t, "B", f.unit("mem", "used"))
	require.Empty(t, f.unit("cpu", "usage_user"))
	// An exact name wins also over a longer pattern.
	g := mustFields(t, map[string]string{"mem.used": "x", "mem.used*": "y"}, nil, nil)
	require.Equal(t, "x", g.unit("mem", "used"))
	require.Equal(t, "y", g.unit("mem", "used_percent"))
	_, err := newFields(map[string]string{"nodot": "B"}, nil, nil)
	require.Error(t, err)
}

func TestTextField(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("y", nil, map[string]any{"state": "P8", "b": 1.0}, t0),
	}, t0)
	require.Equal(t, 2, st.nseries)
	s := seriesOf(st, "y", "state")
	require.Equal(t, text, s.kind)
	require.Equal(t, "P8", s.text)
}

func TestWindowTrimsPointsAndSweepDropsGroups(t *testing.T) {
	st := newStore()
	st.configure(10*time.Second, mustFields(t, nil, nil, nil))
	ms := make([]telegraf.Metric, 0, 20)
	for i := range 20 {
		ms = append(ms, metric.New("g", nil, map[string]any{"v": float64(i)}, t0.Add(time.Duration(i)*time.Second)))
	}
	st.add(ms, t0)
	p := pointsOf(st.groups["g"].series["v"])
	require.InDelta(t, 9.0, p[0].v, 0) // points older than 10 s before the newest (19 s) are gone
	st.sweep(t0.Add(11 * time.Second))
	require.Empty(t, st.groups)
	require.Equal(t, 0, st.nseries)
}

func TestLayoutShowsEverythingUnlessASectionFilters(t *testing.T) {
	f := mustFields(t, map[string]string{"mem.*": "B", "net.bytes_*": "B"}, nil, []string{"net.bytes_*"})
	sections := []sectionConfig{{
		Measurement: "mem", Title: "Memory", Page: "System", GroupBy: []string{"host"}, Agg: "max",
		Tiles:  []tileConfig{{Field: "available", Title: "Memory available", Sub: "of {total} on {tag:host}", Of: "total"}},
		Charts: []chartConfig{{Title: "Memory", Fields: []string{"used", "cached"}, MaxField: "total"}},
	}, {
		Measurement: "llama", Title: "llama-server", Page: "LLM",
		Charts: []chartConfig{{Title: "Busy", Fields: []string{"busy"}}},
	}}
	st := testStore(f)
	st.add([]telegraf.Metric{
		metric.New("mem", nil, map[string]any{
			"available": uint64(25), "total": uint64(100), "used": uint64(75), "cached": uint64(5), "slab": uint64(1),
		}, t0),
		metric.New("llama", map[string]string{"url": "http://127.0.0.1:8080/metrics"}, map[string]any{"busy": 1.0}, t0),
		metric.New("myapp", map[string]string{"q": "a"}, map[string]any{"queue": 3.0, "version": "1.2"}, t0),
		metric.New("myapp", map[string]string{"q": "b"}, map[string]any{"queue": 4.0}, t0),
		metric.New("net", map[string]string{"interface": "eth0"}, map[string]any{"bytes_recv": uint64(1)}, t0),
	}, t0)
	l := st.layout(testPage(sections, nil), t0)
	ids := make([]string, 0, len(l.Tabs))
	tabs := map[string]tabOut{}
	for _, tab := range l.Tabs {
		ids = append(ids, tab.ID)
		tabs[tab.ID] = tab
	}
	// Configured sections first; the rest go to the default page.
	require.Equal(t, []string{"overview", "System", "LLM", "Other"}, ids)

	mem := tabs["System"].Sections[0]
	require.Equal(t, "Memory", mem.Title)
	require.False(t, mem.Auto)
	require.Len(t, mem.Groups, 1)
	// A configured section is a filter: only the fields its panels use reach the page.
	require.ElementsMatch(t, []string{"available", "total", "used", "cached"}, keys(mem.Groups[0].Series))
	require.Equal(t, "B", mem.Units["used"])
	require.Equal(t, "B", mem.Charts[0].Unit)
	require.Equal(t, "total", mem.Charts[0].MaxField)
	require.Equal(t, &grouping{Mode: "by", Tags: []string{"host"}}, mem.Group)
	require.Equal(t, "max", mem.Agg)
	require.Equal(t, []part{{Text: "of "}, {Field: "total"}, {Text: " on "}, {Tag: "host"}}, mem.Tiles[0].Sub)

	require.Equal(t, "llama-server", tabs["LLM"].Sections[0].Title)

	// Without a section every field is shown; groups carry their tags.
	var app, net sectionOut
	for _, s := range tabs["Other"].Sections {
		switch s.Measurement {
		case "myapp":
			app = s
		case "net":
			net = s
		}
	}
	require.True(t, app.Auto)
	require.Len(t, app.Groups, 2)
	require.Equal(t, map[string]string{"q": "a"}, app.Groups[0].Tags)
	require.ElementsMatch(t, []string{"queue", "version"}, keys(app.Groups[0].Series))
	require.Equal(t, []string{"version"}, app.Text)
	// It gets a chart for each number field and a tile for each text field.
	require.Len(t, app.Charts, 1)
	require.Equal(t, chartOut{Title: "queue", Fields: []string{"queue"}, Unit: app.Units["queue"]}, app.Charts[0])
	require.Equal(t, []tileOut{{Title: "version", Field: "version"}}, app.Tiles)
	require.Equal(t, "B/s", net.Units["bytes_recv"]) // a counter is shown per second

	require.Empty(t, l.Tabs[0].Sections, "the overview shows the statuses, not sections")
}

func keys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestChangeFeed: /api/series sends the changes of a measurement after a
// write: the whole series when it is new to the asker, then only what
// changed, nothing for a series that did not; and from any write back, not
// only recent ones.
func TestChangeFeed(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }
	write := func(ms ...telegraf.Metric) uint32 {
		st.add(ms, at(1000))
		return st.seq
	}
	// ask gives each changed series with its own times, also when the
	// reply carries them once for the measurement.
	ask := func(m string, since uint32, p *pageConfig) map[int]seriesChange {
		d, _ := st.query([]feedQuery{{m, since}}, p, at(100))
		mc, ok := d.Series[m]
		if !ok {
			return nil
		}
		out := make(map[int]seriesChange, len(mc.Series))
		for id, c := range mc.Series {
			if c.Text == nil && c.T == nil {
				c.T = mc.T
			}
			out[id] = c
		}
		return out
	}
	none := testPage(nil, nil)
	pts := func(ts ...int64) []int64 { return ts }
	ms := func(s int) int64 { return at(s).UnixMilli() }

	s1 := write(metric.New("g", nil, map[string]any{"v": 1.0, "w": 5.0, "s": "a"}, at(0)))
	v, w, txt := st.groups["g"].series["v"].id, st.groups["g"].series["w"].id, st.groups["g"].series["s"].id
	all := ask("g", 0, none)
	require.Equal(t, seriesChange{T: pts(ms(0)), V: []float64{1}, Full: true}, all[v])
	require.Equal(t, "a", *all[txt].Text)

	s2 := write(metric.New("g", nil, map[string]any{"v": 2.0, "w": 6.0, "s": "a"}, at(10)))
	next := ask("g", s1, none)
	require.Equal(t, seriesChange{T: pts(ms(10)), V: []float64{2}}, next[v], "only the new point")
	require.NotContains(t, next, txt, "the text did not change")

	s3 := write(metric.New("h", nil, map[string]any{"x": 1.0}, at(10)))
	require.Empty(t, ask("g", s2, none), "g got nothing in this write")
	require.Empty(t, ask("nope", 0, none))

	// The same moment again with another value: the page gets that point anew.
	s4 := write(metric.New("g", nil, map[string]any{"v": 2.5, "w": 6.0}, at(10)))
	again := ask("g", s3, none)
	require.Equal(t, seriesChange{T: pts(ms(10)), V: []float64{2.5}}, again[v])
	require.NotContains(t, again, w, "the same value is no change")

	// A new field of g is sent whole.
	write(metric.New("g", nil, map[string]any{"y": 7.0}, at(20)))
	y := st.groups["g"].series["y"].id
	require.True(t, ask("g", s4, none)[y].Full)

	// However far back: only the points after that write, never the whole series.
	for i := range 40 {
		write(metric.New("g", nil, map[string]any{"v": float64(i)}, at(30+10*i)))
	}
	far := ask("g", s4, none)[v]
	require.False(t, far.Full)
	require.Len(t, far.T, 40)
	recent := ask("g", st.seq-2, none)[v]
	require.False(t, recent.Full)
	require.Equal(t, []int64{ms(30 + 10*38), 10000}, recent.T, "the first time, then the steps")

	// The section decides the series: a chart of v only.
	shown := ask("g", 0, testPage([]sectionConfig{{Measurement: "g", Charts: []chartConfig{{Fields: []string{"v"}}}}}, nil))
	require.Contains(t, shown, v)
	require.NotContains(t, shown, w)

	// A series whose rules changed starts again: sent whole.
	before := st.seq
	st.configure(time.Hour, mustFields(t, nil, map[string]float64{"g.v": 2}, nil))
	reset := ask("g", before, none)[v]
	require.True(t, reset.Full)
	require.Empty(t, reset.T, "no point under the new rules yet")
	require.NotContains(t, ask("g", before, none), w)

	// Both replies carry the start of the store: ids hold only within it.
	d, _ := st.query(nil, none, at(100))
	require.NotZero(t, d.Start)
	require.Equal(t, d.Start, st.layout(none, t0).Start)
}

// TestSharedTimes: the times go once with the measurement when its changed
// series share them, and with each series when they do not.
func TestSharedTimes(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("g", map[string]string{"n": "a"}, map[string]any{"v": 1.0}, t0),
		metric.New("g", map[string]string{"n": "b"}, map[string]any{"v": 2.0}, t0),
		metric.New("h", map[string]string{"n": "a"}, map[string]any{"v": 1.0}, t0),
		metric.New("h", map[string]string{"n": "b"}, map[string]any{"v": 2.0}, t0.Add(time.Second)),
	}, t0)
	d, _ := st.query([]feedQuery{{"g", 0}, {"h", 0}}, testPage(nil, nil), t0)
	require.Equal(t, []int64{t0.UnixMilli()}, d.Series["g"].T)
	for _, c := range d.Series["g"].Series {
		require.Nil(t, c.T)
	}
	require.Nil(t, d.Series["h"].T)
	for _, c := range d.Series["h"].Series {
		require.Len(t, c.T, 1)
	}
}

// TestKindFollowsTheValue: a field that turns from text into a number or
// back starts its series again.
func TestKindFollowsTheValue(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	add := func(v any, s int) {
		at := t0.Add(time.Duration(s) * time.Second)
		st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"f": v}, at)}, at)
	}
	add("N/A", 0)
	s := seriesOf(st, "g", "f")
	require.Equal(t, text, s.kind)
	add(1.0, 10)
	add(2.0, 20)
	require.Equal(t, gauge, s.kind)
	require.Equal(t, []pt{{t0.Add(10 * time.Second).UnixMilli(), 1}, {t0.Add(20 * time.Second).UnixMilli(), 2}}, pointsOf(s))
	add("N/A", 30)
	require.Equal(t, text, s.kind)
	require.Equal(t, "N/A", s.text)
}

// TestBufferStaysNearTheWindow: a series keeps about the window of points,
// not up to twice it.
func TestBufferStaysNearTheWindow(t *testing.T) {
	st := newStore()
	st.configure(time.Hour, mustFields(t, nil, nil, nil))
	most := 0
	for i := range 2000 {
		at := t0.Add(time.Duration(i) * 10 * time.Second)
		st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"v": float64(i)}, at)}, at)
		most = max(most, cap(seriesOf(st, "g", "v").points.t))
	}
	s := seriesOf(st, "g", "v")
	require.Equal(t, 361, s.points.len(), "an hour of points 10 s apart")
	require.LessOrEqual(t, most, 512, "the buffer grew to %d points", most)
}

// TestPageFiles checks that the page and uPlot are embedded.
func TestPageFiles(t *testing.T) {
	for _, f := range []string{
		"page/index.html", "page/style.css",
		"page/app.js", "page/api.js", "page/model.js", "page/format.js", "page/tile.js", "page/tip.js", "page/axis.js", "page/dom.js", "page/chart.js",
		"page/vendor/uPlot.iife.min.js", "page/vendor/uPlot.min.css",
	} {
		_, err := pageFiles.Open(f)
		require.NoError(t, err, f)
	}
	_, err := pageFiles.Open("pagetest/model.test.mjs")
	require.Error(t, err, "tests are not embedded")
}

// TestPageJS runs the page's pure-function tests when Node is installed.
func TestPageJS(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.Command(node, "--test", "pagetest").CombinedOutput()
	require.NoError(t, err, string(out))
}

func TestOneSectionPerMeasurement(t *testing.T) {
	h := valid(&Hostdash{Sections: []sectionConfig{{Measurement: "m"}, {Measurement: "m"}}})
	require.ErrorContains(t, h.validate(), `section 2: measurement "m" has a section already`)
}

// TestDefaults: the page listens on localhost only.
func TestDefaults(t *testing.T) {
	creator, ok := outputs.Outputs["hostdash"]
	require.True(t, ok)
	h, ok := creator().(*Hostdash)
	require.True(t, ok)
	require.Equal(t, "127.0.0.1:9000", h.Listen)
	require.Equal(t, []string{"zstd", "gzip"}, h.Compression)
	h.Log = testutil.Logger{}
	h.TipLines = 0
	require.ErrorContains(t, h.Init(), "tip_lines must be positive")
}

func TestSectionGroupingIsChecked(t *testing.T) {
	h := valid(&Hostdash{Sections: []sectionConfig{{Measurement: "m", GroupBy: []string{"cpu"}, Agg: "band"}}})
	require.NoError(t, h.validate())
	h.Sections[0].Agg = ""
	require.NoError(t, h.validate(), "the page picks the function")
	h.Sections[0].Agg = "mean"
	require.ErrorContains(t, h.validate(), `agg must be avg, min, max, sum or band, not "mean"`)
	h.Sections[0].Agg, h.Sections[0].GroupBy = "avg", nil
	require.ErrorContains(t, h.validate(), "agg needs group_by or group_without")
	h.Sections[0].GroupBy = []string{""}
	require.ErrorContains(t, h.validate(), "an empty tag")
	h.Sections[0].GroupBy = make([]string, 0)
	require.NoError(t, h.validate(), "group_by = []: one line")
	h.Sections[0].GroupWithout = []string{"cpu"}
	require.ErrorContains(t, h.validate(), "group_by and group_without together")
	h.Sections[0].GroupBy = nil
	require.NoError(t, h.validate())
	h.Sections[0].GroupWithout = make([]string, 0)
	require.ErrorContains(t, h.validate(), "group_without lists no tag")
}

// TestGroupingInLayout: the grouping goes to the page as one field, and an
// empty by stays an empty list.
func TestGroupingInLayout(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("a", map[string]string{"cpu": "0"}, map[string]any{"v": 1.0}, t0),
		metric.New("b", map[string]string{"cpu": "0"}, map[string]any{"v": 1.0}, t0),
		metric.New("c", map[string]string{"cpu": "0"}, map[string]any{"v": 1.0}, t0),
	}, t0)
	sections := []sectionConfig{
		{Measurement: "a", Page: "P", GroupBy: make([]string, 0), Agg: "avg"},
		{Measurement: "b", Page: "P", GroupWithout: []string{"cpu"}},
		{Measurement: "c", Page: "P"},
	}
	raw, err := json.Marshal(st.layout(testPage(sections, nil), t0))
	require.NoError(t, err)
	require.Contains(t, string(raw), `"group":{"mode":"by","tags":[]},"agg":"avg"`)
	require.Contains(t, string(raw), `"group":{"mode":"without","tags":["cpu"]}`)
	require.Equal(t, 2, strings.Count(string(raw), `"group":`), "no grouping: no field")
}

func TestNaturalLess(t *testing.T) {
	require.True(t, naturalLess("linux_cpu,cpu=2", "linux_cpu,cpu=10"))
	require.False(t, naturalLess("linux_cpu,cpu=10", "linux_cpu,cpu=2"))
	require.True(t, naturalLess("a", "b"))
	require.True(t, naturalLess("x1", "x1y"))
}

// TestCompressedReplies: the plugin compresses its replies by the
// Accept-Encoding of the client and its compression option, and they decode
// to the same JSON.
func TestCompressedReplies(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	for i := range 100 {
		at := t0.Add(time.Duration(i) * 10 * time.Second)
		st.add([]telegraf.Metric{metric.New("g", map[string]string{"n": "a"}, map[string]any{"v": float64(i) / 3}, at)}, at)
	}
	old := shared
	defer func() { shared = old }()
	shared = st
	plugin := func(compression ...string) *Hostdash {
		h := newPlugin(t)
		h.Compression = compression
		require.NoError(t, h.Init())
		// Only its handler is used: close it at once, so the next one can start.
		require.NoError(t, h.Close())
		return h
	}
	get := func(h *Hostdash, accept string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/series?m=g:0", nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		rec := httptest.NewRecorder()
		h.server.Handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		return rec
	}
	decode := func(rec *httptest.ResponseRecorder) seriesData {
		var r io.Reader = rec.Body
		switch rec.Header().Get("Content-Encoding") {
		case "gzip":
			zr, err := gzip.NewReader(rec.Body)
			require.NoError(t, err)
			r = zr
		case "zstd":
			zr, err := zstd.NewReader(rec.Body)
			require.NoError(t, err)
			defer zr.Close()
			r = zr
		}
		var d seriesData
		require.NoError(t, json.NewDecoder(r).Decode(&d))
		return d
	}

	def := plugin("zstd", "gzip") // the default of the option
	plain := get(def, "")
	require.Empty(t, plain.Header().Get("Content-Encoding"))
	plainLen := plain.Body.Len()
	want := decode(plain)
	require.Len(t, want.Series["g"].Series[0].V, 100)
	require.Len(t, want.Series["g"].T, 100)
	for accept, enc := range map[string]string{"gzip": "gzip", "zstd": "zstd", "gzip, deflate, br, zstd": "zstd"} {
		rec := get(def, accept)
		require.Equal(t, enc, rec.Header().Get("Content-Encoding"), accept)
		require.Contains(t, rec.Header().Values("Vary"), "Accept-Encoding", accept)
		require.Less(t, rec.Body.Len(), plainLen, accept)
		require.Equal(t, want.Series, decode(rec).Series, accept)
	}

	// The first listed is preferred; one not listed is not used; none: plain.
	require.Equal(t, "gzip", get(plugin("gzip", "zstd"), "zstd, gzip").Header().Get("Content-Encoding"))
	require.Empty(t, get(plugin("gzip"), "zstd").Header().Get("Content-Encoding"))
	require.Empty(t, get(plugin(), "zstd, gzip").Header().Get("Content-Encoding"))
}

func TestCompressionOption(t *testing.T) {
	for list, msg := range map[string]string{"br": `"br" is not zstd or gzip`, "gzip,gzip": `"gzip" is listed twice`} {
		h := valid(&Hostdash{DefaultPage: "Other", Compression: strings.Split(list, ",")})
		require.ErrorContains(t, h.validate(), msg)
	}
}

// TestPageETag: a file of the page has an ETag of its content, and a load
// that already has the file gets 304 without the body.
func TestPageETag(t *testing.T) {
	h := newPlugin(t)
	require.NoError(t, h.Init())
	t.Cleanup(func() { require.NoError(t, h.Close()) })
	for _, path := range []string{"/", "/app.js", "/vendor/uPlot.iife.min.js"} {
		rec := httptest.NewRecorder()
		h.server.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		require.Equal(t, http.StatusOK, rec.Code, path)
		tag := rec.Header().Get("ETag")
		require.NotEmpty(t, tag, path)
		require.Equal(t, "no-cache", rec.Header().Get("Cache-Control"), path)

		for _, accept := range []string{"", "zstd"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("If-None-Match", tag)
			if accept != "" {
				req.Header.Set("Accept-Encoding", accept)
			}
			again := httptest.NewRecorder()
			h.server.Handler.ServeHTTP(again, req)
			require.Equal(t, http.StatusNotModified, again.Code, path+" "+accept)
			require.Zero(t, again.Body.Len(), path)
		}
	}
}
