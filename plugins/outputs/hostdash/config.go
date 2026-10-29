package hostdash

import (
	"cmp"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"

	"github.com/influxdata/telegraf/filter"
)

// sectionConfig is one [[outputs.hostdash.section]]: how one measurement looks.
type sectionConfig struct {
	Measurement string `toml:"measurement"`
	Title       string `toml:"title"`
	Page        string `toml:"page"`
	Input       string `toml:"input"` // the Telegraf input that writes the measurement; default: its name
	Note        string `toml:"note"`  // template, see expand
	// The grouping the page opens with, as in PromQL: group_by keeps these
	// tags and combines the series over the others ([] is one line),
	// group_without combines the series over these tags. One of them at most.
	GroupBy      []string      `toml:"group_by"`
	GroupWithout []string      `toml:"group_without"`
	Agg          string        `toml:"agg"` // how they combine; default: by the unit of the first field
	Tiles        []tileConfig  `toml:"tile"`
	Charts       []chartConfig `toml:"chart"`
}

type tileConfig struct {
	Field string   `toml:"field"`
	Title string   `toml:"title"`
	Sub   string   `toml:"sub"` // template, see expand
	Agg   string   `toml:"agg"` // across groups: "first" (default), "max" or "sum"
	Warn  *float64 `toml:"warn"`
	Bad   *float64 `toml:"bad"`
	Of    string   `toml:"of"`    // compare value/of with warn and bad instead of the value
	Below bool     `toml:"below"` // lower is worse
}

// checkConfig is one [[outputs.hostdash.check]]: thresholds on a field. Its
// result goes to the status of the input that writes the measurement.
type checkConfig struct {
	Field string   `toml:"field"` // measurement.field
	Agg   string   `toml:"agg"`   // over the latest values of all groups: max, min, avg or sum; default: the worst one
	Warn  *float64 `toml:"warn"`
	Bad   *float64 `toml:"bad"`
	Below bool     `toml:"below"` // a value below the threshold is worse
	Of    string   `toml:"of"`    // measurement.field of the same measurement: compare field/of
}

type chartConfig struct {
	Title    string      `toml:"title"`
	Hint     string      `toml:"hint"`
	Fields   []string    `toml:"fields"`
	Labels   []string    `toml:"labels"` // line labels, in the order of fields; default: the field names
	Unit     string      `toml:"unit"`   // default: the unit of the first field
	Min      *float64    `toml:"min"`
	Max      *float64    `toml:"max"`
	MaxField string      `toml:"max_field"`
	MinMax   *float64    `toml:"min_max"` // the axis goes at least this high
	Stacked  bool        `toml:"stacked"`
	Refs     []refConfig `toml:"ref"`
}

type refConfig struct {
	Label string   `toml:"label"`
	Field string   `toml:"field"`
	Value *float64 `toml:"value"`
}

// overviewTab is the id of the overview tab; no page may take it.
const overviewTab = "overview"

func (h *Hostdash) validate() error {
	host, _, err := net.SplitHostPort(h.Listen)
	if err != nil {
		return fmt.Errorf("listen %q: %w", h.Listen, err)
	}
	if host == "" {
		return fmt.Errorf("listen %q has no address: it would serve the page on every interface", h.Listen)
	}
	if h.DefaultPage == "" {
		return errors.New("default_page is empty")
	}
	if h.DefaultPage == overviewTab {
		return fmt.Errorf("default_page %q is the overview tab", overviewTab)
	}
	if h.TipLines <= 0 {
		return errors.New("tip_lines must be positive")
	}
	if h.ChartLines <= 0 {
		return errors.New("chart_lines must be positive")
	}
	if h.WakeDelay < 0 {
		return errors.New("wake_delay must not be negative")
	}
	for i, e := range h.Compression {
		if e != "zstd" && e != "gzip" {
			return fmt.Errorf("compression: %q is not zstd or gzip", e)
		}
		if slices.Contains(h.Compression[:i], e) {
			return fmt.Errorf("compression: %q is listed twice", e)
		}
	}
	seen := make(map[string]bool, len(h.Sections))
	inputPage := make(map[string]string, len(h.Sections)) // an input belongs to one tab
	for i, s := range h.Sections {
		if s.Measurement == "" {
			return fmt.Errorf("section %d: no measurement", i+1)
		}
		if seen[s.Measurement] {
			return fmt.Errorf("section %d: measurement %q has a section already", i+1, s.Measurement)
		}
		seen[s.Measurement] = true
		if s.Page == overviewTab {
			return fmt.Errorf("section %q: page %q is the overview tab", s.Measurement, overviewTab)
		}
		input, page := s.inputName(), cmp.Or(s.Page, h.DefaultPage)
		if p, ok := inputPage[input]; ok && p != page {
			return fmt.Errorf("section %q: input %q is on the tabs %q and %q; an input belongs to one tab", s.Measurement, input, p, page)
		}
		inputPage[input] = page
		switch s.Agg {
		case "", "avg", "min", "max", "sum", "band":
		default:
			return fmt.Errorf("section %q: agg must be avg, min, max, sum or band, not %q", s.Measurement, s.Agg)
		}
		if s.GroupBy != nil && s.GroupWithout != nil {
			return fmt.Errorf("section %q: group_by and group_without together; a grouping has one of them", s.Measurement)
		}
		if s.GroupWithout != nil && len(s.GroupWithout) == 0 {
			return fmt.Errorf("section %q: group_without lists no tag", s.Measurement)
		}
		if s.Agg != "" && s.grouping() == nil {
			return fmt.Errorf("section %q: agg needs group_by or group_without", s.Measurement)
		}
		if slices.Contains(s.GroupBy, "") || slices.Contains(s.GroupWithout, "") {
			return fmt.Errorf("section %q: an empty tag in group_by or group_without", s.Measurement)
		}
		for j, t := range s.Tiles {
			if t.Field == "" {
				return fmt.Errorf("section %q, tile %d: no field", s.Measurement, j+1)
			}
			if t.Agg != "" && t.Agg != "first" && t.Agg != "max" && t.Agg != "sum" {
				return fmt.Errorf("section %q, tile %d: agg must be first, max or sum, not %q", s.Measurement, j+1, t.Agg)
			}
		}
		for j, c := range s.Charts {
			if len(c.Fields) == 0 {
				return fmt.Errorf("section %q, chart %d: no fields", s.Measurement, j+1)
			}
			if len(c.Labels) > 0 && len(c.Labels) != len(c.Fields) {
				return fmt.Errorf("section %q, chart %d: %d labels for %d fields", s.Measurement, j+1, len(c.Labels), len(c.Fields))
			}
			if c.Max != nil && c.MaxField != "" {
				return fmt.Errorf("section %q, chart %d: set max or max_field, not both", s.Measurement, j+1)
			}
			for k, r := range c.Refs {
				if (r.Field == "") == (r.Value == nil) {
					return fmt.Errorf("section %q, chart %d, ref %d: set field or value, one of them", s.Measurement, j+1, k+1)
				}
			}
		}
	}
	for i, c := range h.Checks {
		m, f, ok := strings.Cut(c.Field, ".")
		if !ok || m == "" || f == "" {
			return fmt.Errorf("check %d: field %q is not measurement.field", i+1, c.Field)
		}
		switch c.Agg {
		case "", "max", "min", "avg", "sum":
		default:
			return fmt.Errorf("check %q: agg must be max, min, avg or sum, not %q", c.Field, c.Agg)
		}
		if c.Warn == nil && c.Bad == nil {
			return fmt.Errorf("check %q: no warn and no bad", c.Field)
		}
		if c.Of != "" {
			om, of, ok := strings.Cut(c.Of, ".")
			if !ok || om != m || of == "" {
				return fmt.Errorf("check %q: of %q is not a field of %q", c.Field, c.Of, m)
			}
		}
	}
	return nil
}

// grouping is how a section groups its series into lines when the page
// opens it: nil for no grouping (a line per series).
func (s *sectionConfig) grouping() *grouping {
	switch {
	case s.GroupBy != nil:
		return &grouping{Mode: "by", Tags: s.GroupBy}
	case s.GroupWithout != nil:
		return &grouping{Mode: "without", Tags: s.GroupWithout}
	}
	return nil
}

// inputName is the Telegraf input of the section's measurement.
func (s *sectionConfig) inputName() string {
	return cmp.Or(s.Input, s.Measurement)
}

// rule maps fields matching a pattern ("measurement.field", globs allowed) to a value.
type rule[T any] struct {
	pattern string
	exact   bool
	match   filter.Filter
	value   T
}

func compileRules[T any](m map[string]T) ([]rule[T], error) {
	out := make([]rule[T], 0, len(m))
	for pattern, v := range m {
		if !strings.Contains(pattern, ".") {
			return nil, fmt.Errorf("%q: a pattern is measurement.field", pattern)
		}
		f, err := filter.Compile([]string{pattern})
		if err != nil {
			return nil, fmt.Errorf("%q: %w", pattern, err)
		}
		out = append(out, rule[T]{pattern: pattern, exact: !strings.ContainsAny(pattern, "*?[]"), match: f, value: v})
	}
	return out, nil
}

// lookup returns the value of the best rule for measurement.field: an exact name
// first, then the longest matching pattern.
func lookup[T any](rules []rule[T], measurement, field string) (T, bool) {
	key := measurement + "." + field
	var best *rule[T]
	for i := range rules {
		r := &rules[i]
		if !r.match.Match(key) {
			continue
		}
		if best == nil || r.exact && !best.exact || r.exact == best.exact && len(r.pattern) > len(best.pattern) {
			best = r
		}
	}
	if best == nil {
		var zero T
		return zero, false
	}
	return best.value, true
}

// fields knows the unit, scale and kind of every field from the plugin config.
type fields struct {
	units    []rule[string]
	scales   []rule[float64]
	counters filter.Filter
}

func newFields(units map[string]string, scales map[string]float64, counters []string) (*fields, error) {
	f := &fields{}
	var err error
	if f.units, err = compileRules(units); err != nil {
		return nil, fmt.Errorf("units: %w", err)
	}
	if f.scales, err = compileRules(scales); err != nil {
		return nil, fmt.Errorf("scale: %w", err)
	}
	for _, c := range counters {
		if !strings.Contains(c, ".") {
			return nil, fmt.Errorf("counters: %q: a pattern is measurement.field", c)
		}
	}
	if len(counters) > 0 {
		if f.counters, err = filter.Compile(counters); err != nil {
			return nil, fmt.Errorf("counters: %w", err)
		}
	}
	return f, nil
}

func (f *fields) unit(measurement, field string) string {
	u, _ := lookup(f.units, measurement, field)
	return u
}

func (f *fields) spec(measurement, field string) fieldSpec {
	scale, ok := lookup(f.scales, measurement, field)
	if !ok {
		scale = 1
	}
	return fieldSpec{
		scale:   scale,
		counter: f.counters != nil && f.counters.Match(measurement+"."+field),
	}
}

// pageConfig is the configuration of the page, prepared once in Init: the
// section of each measurement with the fields it shows, and the checks of
// each measurement.
type pageConfig struct {
	title       string
	defaultPage string
	sections    []sectionConfig // in the order of the config
	byM         map[string]*sectionInfo
	checks      map[string][]*checkConfig // by measurement
}

type sectionInfo struct {
	cfg   *sectionConfig
	order int             // its place in the config
	shown map[string]bool // the fields of its panels
}

func (h *Hostdash) compile() *pageConfig {
	p := &pageConfig{
		title:       h.Title,
		defaultPage: h.DefaultPage,
		sections:    h.Sections,
		byM:         make(map[string]*sectionInfo, len(h.Sections)),
		checks:      make(map[string][]*checkConfig),
	}
	for i := range h.Sections {
		s := &h.Sections[i]
		p.byM[s.Measurement] = &sectionInfo{cfg: s, order: i, shown: shownFields(s)}
	}
	for i := range h.Checks {
		c := &h.Checks[i]
		m, _, _ := strings.Cut(c.Field, ".")
		p.checks[m] = append(p.checks[m], c)
	}
	return p
}

// section is the config of a measurement and its place in the config;
// nil and unconfiguredOrder without one.
func (p *pageConfig) section(measurement string) (*sectionConfig, int) {
	if s := p.byM[measurement]; s != nil {
		return s.cfg, s.order
	}
	return nil, unconfiguredOrder
}

// shown is the fields the page shows of a measurement: nil for all of them.
func (p *pageConfig) shown(measurement string) map[string]bool {
	if s := p.byM[measurement]; s != nil {
		return s.shown
	}
	return nil
}

// page is the tab of a measurement.
func (p *pageConfig) page(measurement string) string {
	if s := p.byM[measurement]; s != nil && s.cfg.Page != "" {
		return s.cfg.Page
	}
	return p.defaultPage
}
