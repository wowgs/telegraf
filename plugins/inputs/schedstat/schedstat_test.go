//go:build linux

package schedstat

import (
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/metric"
	"github.com/influxdata/telegraf/testutil"
)

// The files in testdata: v17_pi5 and v17_x86 are /proc/schedstat of a
// Raspberry Pi 5 (kernel 6.18.50, 4 CPUs) and of an x86 server (kernel 7.0.0,
// 16 CPUs); v15 and v18 are the v17_pi5 file under another version line;
// no_cpus has no cpu lines.
func plugin(t *testing.T, dir string) *Schedstat {
	t.Helper()
	return &Schedstat{Log: testutil.Logger{}, procPath: filepath.Join("testdata", dir)}
}

func TestGatherRaspberryPi(t *testing.T) {
	s := plugin(t, "v17_pi5")
	require.NoError(t, s.Init())

	var acc testutil.Accumulator
	require.NoError(t, s.Gather(&acc))

	cpu := func(n string, run, wait, slices uint64) telegraf.Metric {
		return metric.New("schedstat",
			map[string]string{"cpu": n},
			map[string]any{"run_time_ns": run, "wait_time_ns": wait, "timeslices": slices},
			time.Unix(0, 0), telegraf.Counter)
	}
	expected := []telegraf.Metric{
		cpu("cpu0", 786139578507, 93597100859, 68892772),
		cpu("cpu1", 725739442700, 70660648148, 39482819),
		cpu("cpu2", 750161997924, 70855841378, 37515384),
		cpu("cpu3", 722508672185, 72151226765, 36142772),
	}
	testutil.RequireMetricsEqual(t, expected, acc.GetTelegrafMetrics(), testutil.IgnoreTime())
}

func TestGatherServer(t *testing.T) {
	s := plugin(t, "v17_x86")
	require.NoError(t, s.Init())

	var acc testutil.Accumulator
	require.NoError(t, s.Gather(&acc))

	metrics := acc.GetTelegrafMetrics()
	require.Len(t, metrics, 16)
	for i, m := range metrics {
		require.Equal(t, "schedstat", m.Name())
		require.Equal(t, telegraf.Counter, m.Type())
		cpu, ok := m.GetTag("cpu")
		require.True(t, ok)
		require.Equal(t, "cpu"+strconv.Itoa(i), cpu)
		require.Len(t, m.FieldList(), 3)
		// One gather, one time for all CPUs.
		require.Equal(t, metrics[0].Time(), m.Time())
	}
}

func TestVersion15(t *testing.T) {
	s := plugin(t, "v15")
	require.NoError(t, s.Init())

	var acc testutil.Accumulator
	require.NoError(t, s.Gather(&acc))
	require.Len(t, acc.GetTelegrafMetrics(), 4)
}

func TestUnsupportedVersion(t *testing.T) {
	err := plugin(t, "v18").Init()
	require.ErrorContains(t, err, "version 18")
}

func TestMissingFile(t *testing.T) {
	require.Error(t, plugin(t, "absent").Init())
}

func TestNoCPULines(t *testing.T) {
	s := plugin(t, "no_cpus")
	require.NoError(t, s.Init())

	var acc testutil.Accumulator
	require.ErrorContains(t, s.Gather(&acc), "no cpu lines")
	require.Empty(t, acc.GetTelegrafMetrics())
}

func TestHostProc(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("testdata", "v17_pi5"))
	require.NoError(t, err)
	t.Setenv("HOST_PROC", dir)

	s := &Schedstat{Log: testutil.Logger{}}
	require.NoError(t, s.Init())
	require.Equal(t, dir, s.procPath)
}
