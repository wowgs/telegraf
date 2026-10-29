# Scheduler Statistics Input Plugin

This plugin gathers the run queue statistics of each CPU from
[`/proc/schedstat`][schedstat]: how long tasks ran on the CPU, how long tasks
waited in its run queue, and how many time slices it ran. Unlike the load
average, which the kernel computes for the whole system only, these values
show the run queue of each CPU.

⭐ Telegraf v1.40.2
🏷️ system
💻 linux

[schedstat]: https://www.kernel.org/doc/html/latest/scheduler/sched-stats.html

## Global configuration options <!-- @/docs/includes/plugin_config.md -->

Plugins support additional global and plugin configuration settings for tasks
such as modifying metrics, tags, and fields, creating aliases, and configuring
plugin ordering. See [CONFIGURATION.md][CONFIGURATION.md] for more details.

[CONFIGURATION.md]: ../../../docs/CONFIGURATION.md#plugins

## Configuration

```toml @sample.conf
# Gather the run queue statistics of each CPU from /proc/schedstat
# This plugin ONLY supports Linux
[[inputs.schedstat]]
  # no configuration
```

The plugin reads `/proc/schedstat`, or `$HOST_PROC/schedstat` when the
`HOST_PROC` environment variable is set. It supports versions 15, 16 and 17 of
the file: their CPU lines have the same fields. The plugin fails to start on
another version, because the fields may have changed their meaning.

The values come from the scheduler's `sched_info` accounting. They do not need
the `kernel.sched_schedstats` sysctl, which only enables the other fields of
the file.

## Metrics

One metric for each CPU. All fields are counters that only increase: compute
their rate over time to use them.

- schedstat
  - tags:
    - cpu (the CPU, as in `/proc/schedstat`: `cpu0`, `cpu1`, ...)
  - fields:
    - run_time_ns (uint, nanoseconds): time spent running by tasks on this CPU
    - wait_time_ns (uint, nanoseconds): time spent waiting to run by tasks on
      this CPU
    - timeslices (uint): number of time slices run on this CPU

The rate of `run_time_ns` in seconds per second is the share of time the CPU
was busy. The rate of `wait_time_ns` in seconds per second is the average
number of tasks that waited in the run queue of the CPU.

## Example Output

```text
schedstat,cpu=cpu0,host=myhost run_time_ns=786139578507u,timeslices=68892772u,wait_time_ns=93597100859u 1792818000000000000
schedstat,cpu=cpu1,host=myhost run_time_ns=725739442700u,timeslices=39482819u,wait_time_ns=70660648148u 1792818000000000000
schedstat,cpu=cpu2,host=myhost run_time_ns=750161997924u,timeslices=37515384u,wait_time_ns=70855841378u 1792818000000000000
schedstat,cpu=cpu3,host=myhost run_time_ns=722508672185u,timeslices=36142772u,wait_time_ns=72151226765u 1792818000000000000
```
