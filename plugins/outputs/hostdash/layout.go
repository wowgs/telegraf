package hostdash

import (
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// The layout tells the page what exists and how to show it. A section lists
// its groups (tag sets) with the series id of each field; tiles and charts
// name fields. The page applies the tag filter and grouping and builds the
// lines itself, then fetches points from /api/series by measurement. Every
// section of the config is in it, also one without data yet.
type layout struct {
	Title       string          `json:"title"`
	WindowMs    int64           `json:"windowMs"`
	Version     int             `json:"version"`
	Start       int64           `json:"start"` // when this process started, unix ms; series ids hold only within it
	Series      int             `json:"series"`
	Silent      bool            `json:"silent"`      // Telegraf wrote nothing for a while
	TipLines    int             `json:"tipLines"`    // lines in the hover popup at most
	ChartLines  int             `json:"chartLines"`  // lines a chart draws at most
	StatusOrder []string        `json:"statusOrder"` // the statuses from the best to the worst
	Tabs        []tabOut        `json:"tabs"`
	Statuses    []sectionStatus `json:"statuses"` // of the sections, in the order of the tabs; the overview shows them under the tabs
}

type tabOut struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	Sections []sectionOut `json:"sections"`
	order    int
}

type sectionOut struct {
	ID          string            `json:"id"`
	Page        string            `json:"page"`
	Title       string            `json:"title"`
	Measurement string            `json:"measurement"`
	Note        []part            `json:"note,omitempty"`
	Group       *grouping         `json:"group,omitempty"` // the grouping the page opens with
	Agg         string            `json:"agg,omitempty"`   // its function; empty: the page picks by the unit
	Groups      []groupOut        `json:"groups,omitempty"`
	Units       map[string]string `json:"units,omitempty"` // field → unit as shown (a counter's unit per second)
	Text        []string          `json:"text,omitempty"`  // fields with text values
	Tiles       []tileOut         `json:"tiles,omitempty"`
	Charts      []chartOut        `json:"charts,omitempty"`
	Auto        bool              `json:"auto,omitempty"`  // no section in the config: charts made from the fields, collapsed at first
	Empty       bool              `json:"empty,omitempty"` // a section of the config with no data yet
	order       int
}

// grouping is a grouping of series into lines, as in PromQL: by keeps Tags
// and combines over the other tags (no tags: one line), without combines
// over Tags. Tags is never null in JSON, so an empty by stays.
type grouping struct {
	Mode string   `json:"mode"`
	Tags []string `json:"tags"`
}

type groupOut struct {
	Tags   map[string]string `json:"tags"`
	Series map[string]int    `json:"series"` // field → series id
}

// part is a piece of a text template: literal words, the latest value of a field, or a tag.
type part struct {
	Text  string `json:"s,omitempty"`
	Field string `json:"f,omitempty"`
	Tag   string `json:"tag,omitempty"`
}

type tileOut struct {
	Title string   `json:"title"`
	Field string   `json:"field"`
	Agg   string   `json:"agg,omitempty"`
	Sub   []part   `json:"sub,omitempty"`
	Warn  *float64 `json:"warn,omitempty"`
	Bad   *float64 `json:"bad,omitempty"`
	Of    string   `json:"of,omitempty"`
	Below bool     `json:"below,omitempty"`
}

type chartOut struct {
	Title    string   `json:"title"`
	Hint     string   `json:"hint,omitempty"`
	Fields   []string `json:"fields"`
	Labels   []string `json:"labels,omitempty"`
	Unit     string   `json:"unit,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	MaxField string   `json:"maxField,omitempty"`
	MinMax   *float64 `json:"minMax,omitempty"`
	Stacked  bool     `json:"stacked,omitempty"`
	Refs     []refOut `json:"refs,omitempty"`
}

type refOut struct {
	Label string   `json:"label"`
	Field string   `json:"field,omitempty"`
	Value *float64 `json:"value,omitempty"`
}

// Sections without a config entry come after the configured ones.
const unconfiguredOrder = 1 << 20

func (st *store) layout(p *pageConfig, now time.Time) layout {
	st.mu.RLock()
	defer st.mu.RUnlock()

	// A section is the groups of one measurement; its tab is the page of its
	// config, else the default page. A section of the config without data
	// is there too, empty.
	byMeasurement := st.byMeasurement()
	tabs := make(map[string]*tabOut)
	add := func(measurement string, groups []*group) {
		sort.Slice(groups, func(i, j int) bool { return naturalLess(groups[i].key, groups[j].key) })
		cfg, order := p.section(measurement)
		page := p.page(measurement)
		sec := buildSection(measurement, groups, cfg, p.shown(measurement))
		sec.order, sec.Page, sec.ID, sec.Empty = order, page, page+"/"+measurement, len(groups) == 0
		t := tabs[page]
		if t == nil {
			t = &tabOut{ID: page, Title: page, order: order}
			tabs[page] = t
		}
		t.order = min(t.order, order)
		t.Sections = append(t.Sections, sec)
	}
	for _, s := range p.sections {
		add(s.Measurement, byMeasurement[s.Measurement])
	}
	for m, groups := range byMeasurement {
		if p.byM[m] == nil {
			add(m, groups)
		}
	}

	out := layout{
		Title:       p.title,
		WindowMs:    st.window.Milliseconds(),
		Version:     st.version,
		Start:       st.start,
		Series:      st.nseries,
		Silent:      st.silent(now),
		StatusOrder: statusOrder,
	}
	sortSections := func(s []sectionOut) {
		sort.Slice(s, func(i, j int) bool {
			if s[i].order != s[j].order {
				return s[i].order < s[j].order
			}
			return naturalLess(s[i].ID, s[j].ID)
		})
	}

	// The overview shows the statuses of the sections under the other tabs.
	out.Tabs = append(out.Tabs, tabOut{ID: overviewTab, Title: "Overview"})
	out.Statuses = sectionStatuses(byMeasurement, p)

	rest := make([]*tabOut, 0, len(tabs))
	for _, t := range tabs {
		sortSections(t.Sections)
		rest = append(rest, t)
	}
	sort.Slice(rest, func(i, j int) bool {
		if rest[i].order != rest[j].order {
			return rest[i].order < rest[j].order
		}
		return naturalLess(rest[i].ID, rest[j].ID)
	})
	for _, t := range rest {
		out.Tabs = append(out.Tabs, *t)
	}
	return out
}

// byMeasurement is the groups of each measurement. The caller holds the lock.
func (st *store) byMeasurement() map[string][]*group {
	out := make(map[string][]*group, len(st.byM))
	for m, groups := range st.byM {
		list := make([]*group, 0, len(groups))
		for _, g := range groups {
			list = append(list, g)
		}
		out[m] = list
	}
	return out
}

// silent tells whether Telegraf wrote nothing for a while. The caller holds the lock.
func (st *store) silent(now time.Time) bool {
	return st.lastWrite.IsZero() || now.Sub(st.lastWrite) > silentAfter
}

// shownFields is the fields a section shows: those of its panels. nil
// without a config: all of them.
func shownFields(cfg *sectionConfig) map[string]bool {
	if cfg == nil {
		return nil
	}
	shown := make(map[string]bool)
	add := func(names ...string) {
		for _, n := range names {
			if n != "" {
				shown[n] = true
			}
		}
	}
	for _, p := range expand(cfg.Note) {
		add(p.Field)
	}
	for _, t := range cfg.Tiles {
		add(t.Field, t.Of)
		for _, p := range expand(t.Sub) {
			add(p.Field)
		}
	}
	for _, c := range cfg.Charts {
		add(c.Fields...)
		add(c.MaxField)
		for _, r := range c.Refs {
			add(r.Field)
		}
	}
	return shown
}

func buildSection(measurement string, groups []*group, cfg *sectionConfig, shown map[string]bool) sectionOut {
	sec := sectionOut{Title: measurement, Measurement: measurement, Units: make(map[string]string)}
	if cfg != nil && cfg.Title != "" {
		sec.Title = cfg.Title
	}

	for _, g := range groups {
		og := groupOut{Tags: g.tags, Series: make(map[string]int)}
		for name, s := range g.series {
			if shown != nil && !shown[name] {
				continue
			}
			og.Series[name] = s.id
			u := s.unit
			switch s.kind {
			case counter:
				u = rateUnit(u)
			case text:
				if !slices.Contains(sec.Text, name) {
					sec.Text = append(sec.Text, name)
				}
			}
			if u != "" {
				sec.Units[name] = u
			}
		}
		if len(og.Series) > 0 {
			sec.Groups = append(sec.Groups, og)
		}
	}
	sort.Strings(sec.Text)

	if cfg == nil {
		// No section in the configuration: a chart for each number field and
		// a tile for each text field, drawn like any other section.
		sec.Auto = true
		names := make(map[string]bool)
		for _, g := range sec.Groups {
			for name := range g.Series {
				names[name] = true
			}
		}
		fields := make([]string, 0, len(names))
		for name := range names {
			fields = append(fields, name)
		}
		sort.Slice(fields, func(i, j int) bool { return naturalLess(fields[i], fields[j]) })
		for _, name := range fields {
			if slices.Contains(sec.Text, name) {
				sec.Tiles = append(sec.Tiles, tileOut{Title: name, Field: name})
				continue
			}
			sec.Charts = append(sec.Charts, chartOut{Title: name, Fields: []string{name}, Unit: sec.Units[name]})
		}
		return sec
	}
	sec.Note = expand(cfg.Note)
	sec.Group, sec.Agg = cfg.grouping(), cfg.Agg
	for _, tc := range cfg.Tiles {
		t := tileOut{Title: tc.Title, Field: tc.Field, Agg: tc.Agg, Sub: expand(tc.Sub),
			Warn: tc.Warn, Bad: tc.Bad, Of: tc.Of, Below: tc.Below}
		if t.Title == "" {
			t.Title = tc.Field
		}
		sec.Tiles = append(sec.Tiles, t)
	}
	for _, cc := range cfg.Charts {
		c := chartOut{Title: cc.Title, Hint: cc.Hint, Fields: cc.Fields, Labels: cc.Labels, Unit: cc.Unit,
			Min: cc.Min, Max: cc.Max, MaxField: cc.MaxField, MinMax: cc.MinMax, Stacked: cc.Stacked}
		if c.Title == "" {
			c.Title = strings.Join(cc.Fields, ", ")
		}
		if c.Unit == "" {
			c.Unit = sec.Units[cc.Fields[0]]
		}
		for _, r := range cc.Refs {
			c.Refs = append(c.Refs, refOut(r))
		}
		sec.Charts = append(sec.Charts, c)
	}
	return sec
}

// rateUnit is the unit a counter is shown in.
func rateUnit(u string) string {
	switch u {
	case "", "count":
		return "1/s"
	default:
		return u + "/s"
	}
}

// naturalLess compares strings so that digit runs compare as numbers: cpu=2 < cpu=10.
// Strings that compare equal that way (x=01 and x=1) fall back to plain
// order, so the order never depends on the order of the input.
func naturalLess(a, b string) bool {
	if less, equal := naturalCompare(a, b); !equal {
		return less
	}
	return a < b
}

func naturalCompare(a, b string) (less, equal bool) {
	for a != "" && b != "" {
		da, db := digits(a), digits(b)
		if da > 0 && db > 0 {
			na, nb := strings.TrimLeft(a[:da], "0"), strings.TrimLeft(b[:db], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb), false
			}
			if na != nb {
				return na < nb, false
			}
			a, b = a[da:], b[db:]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0], false
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b), len(a) == len(b)
}

func digits(s string) int {
	n := 0
	for n < len(s) && s[n] >= '0' && s[n] <= '9' {
		n++
	}
	return n
}

var placeholder = regexp.MustCompile(`\{([^{}]+)\}`)

// expand splits a template into parts: "{name}" is the latest value of field
// name, "{tag:name}" is the value of tag name.
func expand(tmpl string) []part {
	if tmpl == "" {
		return nil
	}
	var out []part
	last := 0
	for _, m := range placeholder.FindAllStringSubmatchIndex(tmpl, -1) {
		if m[0] > last {
			out = append(out, part{Text: tmpl[last:m[0]]})
		}
		name := tmpl[m[2]:m[3]]
		if tag, ok := strings.CutPrefix(name, "tag:"); ok {
			out = append(out, part{Tag: tag})
		} else {
			out = append(out, part{Field: name})
		}
		last = m[1]
	}
	if last < len(tmpl) {
		out = append(out, part{Text: tmpl[last:]})
	}
	return out
}
