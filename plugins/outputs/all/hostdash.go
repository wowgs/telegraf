//go:build !custom || outputs || outputs.hostdash

package all

import _ "github.com/influxdata/telegraf/plugins/outputs/hostdash" // register plugin
