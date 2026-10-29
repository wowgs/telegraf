# Hostdash Output Plugin

This plugin shows your metrics on a live web page. It keeps the last hour of
points in memory and draws charts from them. It uses no database and writes
nothing to disk.

⭐ Telegraf v1.40.2
🏷️ applications
💻 all

## Global configuration options <!-- @/docs/includes/plugin_config.md -->

Plugins support additional global and plugin configuration settings for tasks
such as modifying metrics, tags, and fields, creating aliases, and configuring
plugin ordering. See [CONFIGURATION.md][CONFIGURATION.md] for more details.

[CONFIGURATION.md]: ../../../docs/CONFIGURATION.md#plugins

## Configuration

```toml @sample.conf
# Show metrics on a live web page from an in-memory buffer
[[outputs.hostdash]]
  ## Address of the page. The default is this host only. To open the page
  ## from other machines, set an address that they reach. The address is
  ## required: ":9000" would listen on every interface.
  # listen = "127.0.0.1:9000"

  ## How long to keep points in memory.
  # window = "1h"

  ## How many lines the hover popup of a chart lists at most: those around
  ## the line under the pointer, with a count of the others.
  # tip_lines = 20

  ## How many lines a chart draws at most: those with the highest peak.
  # chart_lines = 100

  ## After a write, a waiting request for changes waits this long for
  ## another write before it answers (at most 1 s), so that a gather that
  ## comes in two writes is drawn whole. "0s" answers at once.
  # wake_delay = "300ms"

  ## Encodings the plugin compresses its replies with, the first preferred
  ## when the client accepts several: "zstd" and "gzip". An empty list turns
  ## compression off.
  # compression = ["zstd", "gzip"]

  ## Title of the page. An empty title uses the host name.
  # title = ""

  ## Tab for a measurement that has no page in its section.
  # default_page = "Other"

  ## Fields that are running totals. The page shows them per second.
  ## A key is measurement.field and can contain *.
  # counters = ["net.bytes_*"]

  ## Unit of each field: B, Hz, %, °C, W, s, tok, count or any other text.
  # [outputs.hostdash.units]
  #   "mem.*" = "B"

  ## Multiplier for the raw value, for example from kHz to Hz.
  # [outputs.hostdash.scale]
  #   "linux_cpu.*_freq" = 1000.0

  ## Charts of one measurement. With a section, the page shows only the
  ## charts and tiles of the section for this measurement. The README lists
  ## all options.
  # [[outputs.hostdash.section]]
  #   measurement = "mem"
  #   title = "Memory"
  #   page = "System"
  #   [[outputs.hostdash.section.chart]]
  #     fields = ["used", "cached", "available"]
  #     max_field = "total"
```

## Quick start

Add the plugin to the Telegraf configuration:

```toml
[[outputs.hostdash]]
```

Restart Telegraf and open `http://127.0.0.1:9000` on the same host. The page
listens on this host only. To open it from another machine, set `listen` to
an address that the other machine reaches. The plugin gets new points when
Telegraf flushes its outputs, every 10 s by default. Set
`flush_interval = "1s"` on this output to see points a second after their
gather. Each measurement shows as a
card with a chart for each number field and a tile for each text field. A
card of a measurement without a section starts collapsed. Click the arrow
next to its title to open it.

## How the data is kept

The plugin keeps the points of each series in memory, as columns of times
and values. A series is one field of one measurement with one set of tags,
for example `cpu.usage_user` for `cpu=cpu3`. When a new point arrives, the
series drops the points that are older than `window`. New points always go
in. A text field keeps only its latest value. If a field changes between text
and number, its series starts again.

A series that gets no points for a whole `window` goes away. The window is
the only limit. The plugin does not limit the number of series or the memory
they take.

A restart of Telegraf empties the memory. A reload of the configuration keeps
it. One Telegraf process can have one `[[outputs.hostdash]]`.

## Units and rates

Telegraf sends no units, so you give them in the configuration. A key is
`measurement.field` and can contain `*`. If two keys match a field, the exact
name wins, then the longer key.

```toml
[[outputs.hostdash]]
  counters = ["net.bytes_*"]          # running totals, shown per second

  [outputs.hostdash.units]
    "mem.*" = "B"
    "mem.*_percent" = "%"

  [outputs.hostdash.scale]
    "linux_cpu.*_freq" = 1000.0       # kHz to Hz, then the unit is Hz
```

Put `counters` before the `units` and `scale` tables. In TOML, a key after a
table header belongs to that table.

## Charts for a measurement

A section sets the charts of one measurement. A measurement with a section
shows only the charts and tiles of its section.

```toml
  [[outputs.hostdash.section]]
    measurement = "mem"
    title = "Memory"
    page = "System"

    [[outputs.hostdash.section.chart]]
      title = "Memory"
      fields = ["used", "cached", "available"]
      max_field = "total"
```

This draws one chart with three lines. The axis never goes above the
total memory. A chart with more than 8 lines has a `band` button. It sets
`band by ()` in the line above it: one band for the whole section (see "Use
the page").

A section can open grouped, as an aggregation in PromQL does. With
`group_by`, the page keeps these tags and combines the series over all the
others with `agg`: one line for each value of the tags. `group_by = []` makes
one line of the whole section. With `group_without`, the page combines the
series over these tags and keeps the others:

```toml
  [[outputs.hostdash.section]]
    measurement = "interrupts"
    title = "Interrupts"
    group_by = ["cpu"]   # a sum per CPU over the interrupts
    agg = "sum"
  [[outputs.hostdash.section]]
    measurement = "schedstat"
    title = "Scheduler"
    group_without = ["cpu"]   # one line: all CPUs together
    agg = "avg"
```

| Section option | What it does |
| -------------- | ------------ |
| `measurement` | The measurement of the section. Required. |
| `title` | The title of the section. The default is the measurement. |
| `page` | The tab of the section. The default is `default_page`. |
| `input` | The Telegraf input that writes the measurement, for example `kernel` for `pressure`. The default is the name of the measurement. See "Statuses and the Overview tab". |
| `note` | A line of text above the charts. `{name}` is the latest value of a field, `{tag:name}` is a tag. |
| `group_by` | The tags that stay when the page opens the section; the series are combined over all other tags. `[]` is one line. The default is no grouping: one line for each series. |
| `group_without` | The tags that the series are combined over when the page opens the section; the other tags stay. Not together with `group_by`. |
| `agg` | How the series of one line combine: `avg`, `min`, `max`, `sum` or `band`. Needs `group_by` or `group_without`. The default goes by the unit of the first field of the first chart: `sum` for rates, counts and tokens (a unit that ends in `/s`, `count`, `tok`), `avg` otherwise. `s/s`, a share of time, is averaged. |

| Chart option | What it does |
| ------------ | ------------ |
| `fields` | The fields to draw. Required. |
| `labels` | A label for each field. |
| `title`, `hint` | The title and a short note. |
| `unit` | The unit of the axis. The default is the unit of the first field. |
| `min` | The bottom of the axis. The default is 0, or lower if the data goes below 0. |
| `max` | The axis never goes above this value. Below it, the top of the axis follows the data. |
| `max_field` | Like `max`, but the limit is the latest value of this field. |
| `min_max` | The axis goes at least this high. |
| `stacked` | Draw each line on top of the one before. The default is false. |

A dashed line marks a limit, for example the power cap of a GPU:

```toml
      [[outputs.hostdash.section.chart.ref]]
        label = "cap"
        field = "power_limit"
```

| Line option | What it does |
| ----------- | ------------ |
| `label` | The text on the line. |
| `field` | The line is at the latest value of this field. |
| `value` | The line is at this number. Set `field` or `value`, not both. |

A chart draws at most `chart_lines` lines, those with the highest peak in
the time shown. Its header says how many it left out. Filter or group the
series to see the others.

### Tiles

A tile shows one value in large type above the charts:

```toml
    [[outputs.hostdash.section.tile]]
      field = "available"
      title = "Memory available"
      sub = "of {total}"
      of = "total"
      below = true
      warn = 0.25
      bad = 0.1
```

The tile turns yellow when `available / total` is below 0.25 and red below
0.1. In `sub`, `{name}` is the latest value of a field and `{tag:name}` is a
tag. Without `of` and `below`, the thresholds apply to the value and a higher
value is worse.

A tile counts the series, not the lines of the query bar above it. It takes
the latest value of its field in each group of tags that the filter of the
section keeps. `agg` combines these values: `first` (the first group, the
default), `max` or `sum`. With `of`, each group compares `field / of`, and
`agg` combines these shares, as a check does.

## Tabs

The tab of a measurement is `page` in its section. A measurement without a
section, or with a section without `page`, goes to `default_page`.

```toml
  [[outputs.hostdash.section]]
    measurement = "nvidia_smi"
    page = "GPU"
```

Every tab and section of the configuration is on the page, also before its
measurement has data: such a section shows "No data yet.".

One measurement has at most one section. If you run two inputs of one kind,
their series differ by their tags, for example `url`. Filter or group them by
these tags on the page.

## Statuses and the Overview tab

The Overview tab shows the other tabs in their order. Under each tab are its
sections, with the same titles and in the same order as on the tab. A click
on a section opens it. Each section has a status:

| Status | When |
| ------ | ---- |
| `no data` | No point of any measurement of the input of the section in the window. The input does not collect. |
| `errors` | `gather_errors` or `startup_errors` of the input of the section grew in the window. Telegraf counts them in `internal_gather` with the tag `input`, so this needs `[[inputs.internal]]`. |
| `bad`, `warn` | A check of a field of the measurement of the section crossed its threshold (below). |
| `ok` | None of the above. |

A section shows the worst of these, with the reasons, in its header too. A
tab shows the worst status of its sections. If `[[inputs.internal]]` runs but
`internal_gather` never names the input of a section (a typo in `input`), the
section is `warn` with the reason `input X not in internal_gather`.

`no data` and `errors` belong to the Telegraf input, because Telegraf counts
the failed gathers per input. So all sections of one input share them: the
`kernel` input writes both `kernel` and `pressure`. The plugin learns the input
of a measurement from `input` in its section, because Telegraf does not put
it into the metric. A measurement without `input`, or without a section,
belongs to the input of its own name. An input belongs to one tab: two
sections of one input on two tabs are a configuration error.

A check compares a field with thresholds. It names the field with its
measurement, because two measurements can have fields of the same name:

```toml
[[outputs.hostdash]]
  [[outputs.hostdash.check]]
    field = "disk.used_percent"
    agg = "max"
    warn = 80.0
    bad = 95.0
```

| Check option | What it does |
| ------------ | ------------ |
| `field` | `measurement.field`. Required. |
| `agg` | How the latest values of all groups of tags combine: `max`, `min`, `avg` or `sum`. The default is the worst group: `max`, or `min` with `below`. |
| `warn`, `bad` | The thresholds. At least one is required. |
| `below` | A value below the threshold is worse. The default is false: a value above it is worse. |
| `of` | `measurement.field` of the same measurement: each group compares `field / of`, for example `mem.available` of `mem.total` with `below = true`. |

## Hide metrics

Use the Telegraf filters on this output:

```toml
[[outputs.hostdash]]
  namedrop = ["internal_memstats"]
  fieldexclude = ["inodes_*"]
```

Keep `internal_gather`: the `errors` status comes from it.

## Use the page

- The buttons at the top set the time range of all charts.
- The line above each section filters and groups the series by tags. Click
  its `+` button or its free space and choose `filter`, `group by` or
  `group without`, then a tag. For a
  filter, type a value or a pattern with `*`, or pick a value from the list.
  A group works as in PromQL: `sum by cpu` keeps `cpu` and adds up the series
  over the other tags, one line per CPU; `avg by ()` is one line;
  `avg without cpu` averages over the CPUs and keeps the other tags. Click
  `by` or `without` to switch between them; the tags stay. Without a group,
  each series is its own line. With `band`, each line shows as a band from
  the minimum to the maximum, with a line for the average. When you add the
  first tag, the function is `band`. Click it to choose another.
- A section opens with the grouping and `agg` of its configuration. To see
  each series again, remove the group with its `×`. A section
  that differs from its configuration has a `↺` button, which brings the
  configuration back.
- Point at a chart to see a popup. The line nearest to the pointer is the
  active line, and the other lines fade. The popup shows the time, the
  active line with all its tags, and all lines at that time, highest value
  first. If lines lie on top of each other, press the up or down arrow key to
  move to the next line in the list.
- The link keeps the time range and, for each section you changed, its
  filters and its group. A section you did not change is not in the link and
  shows its configuration. You can send the link to another person.
- A link can point to a section, like the anchor of a heading in Markdown:
  `#Load/system` opens the tab `Load` and scrolls to the section of the
  measurement `system`. If the section is collapsed, the link expands it. The
  title of each section is such a link. On the Overview, the name of a tab
  opens the tab, and the chip of a section opens the section.

The page uses [uPlot][uplot] for the charts. The file is part of the plugin, so
the page works without internet access.

[uplot]: https://github.com/leeoniya/uPlot

## HTTP API

| Request | Answer |
| ------- | ------ |
| `GET /api/layout` | The tabs and sections, with the tags and series IDs of each section (`empty` for a section without data), the status of each section (`statuses`), the statuses from the best to the worst (`statusOrder`), `windowMs`, `tipLines`, `chartLines`, `version`, `start`, `series`, `silent` and `title`. |
| `GET /api/series?m=cpu:<seq>&m=mem:<seq>&after=<seq>&wait=25` | The changes of the series of each measurement after write `<seq>`; `0` asks for all of them. With `wait`, the reply waits for the next write after `after`, at most 25 s. It also has the status of each section, the series count (`count`) and `silent`. |
| `GET /api/status` | The `title`, the series count (`series`), `silent`, the layout `version`, `start` and the status of each section. |

The plugin counts the writes it gets from Telegraf. The series reply has the
latest one in `seq`: ask the next time from it, and you get only what came
after. A request names measurements, not series, so it stays short however
many series they have.

The page does not ask on a timer. It keeps one request waiting: `after` is
the `seq` of the last reply and `wait=25`. The plugin answers at once when an
asked measurement has changes, or when `after` is not its latest write (a
write came, or the Telegraf process is new). Else it answers after the next
write and `wake_delay` without another one, or after `wait` with no changes. So the page gets new points and statuses as soon as
Telegraf writes them. Without `wait` the reply comes at once.

In the series reply, `series` maps each measurement to `s`, its changed
series by series ID. A series has `v`, its values, and `t`, the time of the
first point in Unix milliseconds, then the step from each point to the next.
When all changed series of a measurement have the same times, `t` is on the
measurement once and not on the series. For example
`{"t": [1792935820000, 10000, 10000], "s": {"7": {"v": [3.9, 0.7, 4.8]}}}`
is three points of series 7, 10 seconds apart. Drop the points you have from the first time sent on, and
append these: the last point can come again with a new value. With
`"full": true` the points are the whole window of the series: replace what
you have. A text field has `text`, its latest value. The series are those
the section of the measurement shows.

The layout, the series and the status replies have a `start` field. It is
the time when the Telegraf process started, in Unix milliseconds. A new
process numbers the series and the writes again. If `start` changes, drop
what you have and ask for everything with `seq` 0. Ask for the layout again
when `version` changes.

The files of the page have an `ETag`, so a browser loads only what changed.
