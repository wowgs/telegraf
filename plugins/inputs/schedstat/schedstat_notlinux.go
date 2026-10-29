//go:generate ../../../tools/readme_config_includer/generator
//go:build !linux

package schedstat

import (
	_ "embed"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/plugins/inputs"
)

//go:embed sample.conf
var sampleConfig string

type Schedstat struct {
	Log telegraf.Logger `toml:"-"`
}

func (*Schedstat) SampleConfig() string { return sampleConfig }

func (s *Schedstat) Init() error {
	s.Log.Warn("Current platform is not supported")
	return nil
}

func (*Schedstat) Gather(telegraf.Accumulator) error { return nil }

func init() {
	inputs.Add("schedstat", func() telegraf.Input {
		return &Schedstat{}
	})
}
