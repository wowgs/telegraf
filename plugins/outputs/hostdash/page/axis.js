// Value axes of the charts: their range, the steps uPlot may choose between
// ticks and what the ticks say. Pure functions.

// Scales of a unit: a divisor and the suffix after the number.
function scales(unit) {
  if (unit === 's/s') return [{ div: 0.01, suffix: '%' }];
  if (unit === '%') return [{ div: 1, suffix: '%' }];
  const steps = unit === 'B' || unit === 'B/s' ? [[2 ** 40, 'T'], [2 ** 30, 'G'], [2 ** 20, 'M'], [1024, 'K']]
              : [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];
  return [...steps.map(([div, suffix]) => ({ div, suffix })), { div: 1, suffix: '' }];
}

// digits is how many digits after the point tell ticks one step apart from
// each other: the fewest that show each tick exactly (0.25 → 2), at most two
// more than the step needs; a step like 0.2328 gets just the digits it needs.
function digits(ticks, step) {
  const need = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  for (let d = need; d <= need + 2; d++) {
    if (ticks.every(v => Math.abs(+v.toFixed(d) - v) <= 1e-9 * Math.max(1, Math.abs(v)))) return d;
  }
  return need;
}

// valueLabels labels the ticks of a value axis. Like a time axis (12:30,
// 13:00), every tick gets the full value in one format: one scale for all,
// and as many digits as the step between the ticks needs. Of the scales of
// the unit it takes one where the ticks print exactly (15300M, not 14.94G),
// and of those the one with the shortest labels: 0, 0.5G, 1G, not 0, 512M,
// 1024M.
export function valueLabels(unit, ticks) {
  const vals = ticks.filter(v => v != null && isFinite(v));
  if (!vals.length) return ticks.map(() => '');
  let step = Infinity;
  for (let i = 1; i < vals.length; i++) step = Math.min(step, Math.abs(vals[i] - vals[i - 1]) || Infinity);
  const big = Math.max(...vals.map(Math.abs));
  if (!isFinite(step)) step = big ? big / 100 : 1; // one tick: three significant digits
  let best = null;
  for (const sc of scales(unit)) {
    if (sc.div > big && sc.div !== scales(unit).at(-1).div) continue; // no 0.0001G for 100 K
    const scaled = vals.map(v => v / sc.div), d = digits(scaled, step / sc.div);
    const exact = scaled.every(v => Math.abs(+v.toFixed(d) - v) <= 1e-9 * Math.max(1, Math.abs(v)));
    const labels = ticks.map(v => v == null || !isFinite(v) ? '' : v ? (v / sc.div).toFixed(d) + sc.suffix : '0');
    const width = Math.max(...labels.map(l => l.length));
    if (!best || exact > best.exact || exact === best.exact && width < best.width) best = { labels, width, exact };
  }
  return best.labels;
}

// axisIncrs is the steps uPlot may choose between ticks (its axis option
// incrs, a function of the axis range). For bytes they are uPlot's own 1, 2,
// 2.5 and 5 × 10^n, but in the binary scale of the values: 0.1G for 15 GiB,
// 0.01T for 1.42 TiB, never 9.31G (1e10 B). Other units keep uPlot's own
// steps: undefined.
export function axisIncrs(unit) {
  if (unit !== 'B' && unit !== 'B/s') return undefined;
  return (u, axisIdx, min, max) => {
    const big = Math.max(Math.abs(min), Math.abs(max));
    const sc = scales(unit).find(s => s.div <= big) ?? scales(unit).at(-1);
    const out = [];
    for (let e = -3; e <= 4; e++) {
      for (const m of [1, 2, 2.5, 5]) { const v = m * 10 ** e * sc.div; if (v >= 1) out.push(v); }
    }
    return out;
  };
}

// yBounds is the range of a chart's value axis. The bottom is min, or 0, or
// lower when the data goes below 0. The top follows the data with 10% room
// above it, goes at least as high as minMax, and never passes the ceiling:
// max, or the latest value of max_field (cap). So 2% CPU on a 0–100% chart
// gets an axis to about 2.2%, not to 100%.
export function yBounds({ min, minMax } = {}, cap, dmin, dmax) {
  const lo = min ?? Math.min(0, dmin ?? 0);
  const top = dmax ?? lo;
  let hi = top + Math.abs(top) * 0.1;
  if (minMax != null) hi = Math.max(hi, minMax);
  if (cap != null) hi = Math.min(hi, cap);
  if (!(hi > lo)) hi = cap != null && cap > lo ? cap : lo + 1;
  return [lo, hi];
}
