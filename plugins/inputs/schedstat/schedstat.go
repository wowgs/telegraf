//go:generate ../../../tools/readme_config_includer/generator
//go:build linux

package schedstat

import (
	"bufio"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/procfs"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/internal"
	"github.com/influxdata/telegraf/plugins/inputs"
)

//go:embed sample.conf
var sampleConfig string

// supportedVersions are the versions of /proc/schedstat whose cpu lines hold
// the fields this plugin reads. Versions 15 to 17 changed only the domain
// lines (Documentation/scheduler/sched-stats.rst).
var supportedVersions = []int{15, 16, 17}

type Schedstat struct {
	Log telegraf.Logger `toml:"-"`

	procPath string
	fs       procfs.FS
}

func (*Schedstat) SampleConfig() string {
	return sampleConfig
}

func (s *Schedstat) Init() error {
	if s.procPath == "" {
		s.procPath = internal.GetProcPath()
	}

	file := filepath.Join(s.procPath, "schedstat")
	version, err := readVersion(file)
	if err != nil {
		return err
	}
	if !slices.Contains(supportedVersions, version) {
		return fmt.Errorf("version %d of %s is not supported, only versions %v", version, file, supportedVersions)
	}

	s.fs, err = procfs.NewFS(s.procPath)
	if err != nil {
		return fmt.Errorf("opening %s: %w", s.procPath, err)
	}
	return nil
}

func (s *Schedstat) Gather(acc telegraf.Accumulator) error {
	stats, err := s.fs.Schedstat()
	if err != nil {
		return fmt.Errorf("reading schedstat: %w", err)
	}
	if len(stats.CPUs) == 0 {
		return errors.New("no cpu lines in schedstat")
	}

	now := time.Now()
	for _, cpu := range stats.CPUs {
		fields := map[string]any{
			"run_time_ns":  cpu.RunningNanoseconds,
			"wait_time_ns": cpu.WaitingNanoseconds,
			"timeslices":   cpu.RunTimeslices,
		}
		tags := map[string]string{"cpu": "cpu" + cpu.CPUNum}
		acc.AddCounter("schedstat", fields, tags, now)
	}
	return nil
}

// readVersion reads the format version from the first line of the file:
// "version 17".
func readVersion(file string) (int, error) {
	f, err := os.Open(file)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return 0, fmt.Errorf("reading %s: %w", file, err)
		}
		return 0, fmt.Errorf("%s is empty", file)
	}
	value, found := strings.CutPrefix(scanner.Text(), "version ")
	if !found {
		return 0, fmt.Errorf("no version line at the start of %s", file)
	}
	version, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, fmt.Errorf("parsing the version in %s: %w", file, err)
	}
	return version, nil
}

func init() {
	inputs.Add("schedstat", func() telegraf.Input {
		return &Schedstat{}
	})
}
