package hostdash

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The statuses, from the best to the worst. A section shows the worst one it
// has, a tab the worst of its sections (README, "Statuses and the Overview tab").
var statusOrder = []string{"ok", "warn", "bad", "errors", "no data"}

func worse(a, b string) string {
	if slices.Index(statusOrder, b) > slices.Index(statusOrder, a) {
		return b
	}
	return a
}

// sectionStatus is the status of one section of the page, as the Overview
// lists it under its tab: the same title, the same order and the same id as
// the section on the tab.
type sectionStatus struct {
	ID          string   `json:"id"` // page/measurement, as the id of the section in the layout
	Page        string   `json:"page"`
	Title       string   `json:"title"`
	Measurement string   `json:"measurement"`
	Input       string   `json:"input"`
	Status      string   `json:"status"`
	Reasons     []string `json:"reasons,omitempty"`
	order       int
}

// sectionStatuses gives the status of every section in the config and of
// every measurement without one that has data, in the order of the tabs
// (the config first, then the others by name, as the layout). "no data" and
// "errors" belong to the input of the section: Telegraf counts them per
// input, and an input writes all its measurements in one gather. A check
// belongs to the section of its measurement. The caller holds the lock of
// the store the groups belong to.
func sectionStatuses(byMeasurement map[string][]*group, p *pageConfig) []sectionStatus {
	out := make([]sectionStatus, 0, len(p.sections)+len(byMeasurement))
	for i := range p.sections {
		c := &p.sections[i]
		page := cmp.Or(c.Page, p.defaultPage)
		out = append(out, sectionStatus{ID: page + "/" + c.Measurement, Page: page, Title: cmp.Or(c.Title, c.Measurement),
			Measurement: c.Measurement, Input: c.inputName(), order: i})
	}
	for m := range byMeasurement {
		if p.byM[m] == nil {
			out = append(out, sectionStatus{ID: p.defaultPage + "/" + m, Page: p.defaultPage, Title: m, Measurement: m, Input: m, order: unconfiguredOrder})
		}
	}
	slices.SortFunc(out, func(a, b sectionStatus) int {
		if a.order != b.order {
			return a.order - b.order
		}
		if naturalLess(a.ID, b.ID) {
			return -1
		}
		return 1
	})

	// The status of each input: no data when none of its measurements has a
	// point in the window (a group without any value for a whole window is
	// gone, so a measurement with groups has data); errors when Telegraf's
	// count of its failed gathers grew.
	hasData := make(map[string]bool)
	for i := range out {
		if len(byMeasurement[out[i].Measurement]) > 0 {
			hasData[out[i].Input] = true
		}
	}
	errs := make(map[string][]string)
	gathered := make(map[string]bool) // the inputs internal_gather counts
	for _, g := range byMeasurement["internal_gather"] {
		name := g.tags["input"]
		gathered[name] = true
		for _, field := range []string{"gather_errors", "startup_errors"} {
			if s := g.series[field]; s != nil && grew(s) {
				errs[name] = append(errs[name], field+" grew")
			}
		}
	}

	for i := range out {
		sec := &out[i]
		sec.Status = "ok"
		if !hasData[sec.Input] {
			sec.Status = "no data"
			sec.Reasons = append(sec.Reasons, "no point of "+sec.Input+" in the window")
		}
		if e := errs[sec.Input]; len(e) > 0 {
			sec.Status = worse(sec.Status, "errors")
			for _, r := range e {
				sec.Reasons = append(sec.Reasons, sec.Input+": "+r)
			}
		}
		// The errors of a section come from internal_gather by the name of its
		// input: a section whose input it never counts (a typo in input) could
		// never show them.
		if len(gathered) > 0 && sec.order != unconfiguredOrder && !gathered[sec.Input] {
			sec.Status = worse(sec.Status, "warn")
			sec.Reasons = append(sec.Reasons, "input "+sec.Input+" not in internal_gather")
		}
		for _, c := range p.checks[sec.Measurement] {
			if level, reason := c.evaluate(byMeasurement[sec.Measurement]); level != "ok" {
				sec.Status = worse(sec.Status, level)
				sec.Reasons = append(sec.Reasons, reason)
			}
		}
	}
	return out
}

// statusOut is the reply of /api/status.
type statusOut struct {
	Title    string          `json:"title"`
	Series   int             `json:"series"`
	Silent   bool            `json:"silent"`
	Version  int             `json:"version"` // as in the layout: a new one means a new layout
	Start    int64           `json:"start"`
	Statuses []sectionStatus `json:"statuses"`
}

// status is what /api/status answers: the counts and the statuses of the
// sections, without the panels of the layout.
func (st *store) status(p *pageConfig, now time.Time) statusOut {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return statusOut{
		Title:    p.title,
		Series:   st.nseries,
		Silent:   st.silent(now),
		Version:  st.version,
		Start:    st.start,
		Statuses: sectionStatuses(st.byMeasurement(), p),
	}
}

// grew tells whether a count went up within the window: a counter keeps its
// rate, so any rate above 0; a plain value, its last above its first.
func grew(s *series) bool {
	v := s.points.v[s.points.lo:]
	if s.kind == counter {
		return slices.ContainsFunc(v, func(x float64) bool { return x > 0 })
	}
	return len(v) > 1 && v[len(v)-1] > v[0]
}

// evaluate compares the latest values of the check's field, combined over the
// groups, with the thresholds. "ok" when nothing crossed one or there is no
// value; else the level and the reason, such as "disk.used_percent max 91.2 ≥ 80".
func (c *checkConfig) evaluate(groups []*group) (level, reason string) {
	_, field, _ := strings.Cut(c.Field, ".")
	_, of, _ := strings.Cut(c.Of, ".")
	vals := make([]float64, 0, len(groups))
	for _, g := range groups {
		v, ok := latest(g.series[field])
		if !ok {
			continue
		}
		if of != "" {
			base, ok := latest(g.series[of])
			if !ok || base == 0 {
				continue
			}
			v /= base
		}
		vals = append(vals, v)
	}
	if len(vals) == 0 {
		return "ok", ""
	}
	// The default is the worst group: the highest value, or the lowest one
	// when a lower value is worse.
	agg := c.Agg
	if agg == "" {
		agg = "max"
		if c.Below {
			agg = "min"
		}
	}
	var v float64
	switch agg {
	case "min":
		v = slices.Min(vals)
	case "sum", "avg":
		for _, x := range vals {
			v += x
		}
		if agg == "avg" {
			v /= float64(len(vals))
		}
	default:
		v = slices.Max(vals)
	}
	crossed := func(t *float64) bool {
		if t == nil {
			return false
		}
		if c.Below {
			return v < *t
		}
		return v >= *t
	}
	name, op := c.Field, "≥"
	if c.Of != "" {
		name += "/" + of
	}
	if c.Below {
		op = "<"
	}
	num := func(x float64) string { return strconv.FormatFloat(x, 'g', 4, 64) }
	switch {
	case crossed(c.Bad):
		return "bad", fmt.Sprintf("%s %s %s %s %s", name, agg, num(v), op, num(*c.Bad))
	case crossed(c.Warn):
		return "warn", fmt.Sprintf("%s %s %s %s %s", name, agg, num(v), op, num(*c.Warn))
	}
	return "ok", ""
}

// latest is the newest stored value of a number series.
func latest(s *series) (float64, bool) {
	if s == nil || s.kind == text {
		return 0, false
	}
	_, v, ok := s.points.last()
	return v, ok
}
