package hostdash

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/influxdata/telegraf"
)

const (
	// A metric this far ahead of the host's clock is dropped: its time would
	// become the newest of its series and push every later point out.
	maxAhead = time.Minute
	// The page shows "silent" when Telegraf wrote nothing for this long.
	silentAfter = 30 * time.Second
)

type kind int

const (
	gauge kind = iota
	counter
	text
)

// points are the points of a series as three columns in one buffer with a
// start: t (unix ms, from the metric), v, and seq, the write that stored or
// last changed the point. seq never decreases along the points, so the
// points changed after a write are found by a binary search (feed.go).
// Trimming moves the start; a full buffer first moves its points to the
// front and grows only when it has no room left, so it holds about the window,
// not up to twice it.
type points struct {
	t   []int64
	v   []float64
	seq []uint32
	lo  int
}

func (p *points) len() int { return len(p.t) - p.lo }

// at is the time of point i, counted from the start.
func (p *points) at(i int) int64 { return p.t[p.lo+i] }

func (p *points) last() (t int64, v float64, ok bool) {
	if p.len() == 0 {
		return 0, 0, false
	}
	n := len(p.t) - 1
	return p.t[n], p.v[n], true
}

func (p *points) push(t int64, v float64, seq uint32) {
	if len(p.t) == cap(p.t) && p.lo > 0 {
		n := copy(p.t, p.t[p.lo:])
		copy(p.v, p.v[p.lo:])
		copy(p.seq, p.seq[p.lo:])
		p.t, p.v, p.seq, p.lo = p.t[:n], p.v[:n], p.seq[:n], 0
	}
	p.t = append(p.t, t)
	p.v = append(p.v, v)
	p.seq = append(p.seq, seq)
}

// setLast changes the value of the newest point in write seq.
func (p *points) setLast(v float64, seq uint32) {
	n := len(p.t) - 1
	p.v[n], p.seq[n] = v, seq
}

// trim drops the points older than cutoff. When the buffer then has much more
// room than points (after a long pause or a shorter window), they move to a
// small one.
func (p *points) trim(cutoff int64) {
	for p.lo < len(p.t) && p.t[p.lo] < cutoff {
		p.lo++
	}
	if n := p.len(); cap(p.t) > 2*n+64 {
		t, v, seq := make([]int64, n), make([]float64, n), make([]uint32, n)
		copy(t, p.t[p.lo:])
		copy(v, p.v[p.lo:])
		copy(seq, p.seq[p.lo:])
		*p = points{t: t, v: v, seq: seq}
	}
}

// from is the first point (counted from the start) stored or changed after
// write seq; len() when there is none.
func (p *points) from(seq uint32) int {
	s := p.seq[p.lo:]
	return sort.Search(len(s), func(i int) bool { return s[i] > seq })
}

// series is one field of one group. A counter keeps its last value (scaled,
// before the rate) and stores the rate between two readings.
type series struct {
	id     int
	group  *group
	field  string
	kind   kind
	spec   fieldSpec // the rules the series was built with
	unit   string    // as configured; the layout shows a counter per second
	points points
	text   string

	lastSeen time.Time // wall clock of the last value, stored or not

	// The change feed (feed.go): the write the series appeared in or started
	// again in, and the write its text last changed in.
	created uint32
	textSeq uint32

	prevV    float64
	prevT    int64
	havePrev bool
}

// restart empties the series under new rules: its points were made under the
// old ones. A page that has it gets it whole again.
func (s *series) restart(k kind, spec fieldSpec, seq uint32) {
	s.kind, s.spec = k, spec
	s.points, s.text, s.textSeq, s.havePrev = points{}, "", 0, false
	s.created = seq
}

// group is one measurement with one set of tags.
type group struct {
	key         string
	hash        uint64 // the HashID of its metrics
	measurement string
	tags        map[string]string
	series      map[string]*series
}

// is tells whether m is of this group: its name and all its tags.
func (g *group) is(m telegraf.Metric) bool {
	list := m.TagList()
	if m.Name() != g.measurement || len(list) != len(g.tags) {
		return false
	}
	for _, tag := range list {
		if v, ok := g.tags[tag.Key]; !ok || v != tag.Value {
			return false
		}
	}
	return true
}

// fieldSpec is how the store treats a field: the multiplier for its raw
// values and whether it is a running total shown as a rate.
type fieldSpec struct {
	scale   float64
	counter bool
}

// store holds the window of all series. One store lives for the whole process,
// so a config reload, which creates a new plugin instance, keeps the window.
type store struct {
	mu     sync.RWMutex
	window time.Duration
	spec   func(measurement, field string) fieldSpec
	unit   func(measurement, field string) string

	groups    map[string]*group            // by key
	byHash    map[uint64][]*group          // by the HashID of their metrics
	byM       map[string]map[string]*group // measurement -> group key -> group
	nextID    int
	nseries   int
	lastWrite time.Time
	lastSweep time.Time
	version   int    // grows whenever series appear, go away or are rebuilt, and on every reload
	seq       uint32 // counts the writes: the cursor of the change feed. At a write a second it lasts 136 years.
	// written is closed by the next write or reload: a request that waits for
	// changes waits on it (feed.go). Each of them puts a new one.
	written chan struct{}
	// start marks this store, and so the numbering of its series and writes:
	// both start again in a new process. The page drops its points when it changes.
	start int64
}

func newStore() *store {
	return &store{
		start:   time.Now().UnixMilli(),
		window:  time.Hour,
		spec:    func(string, string) fieldSpec { return fieldSpec{scale: 1} },
		unit:    func(string, string) string { return "" },
		groups:  make(map[string]*group),
		byHash:  make(map[uint64][]*group),
		byM:     make(map[string]map[string]*group),
		written: make(chan struct{}),
	}
}

// signal wakes the requests that wait for changes. The caller holds the
// write lock.
func (st *store) signal() {
	close(st.written)
	st.written = make(chan struct{})
}

// configure sets the window and the rules of the fields after a (re)load of
// the configuration. The layout may have changed in any way, so version
// grows and waiting pages are woken: they load the layout again. A series
// whose rules changed (a field became a counter, or got another scale)
// starts again empty: its old points were made under the old rules. The
// unit of a series is looked up here and when it appears, not on every
// layout: a lookup tries every pattern of the configuration.
func (st *store) configure(window time.Duration, f *fields) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.window, st.spec, st.unit = window, f.spec, f.unit
	st.seq++
	st.version++
	for _, g := range st.groups {
		for _, s := range g.series {
			s.unit = f.unit(g.measurement, s.field)
			if s.kind == text {
				continue
			}
			next := f.spec(g.measurement, s.field)
			if next != s.spec {
				s.restart(kindOf(next), next, st.seq)
			}
		}
	}
	st.signal()
}

func kindOf(spec fieldSpec) kind {
	if spec.counter {
		return counter
	}
	return gauge
}

// groupKey is the measurement and the sorted tags, escaped as in line
// protocol so that different tag sets never share a key.
func groupKey(measurement string, tags map[string]string) string {
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(keyEscaper.Replace(measurement))
	for _, k := range keys {
		b.WriteByte(',')
		b.WriteString(keyEscaper.Replace(k))
		b.WriteByte('=')
		b.WriteString(keyEscaper.Replace(tags[k]))
	}
	return b.String()
}

var keyEscaper = strings.NewReplacer(`\`, `\\`, `,`, `\,`, `=`, `\=`)

// add stores the metrics and returns how many it dropped for a time too far
// ahead of now.
func (st *store) add(metrics []telegraf.Metric, now time.Time) (ahead int) {
	st.mu.Lock()
	defer st.mu.Unlock()
	limit := now.Add(maxAhead)
	st.seq++
	for _, m := range metrics {
		if m.Time().After(limit) {
			ahead++
			continue
		}
		st.addMetric(m, now)
	}
	st.lastWrite = now
	if now.Sub(st.lastSweep) > time.Minute {
		st.sweep(now)
		st.lastSweep = now
	}
	st.signal()
	return ahead
}

// groupOf finds the group of m by its HashID, or makes it. Only a new group
// builds its tag map and key.
func (st *store) groupOf(m telegraf.Metric) *group {
	h := m.HashID()
	for _, g := range st.byHash[h] {
		if g.is(m) {
			return g
		}
	}
	tags := make(map[string]string, len(m.TagList()))
	for _, tag := range m.TagList() {
		tags[tag.Key] = tag.Value
	}
	name := m.Name()
	key := groupKey(name, tags)
	g := &group{key: key, hash: h, measurement: name, tags: tags, series: make(map[string]*series)}
	st.groups[key] = g
	st.byHash[h] = append(st.byHash[h], g)
	if st.byM[name] == nil {
		st.byM[name] = make(map[string]*group)
	}
	st.byM[name][key] = g
	return g
}

func (st *store) addMetric(m telegraf.Metric, now time.Time) {
	g := st.groupOf(m)
	t := m.Time().UnixMilli()
	for _, f := range m.FieldList() {
		s := g.series[f.Key]
		if s == nil {
			s = &series{id: st.nextID, group: g, field: f.Key, unit: st.unit(g.measurement, f.Key), created: st.seq}
			if _, ok := f.Value.(string); ok {
				s.kind = text
			} else {
				s.spec = st.spec(g.measurement, f.Key)
				s.kind = kindOf(s.spec)
			}
			st.nextID++
			st.nseries++
			st.version++
			g.series[f.Key] = s
		}
		st.addValue(s, f.Value, t, now)
	}
}

func (st *store) addValue(s *series, value any, t int64, now time.Time) {
	// Any value keeps the series alive, also one that is not stored (NaN).
	s.lastSeen = now
	// A field that turns from text into a number or back starts its series
	// again: one kind of value cannot be shown as the other.
	if x, isText := value.(string); isText {
		if s.kind != text {
			s.restart(text, fieldSpec{}, st.seq)
			st.version++
		}
		if s.text != x || s.textSeq == 0 {
			s.text, s.textSeq = x, st.seq
		}
		return
	}
	var v float64
	switch x := value.(type) {
	case float64:
		v = x
	case int64:
		v = float64(x)
	case uint64:
		v = float64(x)
	case bool:
		if x {
			v = 1
		}
	default:
		return
	}
	if s.kind == text {
		spec := st.spec(s.group.measurement, s.field)
		s.restart(kindOf(spec), spec, st.seq)
		st.version++
	}
	v *= s.spec.scale
	// JSON has no NaN or Inf: one such point would break every reply that
	// carries it, so it is not kept.
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return
	}

	if s.kind == counter {
		prevV, prevT, had := s.prevV, s.prevT, s.havePrev
		if had && t <= prevT {
			return // same reading again
		}
		s.prevV, s.prevT, s.havePrev = v, t, true
		// The first reading and a counter reset (the app restarted) give no rate.
		if !had || v < prevV {
			return
		}
		v = (v - prevV) / (float64(t-prevT) / 1000)
	}

	if lastT, lastV, ok := s.points.last(); ok && lastT >= t {
		if lastT == t && lastV != v {
			s.points.setLast(v, st.seq)
		}
		return
	}
	s.points.push(t, v, st.seq)
	s.points.trim(t - st.window.Milliseconds())
}

// sweep trims every series to the window by the wall clock, removes series
// that got nothing for a whole window, and groups left without series. It
// runs at most once a minute, inside a write.
func (st *store) sweep(now time.Time) {
	cutoff := now.Add(-st.window)
	for key, g := range st.groups {
		for field, s := range g.series {
			if s.lastSeen.Before(cutoff) {
				delete(g.series, field)
				st.nseries--
				st.version++
				continue
			}
			s.points.trim(cutoff.UnixMilli())
		}
		if len(g.series) == 0 {
			st.dropGroup(key, g)
		}
	}
}

func (st *store) dropGroup(key string, g *group) {
	delete(st.groups, key)
	delete(st.byM[g.measurement], key)
	if len(st.byM[g.measurement]) == 0 {
		delete(st.byM, g.measurement)
	}
	list := st.byHash[g.hash]
	for i, x := range list {
		if x != g {
			continue
		}
		if list = append(list[:i], list[i+1:]...); len(list) == 0 {
			delete(st.byHash, g.hash)
		} else {
			st.byHash[g.hash] = list
		}
		return
	}
}
