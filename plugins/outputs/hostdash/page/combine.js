// Combining the series of one line, and the tables a chart draws. Pure:
// tested by pagetest/combine.test.mjs.

import { Points } from './points.js';

export const AGGS = {
  avg: v => v.reduce((a, b) => a + b, 0) / v.length,
  min: v => Math.min(...v),
  max: v => Math.max(...v),
  sum: v => v.reduce((a, b) => a + b, 0),
};

// Readings of one gather from different groups differ by a few milliseconds.
// Telegraf rounds metric times to the interval, at most to whole seconds
// (agent precision), so they are combined on a grid of whole seconds.
export const ALIGN_MS = 1000;
export const align = t => Math.round(t / ALIGN_MS) * ALIGN_MS;

// Combined is the line of several series (Points) combined with agg at every
// grid time where at least one series has a value; band gives min, max and
// avg at once. Per grid time each series counts once, with its last reading
// there. A write changes only the newest points, so update combines again
// only the grid times from the first changed time on.
export class Combined {
  constructor(agg) {
    this.agg = agg;
    this.out = agg === 'band' ? { lo: new Points(), hi: new Points(), mid: new Points() } : { line: new Points() };
  }

  get line() { return this.out.line ?? this.out.mid; }

  // update combines the members (Points, or null) again from time from on
  // (-Infinity: all of it) and drops the grid times before cutoff. The
  // page drops the points of a series older than the window by its own
  // newest point, so before cutoff a grid time may have lost some of its
  // readings: only a grid time whose readings all lie after cutoff stays.
  update(members, from, cutoff = -Infinity) {
    const g = from === -Infinity ? -Infinity : align(from);
    for (const p of Object.values(this.out)) p.cut(p.from(g));
    // The first reading of a member on grid time g is the first one that
    // rounds to it: half a step before g.
    const start = g === -Infinity ? -Infinity : g - ALIGN_MS / 2;
    const at = new Map();
    members.forEach((p, i) => {
      if (!p) return;
      for (let k = p.from(start); k < p.length; k++) {
        const key = align(p.time(k));
        let m = at.get(key);
        if (!m) at.set(key, m = { vals: [], last: -1 });
        if (m.last === i) m.vals[m.vals.length - 1] = p.value(k);
        else { m.vals.push(p.value(k)); m.last = i; }
      }
    });
    const keys = [...at.keys()].sort((a, b) => a - b);
    const f = AGGS[this.agg] || AGGS.avg;
    for (const key of keys) {
      const vals = at.get(key).vals;
      if (this.agg === 'band') {
        this.out.lo.push(key, AGGS.min(vals));
        this.out.hi.push(key, AGGS.max(vals));
        this.out.mid.push(key, AGGS.avg(vals));
      } else {
        this.out.line.push(key, f(vals));
      }
    }
    for (const p of Object.values(this.out)) p.trim(cutoff + ALIGN_MS / 2);
    return this;
  }
}

// latest gives agg of the newest reading of each series, at the newest grid
// time any series has: the last point of Combined, without the whole window.
export function latest(series, agg = 'avg') {
  let top = -Infinity;
  for (const p of series) if (p && p.length) top = Math.max(top, align(p.lastTime()));
  if (!isFinite(top)) return undefined;
  const vals = [];
  for (const p of series) if (p && p.length && align(p.lastTime()) === top) vals.push(p.lastValue());
  return (AGGS[agg] || AGGS.avg)(vals);
}

// medianStep is the typical (median) step between the points, or undefined
// below 3 points.
export function medianStep(p) {
  if (p.length < 3) return undefined;
  const steps = [];
  for (let i = 1; i < p.length; i++) if (p.time(i) > p.time(i - 1)) steps.push(p.time(i) - p.time(i - 1));
  if (!steps.length) return undefined;
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

// table turns points into a uPlot column pair, times in seconds on the grid.
// A pause longer than 3 typical steps (a restart, a lost source) gets a
// null in its middle, so the chart breaks the line there. The typical step
// is the line's own, or step for a line too short to tell (the chart passes
// the step of its other lines); without either nothing breaks.
export function table(p, step) {
  const own = medianStep(p) ?? step;
  const gap = own === undefined ? Infinity : Math.max(3 * own, 5000);
  const xs = [], ys = [];
  for (let i = 0; i < p.length; i++) {
    const t = p.time(i);
    if (i > 0 && t - p.time(i - 1) > gap) { xs.push(Math.round((t + p.time(i - 1)) / 2 / ALIGN_MS) * ALIGN_MS / 1000); ys.push(null); }
    const x = align(t) / 1000;
    if (xs.length && xs[xs.length - 1] === x) { ys[ys.length - 1] = p.value(i); continue; }
    xs.push(x); ys.push(p.value(i));
  }
  return [xs, ys];
}

// peak is the highest value of the points at or after t0.
export function peak(p, t0) {
  let top = -Infinity;
  for (let i = p.from(t0); i < p.length; i++) if (p.value(i) > top) top = p.value(i);
  return top;
}
