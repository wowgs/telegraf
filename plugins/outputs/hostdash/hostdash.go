//go:generate ../../../tools/readme_config_includer/generator
package hostdash

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/gzhttp"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/plugins/outputs"
)

//go:embed sample.conf
var sampleConfig string

// The page: index.html, its ES modules and the vendored uPlot.
//
//go:embed page/*.html page/*.js page/*.css page/vendor
var pageFiles embed.FS

// The window lives at package level: on a config reload Telegraf closes this
// plugin and creates a new instance in the same process, and the window stays.
var shared = newStore()

// active is set while an instance is between Init and Close: two instances
// would share the window and fight over its rules. On a reload Telegraf
// closes the old one before it initializes the new one.
var active atomic.Bool

type Hostdash struct {
	Listen      string             `toml:"listen"`
	Window      config.Duration    `toml:"window"`
	WakeDelay   config.Duration    `toml:"wake_delay"`
	TipLines    int                `toml:"tip_lines"`
	ChartLines  int                `toml:"chart_lines"`
	Compression []string           `toml:"compression"`
	Title       string             `toml:"title"`
	DefaultPage string             `toml:"default_page"`
	Units       map[string]string  `toml:"units"`
	Scale       map[string]float64 `toml:"scale"`
	Counters    []string           `toml:"counters"`
	Sections    []sectionConfig    `toml:"section"`
	Checks      []checkConfig      `toml:"check"`
	Log         telegraf.Logger    `toml:"-"`

	page     *pageConfig
	server   *http.Server
	listener net.Listener
	wg       sync.WaitGroup
	closing  chan struct{} // closed by Close: waiting requests answer at once

	// The statuses of the latest write, shared by the requests that waited
	// for it (feed.go).
	statusMu    sync.Mutex
	statusValid bool
	statusSeq   uint32
	statusList  []sectionStatus
}

func (*Hostdash) SampleConfig() string {
	return sampleConfig
}

func (h *Hostdash) Init() error {
	if h.Window <= 0 {
		return errors.New("window must be positive")
	}
	if err := h.validate(); err != nil {
		return err
	}
	f, err := newFields(h.Units, h.Scale, h.Counters)
	if err != nil {
		return err
	}
	if h.Title == "" {
		name, err := os.Hostname()
		if err != nil {
			return fmt.Errorf("title is empty and the host name is unknown: %w", err)
		}
		h.Title = name
	}
	page, err := fs.Sub(pageFiles, "page")
	if err != nil {
		return err
	}
	files, err := pageHandler(page)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("GET /", files)
	mux.HandleFunc("GET /api/layout", func(w http.ResponseWriter, _ *http.Request) {
		l := shared.layout(h.page, time.Now())
		l.TipLines, l.ChartLines = h.TipLines, h.ChartLines
		h.writeJSON(w, l)
	})
	mux.HandleFunc("GET /api/series", h.handleSeries)
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, _ *http.Request) {
		h.writeJSON(w, shared.status(h.page, time.Now()))
	})
	handler, err := h.compressed(mux)
	if err != nil {
		return err
	}

	// Last, when nothing can fail any more: take the shared window.
	if !active.CompareAndSwap(false, true) {
		return errors.New("a second [[outputs.hostdash]] in one Telegraf: the instances would share one window")
	}
	h.page = h.compile()
	h.closing = make(chan struct{})
	shared.configure(time.Duration(h.Window), f)
	h.server = &http.Server{
		Addr:              h.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	return nil
}

// compressed wraps the handler so that it compresses what it serves with the
// encodings of the compression option that the client accepts, the first
// listed preferred. A proxy in front then passes the compressed reply on.
// No encodings: no compression.
func (h *Hostdash) compressed(next http.Handler) (http.Handler, error) {
	if len(h.Compression) == 0 {
		return next, nil
	}
	zstd, gzip := slices.Contains(h.Compression, "zstd"), slices.Contains(h.Compression, "gzip")
	wrap, err := gzhttp.NewWrapper(
		gzhttp.EnableZstd(zstd),
		gzhttp.EnableGzip(gzip),
		gzhttp.PreferZstd(h.Compression[0] == "zstd"),
	)
	if err != nil {
		return nil, fmt.Errorf("compression: %w", err)
	}
	return wrap(next), nil
}

// pageHandler serves the files of the page with a weak ETag of each file's
// content and Cache-Control no-cache: a browser asks again on every load and
// gets 304 for a file it has, instead of every file again. Embedded files
// have no modification time, so without the tag nothing could be revalidated.
func pageHandler(page fs.FS) (http.Handler, error) {
	tags := make(map[string]string)
	err := fs.WalkDir(page, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(page, path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		tags["/"+path] = `W/"` + hex.EncodeToString(sum[:8]) + `"`
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("page files: %w", err)
	}
	files := http.FileServerFS(page)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasSuffix(p, "/") {
			p += "index.html"
		}
		if tag, ok := tags[p]; ok {
			w.Header().Set("ETag", tag)
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	}), nil
}

// maxMeasurements bounds the measurements one /api/series request may ask for.
const maxMeasurements = 10_000

// handleSeries answers /api/series?m=<measurement>:<seq>&m=…&after=<seq>&wait=<s>:
// the changes of each measurement after write seq (0: all of it). A
// measurement asked twice counts once, with the earlier seq. With wait the
// request waits for the next write after after, at most maxWait.
func (h *Hostdash) handleSeries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	asked, err := parseFeedQuery(q["m"])
	if err != nil {
		http.Error(w, "m: "+err.Error(), http.StatusBadRequest)
		return
	}
	var after uint64
	if v := q.Get("after"); v != "" {
		if after, err = strconv.ParseUint(v, 10, 32); err != nil {
			http.Error(w, "after: "+err.Error(), http.StatusBadRequest)
			return
		}
	}
	var wait time.Duration
	if v := q.Get("wait"); v != "" {
		s, err := strconv.ParseFloat(v, 64)
		if err != nil || s < 0 || math.IsNaN(s) || math.IsInf(s, 0) {
			http.Error(w, "wait: not a number of seconds", http.StatusBadRequest)
			return
		}
		// feed cuts it to maxWait; the cap here only keeps the conversion in range.
		wait = time.Duration(min(s, 3600) * float64(time.Second))
	}
	if d, ok := h.feed(r.Context(), asked, uint32(after), wait); ok {
		h.writeJSON(w, d)
	}
}

func parseFeedQuery(items []string) ([]feedQuery, error) {
	if len(items) > maxMeasurements {
		return nil, fmt.Errorf("%d measurements asked, at most %d", len(items), maxMeasurements)
	}
	asked := make([]feedQuery, 0, len(items))
	at := make(map[string]int, len(items))
	for _, item := range items {
		// The seq follows the last colon: a measurement name may hold one.
		i := strings.LastIndexByte(item, ':')
		if i <= 0 {
			return nil, fmt.Errorf("%q is not <measurement>:<seq>", item)
		}
		seq, err := strconv.ParseUint(item[i+1:], 10, 32)
		if err != nil {
			return nil, fmt.Errorf("%q: %w", item, err)
		}
		name := item[:i]
		if k, ok := at[name]; ok {
			asked[k].since = min(asked[k].since, uint32(seq))
			continue
		}
		at[name] = len(asked)
		asked = append(asked, feedQuery{name, uint32(seq)})
	}
	return asked, nil
}

// writeJSON answers with v as JSON. A failed write is the client's broken
// connection, worth a debug line only.
func (h *Hostdash) writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		h.Log.Debugf("Writing a reply failed: %v", err)
	}
}

func (h *Hostdash) Connect() error {
	ln, err := net.Listen("tcp", h.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", h.Listen, err)
	}
	h.listener = ln
	h.Log.Infof("Serving the page on %s", ln.Addr())
	h.wg.Go(func() {
		if err := h.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.Log.Errorf("Server error: %v", err)
		}
	})
	return nil
}

// Close stops the server. Requests that wait for changes answer at once, so
// the shutdown does not wait for them.
func (h *Hostdash) Close() error {
	if h.closing == nil {
		return nil // Init failed
	}
	defer active.Store(false)
	close(h.closing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := h.server.Shutdown(ctx)
	h.wg.Wait()
	return err
}

func (h *Hostdash) Write(metrics []telegraf.Metric) error {
	if ahead := shared.add(metrics, time.Now()); ahead > 0 {
		h.Log.Debugf("Dropped %d metrics more than %s ahead of this host's clock", ahead, maxAhead)
	}
	return nil
}

func init() {
	outputs.Add("hostdash", func() telegraf.Output {
		return &Hostdash{
			Listen:      "127.0.0.1:9000",
			Window:      config.Duration(time.Hour),
			WakeDelay:   config.Duration(300 * time.Millisecond),
			TipLines:    20,
			ChartLines:  100,
			Compression: []string{"zstd", "gzip"},
			DefaultPage: "Other",
		}
	})
}
