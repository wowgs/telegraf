//go:build !custom || inputs || inputs.schedstat

package all

import _ "github.com/influxdata/telegraf/plugins/inputs/schedstat" // register plugin
