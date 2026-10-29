package hostdash

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/metric"
	"github.com/influxdata/telegraf/plugins/outputs"
	"github.com/influxdata/telegraf/testutil"
)

// newPlugin is the plugin with its defaults, on a free port of this host,
// before Init.
func newPlugin(t *testing.T) *Hostdash {
	t.Helper()
	h, ok := outputs.Outputs["hostdash"]().(*Hostdash)
	require.True(t, ok)
	h.Listen, h.Title, h.Log = "127.0.0.1:0", "box", testutil.Logger{}
	return h
}

// valid fills the options a test of validate does not care about with
// their defaults.
func valid(h *Hostdash) *Hostdash {
	if h.Listen == "" {
		h.Listen = "127.0.0.1:0"
	}
	if h.DefaultPage == "" {
		h.DefaultPage = "Other"
	}
	h.TipLines, h.ChartLines = max(h.TipLines, 1), max(h.ChartLines, 1)
	return h
}

// withStore runs the test on its own window instead of the package one.
func withStore(t *testing.T, st *store) {
	t.Helper()
	old := shared
	shared = st
	t.Cleanup(func() { shared = old })
}

// waiting is a plugin for the feed tests: a prepared page and a closing channel.
func waiting(t *testing.T) *Hostdash {
	t.Helper()
	h := newPlugin(t)
	h.page, h.closing, h.WakeDelay = testPage(nil, nil), make(chan struct{}), 0
	return h
}

func writeNow(st *store, v float64) {
	at := time.Now()
	st.add([]telegraf.Metric{metric.New("g", nil, map[string]any{"v": v}, at)}, at)
}

// TestFeedWaits: a request for changes is answered at once when there are
// any, else at the next write, else when its wait runs out; a request whose
// asker went away is not answered.
func TestFeedWaits(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	writeNow(st, 1)
	seq := st.seq

	// New to the asker: at once, even with a wait.
	start := time.Now()
	d, ok := h.feed(context.Background(), []feedQuery{{"g", 0}}, seq, time.Minute)
	require.True(t, ok)
	require.Len(t, d.Series["g"].Series, 1)
	require.Less(t, time.Since(start), time.Second)
	require.NotNil(t, d.Statuses, "the statuses come with the changes")
	require.Equal(t, 1, d.Count)

	// Nothing new: it waits for the next write.
	got := make(chan seriesData)
	go func() {
		d, _ := h.feed(context.Background(), []feedQuery{{"g", seq}}, seq, 10*time.Second)
		got <- d
	}()
	select {
	case <-got:
		t.Fatal("answered before a write")
	case <-time.After(200 * time.Millisecond):
	}
	writeNow(st, 2)
	select {
	case d := <-got:
		require.Equal(t, seq+1, d.Seq)
		require.Equal(t, []float64{2}, d.Series["g"].Series[st.groups["g"].series["v"].id].V)
	case <-time.After(5 * time.Second):
		t.Fatal("no answer after the write")
	}

	// No write within the wait: the answer comes when it runs out, empty.
	start = time.Now()
	d, ok = h.feed(context.Background(), []feedQuery{{"g", st.seq}}, st.seq, 300*time.Millisecond)
	require.True(t, ok)
	require.Empty(t, d.Series)
	require.GreaterOrEqual(t, time.Since(start), 300*time.Millisecond)
	require.NotNil(t, d.Statuses)

	// The asker went away: no answer.
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, ok = h.feed(ctx, []feedQuery{{"g", st.seq}}, st.seq, 10*time.Second)
	require.False(t, ok)
}

// TestFeedWithoutMeasurements: the Overview asks for no measurement and
// waits for a write after its seq; a write it has not seen answers at once.
func TestFeedWithoutMeasurements(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	writeNow(st, 1)
	start := time.Now()
	d, ok := h.feed(context.Background(), nil, st.seq-1, 10*time.Second)
	require.True(t, ok)
	require.Equal(t, st.seq, d.Seq)
	require.Less(t, time.Since(start), time.Second, "a write after its seq: at once")
}

// TestFeedFromAnOlderProcess: a page of an older process names a seq this
// process has not reached; it is answered at once, and sees the new start.
func TestFeedFromAnOlderProcess(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	writeNow(st, 1)
	start := time.Now()
	d, ok := h.feed(context.Background(), []feedQuery{{"g", 5000}}, 5000, 10*time.Second)
	require.True(t, ok)
	require.Equal(t, st.start, d.Start)
	require.Less(t, time.Since(start), time.Second)
}

// TestFeedWaitIsCut: a longer wait than maxWait is cut to it.
func TestFeedWaitIsCut(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	writeNow(st, 1)
	old := maxWait
	maxWait = 300 * time.Millisecond
	t.Cleanup(func() { maxWait = old })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	_, ok := h.feed(ctx, []feedQuery{{"g", st.seq}}, st.seq, time.Hour)
	require.True(t, ok, "answered by its own wait, before the test gave up")
	require.Less(t, time.Since(start), 2*time.Second)
}

// TestFeedTimeoutRecomputesStatuses: the reply after a wait without writes
// has statuses made then, not the ones of the last write: "silent" and "no
// data" depend on the clock.
func TestFeedTimeoutRecomputesStatuses(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	writeNow(st, 1)
	h.statuses(st.seq, false)
	h.statusList = []sectionStatus{{ID: "stale"}} // as if made at the last write
	d, _ := h.feed(context.Background(), []feedQuery{{"g", st.seq}}, st.seq, 50*time.Millisecond)
	require.NotEqual(t, "stale", d.Statuses[0].ID)
}

// TestFeedSettles: a request woken by a write waits for wake_delay of quiet,
// so that a gather that came in two writes arrives in one reply.
func TestFeedSettles(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := waiting(t)
	h.WakeDelay = config.Duration(200 * time.Millisecond)
	at := time.Now()
	st.add([]telegraf.Metric{metric.New("g", map[string]string{"n": "a"}, map[string]any{"v": 1.0}, at)}, at)
	seq := st.seq
	got := make(chan seriesData)
	go func() {
		d, _ := h.feed(context.Background(), []feedQuery{{"g", seq}}, seq, 10*time.Second)
		got <- d
	}()
	time.Sleep(50 * time.Millisecond)
	at = at.Add(10 * time.Second)
	st.add([]telegraf.Metric{metric.New("g", map[string]string{"n": "a"}, map[string]any{"v": 2.0}, at)}, at)
	time.Sleep(50 * time.Millisecond)
	st.add([]telegraf.Metric{metric.New("g", map[string]string{"n": "b"}, map[string]any{"v": 3.0}, at)}, at)
	select {
	case d := <-got:
		require.Len(t, d.Series["g"].Series, 2, "both parts of the gather")
	case <-time.After(5 * time.Second):
		t.Fatal("no answer")
	}
}

// TestCloseAnswersWaitingRequests: Close does not wait for a request that
// waits for changes: it answers at once, and Close returns without error.
func TestCloseAnswersWaitingRequests(t *testing.T) {
	st := testStore(mustFields(t, nil, nil, nil))
	withStore(t, st)
	h := newPlugin(t)
	require.NoError(t, h.Init())
	require.NoError(t, h.Connect())
	writeNow(st, 1)
	addr := h.listener.Addr().String()

	done := make(chan int)
	go func() {
		resp, err := http.Get(fmt.Sprintf("http://%s/api/series?m=g:%d&after=%d&wait=25", addr, st.seq, st.seq))
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	time.Sleep(200 * time.Millisecond)
	start := time.Now()
	require.NoError(t, h.Close())
	require.Less(t, time.Since(start), time.Second)
	require.Equal(t, http.StatusOK, <-done)
}

// TestLifecycle: Init, Connect, Write and Close on a real port; a second
// instance is refused; a reload keeps the window and gives a new version.
func TestLifecycle(t *testing.T) {
	withStore(t, newStore())
	h := newPlugin(t)
	h.Units = map[string]string{"g.v": "B"}
	require.NoError(t, h.Init())
	require.NoError(t, h.Connect())
	at := time.Now()
	require.NoError(t, h.Write([]telegraf.Metric{metric.New("g", nil, map[string]any{"v": 1.0}, at)}))

	second := newPlugin(t)
	require.ErrorContains(t, second.Init(), "a second [[outputs.hostdash]]")

	get := func(h *Hostdash, path string) layout {
		resp, err := http.Get("http://" + h.listener.Addr().String() + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		var l layout
		require.NoError(t, json.Unmarshal(body, &l))
		return l
	}
	before := get(h, "/api/layout")
	require.Equal(t, "B", before.Tabs[1].Sections[0].Units["v"])
	require.NoError(t, h.Close())

	// The reload: a new instance with other units over the same window.
	next := newPlugin(t)
	next.Units = map[string]string{"g.v": "KiB"}
	require.NoError(t, next.Init())
	require.NoError(t, next.Connect())
	t.Cleanup(func() { require.NoError(t, next.Close()) })
	after := get(next, "/api/layout")
	require.Equal(t, "KiB", after.Tabs[1].Sections[0].Units["v"])
	require.Greater(t, after.Version, before.Version, "a reload is a new layout for open pages")
	require.Equal(t, before.Start, after.Start, "the same window")
	require.Equal(t, 1, after.Series)
}

// TestConfigIsChecked: what the plugin refuses before it starts.
func TestConfigIsChecked(t *testing.T) {
	for msg, change := range map[string]func(h *Hostdash){
		"has no address":               func(h *Hostdash) { h.Listen = ":9000" },
		"default_page is empty":        func(h *Hostdash) { h.DefaultPage = "" },
		"chart_lines must be positive": func(h *Hostdash) { h.ChartLines = 0 },
		"wake_delay must not be negative": func(h *Hostdash) {
			h.WakeDelay = config.Duration(-time.Second)
		},
		"set field or value, one of them": func(h *Hostdash) {
			h.Sections = []sectionConfig{{Measurement: "m", Charts: []chartConfig{{Fields: []string{"a"}, Refs: []refConfig{{Label: "x"}}}}}}
		},
	} {
		h := newPlugin(t)
		change(h)
		require.ErrorContains(t, h.validate(), msg)
	}
	require.True(t, strings.HasPrefix(newPlugin(t).Listen, "127.0.0.1"))
}
