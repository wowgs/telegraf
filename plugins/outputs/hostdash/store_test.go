package hostdash

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/metric"
	"github.com/influxdata/telegraf/testutil"
)

// oneGroup returns the only group of the store.
func oneGroup(t *testing.T, st *store) *group {
	t.Helper()
	require.Len(t, st.groups, 1)
	for _, g := range st.groups {
		return g
	}
	return nil
}

func TestNaNAndInfAreNotStored(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("g", nil, map[string]any{"v": math.NaN(), "w": math.Inf(1)}, t0),
		metric.New("g", nil, map[string]any{"v": 1.0, "w": 2.0}, t0.Add(10*time.Second)),
	}, t0.Add(10*time.Second))
	g := oneGroup(t, st)
	require.Equal(t, 1, g.series["v"].points.len())
	require.Equal(t, 1, g.series["w"].points.len())

	// The reply encodes: one bad reading used to make it an empty 200.
	h := &Hostdash{Log: testutil.Logger{}, page: testPage(nil, nil)}
	old := shared
	defer func() { shared = old }()
	shared = st
	rec := httptest.NewRecorder()
	h.handleSeries(rec, httptest.NewRequest(http.MethodGet, "/api/series?m=g:0", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	var d seriesData
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &d))
	require.Len(t, d.Series["g"].Series, 2)
}

func TestMetricsFarAheadAreDropped(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	ahead := st.add([]telegraf.Metric{
		metric.New("g", nil, map[string]any{"v": 1.0}, t0),
		metric.New("g", nil, map[string]any{"v": 2.0}, t0.Add(24*time.Hour)),
		metric.New("g", nil, map[string]any{"v": 3.0}, t0.Add(10*time.Second)),
		metric.New("g", nil, map[string]any{"v": 4.0}, t0.Add(20*time.Second)),
	}, t0.Add(20*time.Second))
	require.Equal(t, 1, ahead)
	require.Equal(t, []pt{
		{t0.UnixMilli(), 1}, {t0.Add(10 * time.Second).UnixMilli(), 3}, {t0.Add(20 * time.Second).UnixMilli(), 4},
	}, pointsOf(oneGroup(t, st).series["v"]))
}

func TestOutOfOrderGaugeIsDropped(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("g", nil, map[string]any{"v": 1.0}, t0.Add(10*time.Second)),
		metric.New("g", nil, map[string]any{"v": 2.0}, t0),
		metric.New("g", nil, map[string]any{"v": 3.0}, t0.Add(10*time.Second)), // same time: replaces
	}, t0.Add(10*time.Second))
	require.Equal(t, []pt{{t0.Add(10 * time.Second).UnixMilli(), 3}}, pointsOf(oneGroup(t, st).series["v"]))
}

func TestCounterSameTimestampTwice(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, []string{"c.n"}))
	st.add([]telegraf.Metric{
		metric.New("c", nil, map[string]any{"n": 100.0}, t0),
		metric.New("c", nil, map[string]any{"n": 200.0}, t0.Add(10*time.Second)),
		metric.New("c", nil, map[string]any{"n": 999.0}, t0.Add(10*time.Second)), // the same reading again
		metric.New("c", nil, map[string]any{"n": 300.0}, t0.Add(20*time.Second)),
	}, t0.Add(20*time.Second))
	p := pointsOf(oneGroup(t, st).series["n"])
	require.Len(t, p, 2)
	require.InDelta(t, 10.0, p[0].v, 1e-9)
	require.InDelta(t, 10.0, p[1].v, 1e-9)
}

// TestSilent: the page says "silent" when Telegraf wrote nothing for silentAfter.
func TestSilent(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{metric.New("llama", nil, map[string]any{"a": 1.0}, t0)}, t0)
	l := st.layout(testPage(nil, nil), t0.Add(silentAfter-time.Second))
	require.False(t, l.Silent)
	l = st.layout(testPage(nil, nil), t0.Add(silentAfter+time.Second))
	require.True(t, l.Silent)
}

func TestReloadRebuildsSeriesWithNewRules(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{metric.New("net", nil, map[string]any{"bytes_recv": 1000.0}, t0)}, t0)
	s := oneGroup(t, st).series["bytes_recv"]
	require.Equal(t, gauge, s.kind)
	version := st.version

	st.configure(time.Hour, mustFields(t, nil, nil, []string{"net.bytes_*"}))
	require.Equal(t, counter, s.kind)
	require.Zero(t, s.points.len())
	require.Greater(t, st.version, version)
	st.add([]telegraf.Metric{metric.New("net", nil, map[string]any{"bytes_recv": 1000.0}, t0.Add(10*time.Second))}, t0)
	st.add([]telegraf.Metric{metric.New("net", nil, map[string]any{"bytes_recv": 3000.0}, t0.Add(20*time.Second))}, t0)
	require.Equal(t, []pt{{t0.Add(20 * time.Second).UnixMilli(), 200}}, pointsOf(s))

	// The same rules again keep the points; the layout is new all the same:
	// sections, titles or units may have changed.
	version = st.version
	st.configure(time.Hour, mustFields(t, nil, nil, []string{"net.bytes_*"}))
	require.Equal(t, 1, s.points.len())
	require.Equal(t, version+1, st.version)
}

func TestSweepTrimsAndRemovesSilentFields(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.configure(10*time.Second, mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"a": 1.0, "b": 1.0}, t0)}, t0)
	for i := 1; i <= 10; i++ {
		at := t0.Add(time.Duration(i) * 10 * time.Second)
		st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"a": 1.0}, at)}, at)
	}
	g := oneGroup(t, st)
	require.Contains(t, g.series, "a")
	require.NotContains(t, g.series, "b", "b got nothing for a whole window")
	require.Equal(t, 1, st.nseries)

	// The sweep runs at most once a minute.
	st.lastSweep = t0.Add(100 * time.Second)
	st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"c": 1.0}, t0.Add(110*time.Second))}, t0.Add(110*time.Second))
	st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"a": 1.0}, t0.Add(150*time.Second))}, t0.Add(150*time.Second))
	require.Contains(t, g.series, "c", "the sweep did not run yet")
}

func TestGroupKeysDoNotCollide(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	st.add([]telegraf.Metric{
		metric.New("m", map[string]string{"a": "1,b=2"}, map[string]any{"v": 1.0}, t0),
		metric.New("m", map[string]string{"a": "1", "b": "2"}, map[string]any{"v": 9.0}, t0),
	}, t0)
	require.Len(t, st.groups, 2)
}

func TestOverviewIsNoPage(t *testing.T) {
	h := valid(&Hostdash{DefaultPage: "overview"})
	require.ErrorContains(t, h.validate(), "overview tab")
	h = valid(&Hostdash{DefaultPage: "Other", Sections: []sectionConfig{{Measurement: "m", Page: "overview"}}})
	require.ErrorContains(t, h.validate(), "overview tab")
}

func TestParseFeedQuery(t *testing.T) {
	asked, err := parseFeedQuery([]string{"cpu:300", "a:b:7", "cpu:100", "mem:0"})
	require.NoError(t, err)
	require.Equal(t, []feedQuery{{"cpu", 100}, {"a:b", 7}, {"mem", 0}}, asked, "the earlier seq of a repeat; a name may hold a colon")

	for _, bad := range []string{"cpu", ":1", "cpu:x", "cpu:", "cpu:-1"} {
		_, err := parseFeedQuery([]string{bad})
		require.Error(t, err, bad)
	}
	_, err = parseFeedQuery(make([]string, maxMeasurements+1))
	require.ErrorContains(t, err, "at most")

	h := &Hostdash{Log: testutil.Logger{}}
	rec := httptest.NewRecorder()
	h.handleSeries(rec, httptest.NewRequest(http.MethodGet, "/api/series?m=cpu", nil))
	require.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestNaturalLessIsATotalOrder(t *testing.T) {
	require.True(t, naturalLess("x=01", "x=1"))
	require.False(t, naturalLess("x=1", "x=01"))
	require.False(t, naturalLess("x=1", "x=1"))
}

// TestHandlersWhileWriting runs the API next to writes; run with -race.
func TestHandlersWhileWriting(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	old := shared
	defer func() { shared = old }()
	shared = st
	h := &Hostdash{Log: testutil.Logger{}, DefaultPage: "Other", Title: "box", page: testPage(nil, nil)}

	var wg sync.WaitGroup
	wg.Go(func() {
		for i := range 300 {
			at := t0.Add(time.Duration(i) * time.Second)
			st.add([]telegraf.Metric{metric.New("g", map[string]string{"n": string(rune('a' + i%5))}, map[string]any{"v": float64(i)}, at)}, at)
		}
	})
	for range 3 {
		wg.Go(func() {
			for range 100 {
				rec := httptest.NewRecorder()
				h.handleSeries(rec, httptest.NewRequest(http.MethodGet, "/api/series?m=g:0&m=g:5&wait=0", nil))
				require.Equal(t, http.StatusOK, rec.Code)
				_ = st.layout(testPage(nil, nil), time.Now())
				_ = st.status(testPage(nil, nil), time.Now())
			}
		})
	}
	wg.Wait()
}
