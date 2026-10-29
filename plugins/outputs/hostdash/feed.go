package hostdash

import (
	"context"
	"slices"
	"time"
)

// The change feed of /api/series: a page asks for the changes of whole
// measurements since a write it names (store.seq), not for each series with
// a time of its own, so a request grows with the sections on screen and not
// with their series.

// feedQuery asks for the changes of one measurement after write since; since
// 0 asks for all of it.
type feedQuery struct {
	measurement string
	since       uint32
}

// seriesData is the reply of /api/series: the changes of each asked
// measurement, and the statuses, the series count and silent, which change
// with the writes too.
type seriesData struct {
	Now      int64                         `json:"now"`
	Version  int                           `json:"version"`
	Start    int64                         `json:"start"` // as in the layout
	Seq      uint32                        `json:"seq"`   // the latest write: the next request asks from it
	Series   map[string]measurementChanges `json:"series"`
	Count    int                           `json:"count"` // series in the store
	Silent   bool                          `json:"silent"`
	Statuses []sectionStatus               `json:"statuses"`
}

// measurementChanges are the changed series of one measurement, by id. When
// all of them carry the same times, T holds them once and the series only
// their values: the series of one measurement come from one gather.
type measurementChanges struct {
	T      []int64              `json:"t,omitempty"`
	Series map[int]seriesChange `json:"s"`
}

// seriesChange is what changed in one series. T holds the time of the first
// point sent (unix ms) and then the step from each point to the next: a step
// is a short number, while a time has 13 digits; it is left out when the
// measurement carries it. V holds the values. Full is true when the points
// are the whole window and replace what the page has: the series is new to
// the page or started again.
type seriesChange struct {
	T    []int64   `json:"t,omitempty"`
	V    []float64 `json:"v,omitempty"`
	Text *string   `json:"text,omitempty"`
	Full bool      `json:"full,omitempty"`
}

// query returns the changes of the asked measurements after their writes,
// for the series their sections show, and the channel the next write closes.
func (st *store) query(asked []feedQuery, p *pageConfig, now time.Time) (seriesData, <-chan struct{}) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	out := seriesData{Now: now.UnixMilli(), Version: st.version, Start: st.start, Seq: st.seq,
		Series: make(map[string]measurementChanges), Count: st.nseries, Silent: st.silent(now)}
	for _, q := range asked {
		groups := st.byM[q.measurement]
		if len(groups) == 0 {
			continue
		}
		shown := p.shown(q.measurement)
		changes := make(map[int]seriesChange)
		for _, g := range groups {
			for name, s := range g.series {
				if shown != nil && !shown[name] {
					continue
				}
				if c, ok := s.changeSince(q.since); ok {
					changes[s.id] = c
				}
			}
		}
		if len(changes) > 0 {
			out.Series[q.measurement] = shareTimes(changes)
		}
	}
	return out, st.written
}

// shareTimes moves the times to the measurement when every number series
// in the changes has the same ones.
func shareTimes(changes map[int]seriesChange) measurementChanges {
	var times []int64
	for _, c := range changes {
		if c.Text != nil {
			continue
		}
		if times == nil {
			times = c.T
		} else if !slices.Equal(times, c.T) {
			return measurementChanges{Series: changes}
		}
	}
	if len(times) == 0 {
		return measurementChanges{Series: changes}
	}
	for id, c := range changes {
		if c.Text == nil {
			c.T = nil
			changes[id] = c
		}
	}
	return measurementChanges{T: times, Series: changes}
}

// changeSince is what changed in the series after write seq. The caller
// holds the lock.
func (s *series) changeSince(seq uint32) (seriesChange, bool) {
	if s.kind == text {
		if s.textSeq <= seq {
			return seriesChange{}, false
		}
		text := s.text
		return seriesChange{Text: &text}, true
	}
	full := seq < s.created
	i := 0
	if !full {
		if i = s.points.from(seq); i == s.points.len() {
			return seriesChange{}, false
		}
	}
	n := s.points.len() - i
	c := seriesChange{Full: full, T: make([]int64, 0, n), V: make([]float64, 0, n)}
	prev := int64(0)
	for k := i; k < s.points.len(); k++ {
		t := s.points.at(k)
		c.T = append(c.T, t-prev)
		c.V = append(c.V, s.points.v[s.points.lo+k])
		prev = t
	}
	return c, true
}

// maxWait bounds how long /api/series holds a request for changes. It is
// shorter than the WriteTimeout of the plugin's server (30 s), which would
// cut the reply. A variable only for the tests.
var maxWait = 25 * time.Second

// maxSettle bounds how long a woken request waits for a quiet moment after
// a write (wake_delay), so that a burst of writes never holds it back.
const maxSettle = time.Second

// feed answers a request for changes: at once when an asked measurement has
// changes, when a write came after the asker's seq (after), when after is
// not a seq of this process (a page of an older process) or when it may not
// wait; else after the next write and wake_delay of quiet, or after wait
// with what there is, or at once when the plugin closes. ok is false when
// the asker went away.
func (h *Hostdash) feed(ctx context.Context, asked []feedQuery, after uint32, wait time.Duration) (d seriesData, ok bool) {
	wait = min(wait, maxWait)
	var timeout <-chan time.Time
	if wait > 0 {
		timer := time.NewTimer(wait)
		defer timer.Stop()
		timeout = timer.C
	}
	for {
		d, written := shared.query(asked, h.page, time.Now())
		if len(d.Series) > 0 || d.Seq != after || timeout == nil {
			d.Statuses = h.statuses(d.Seq, false)
			return d, true
		}
		select {
		case <-written:
			if !h.settle(ctx) {
				return d, false
			}
		case <-timeout:
			d, _ = shared.query(asked, h.page, time.Now())
			d.Statuses = h.statuses(d.Seq, true)
			return d, true
		case <-h.closing:
			d.Statuses = h.statuses(d.Seq, false)
			return d, true
		case <-ctx.Done():
			return d, false
		}
	}
}

// settle waits after a write until no other write came for wake_delay, at
// most maxSettle: one gather can reach the plugin in two writes, and a page
// woken by the first would draw the lines of a part of it. It is false when
// the asker went away.
func (h *Hostdash) settle(ctx context.Context) bool {
	delay := time.Duration(h.WakeDelay)
	if delay <= 0 {
		return true
	}
	deadline := time.NewTimer(maxSettle)
	defer deadline.Stop()
	for {
		quiet := time.NewTimer(delay)
		select {
		case <-shared.next():
			quiet.Stop()
		case <-quiet.C:
			return true
		case <-deadline.C:
			quiet.Stop()
			return true
		case <-h.closing:
			quiet.Stop()
			return true
		case <-ctx.Done():
			quiet.Stop()
			return false
		}
	}
}

// next is the channel the next write closes.
func (st *store) next() <-chan struct{} {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.written
}

// statuses are the statuses of the sections after write seq: computed once
// per write and shared by every request that waited for it. fresh computes
// them again: "silent" and "no data" also depend on the clock.
func (h *Hostdash) statuses(seq uint32, fresh bool) []sectionStatus {
	h.statusMu.Lock()
	defer h.statusMu.Unlock()
	if fresh || !h.statusValid || h.statusSeq != seq {
		h.statusList = shared.status(h.page, time.Now()).Statuses
		h.statusSeq, h.statusValid = seq, true
	}
	return h.statusList
}
