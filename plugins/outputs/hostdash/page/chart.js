// A time series chart on uPlot (vendor/uPlot.iife.min.js, global uPlot).
// The x range comes from the time bar at the top of the page: a chart has no
// zoom of its own. The cursor moves on all charts at once.

import { fmt } from './format.js';
import { valueLabels, axisIncrs, yBounds } from './axis.js';
import { tipRows, stack } from './model.js';
import { table, medianStep } from './combine.js';
import { Tip } from './tip.js';
import { $ } from './dom.js';

export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map(i => css(`--c${i}`));

// Legends switched to the expanded grid stay expanded in this browser; the
// default is one row.
const expandKey = chart => `hostdash:legend:${chart}`;
function isExpanded(chart) {
  try { return localStorage.getItem(expandKey(chart)) === '1'; } catch { return false; }
}
function setExpanded(chart, on) {
  try { on ? localStorage.setItem(expandKey(chart), '1') : localStorage.removeItem(expandKey(chart)); } catch { /* storage off */ }
}

// Lines hidden by a click on the legend stay hidden in this browser.
const hideKey = (chart, label) => `hostdash:hide:${chart}:${label}`;
function isHidden(chart, label) {
  try { return localStorage.getItem(hideKey(chart, label)) === '1'; } catch { return false; }
}
function setHidden(chart, label, hidden) {
  try { hidden ? localStorage.setItem(hideKey(chart, label), '1') : localStorage.removeItem(hideKey(chart, label)); } catch { /* storage off */ }
}

// clock is a time of day on the 24-hour clock; t is in seconds.
const clock = (t, seconds) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: false });

// chartStep is the typical step of the lines of a chart, for a line too
// short to have its own: the median of their steps.
function chartStep(lines) {
  const steps = lines.map(l => medianStep(l.points)).filter(s => s !== undefined).sort((a, b) => a - b);
  return steps.length ? steps[steps.length >> 1] : undefined;
}

// axisWidth fits the value axis to its longest label (uPlot calls it with the labels).
const axisWidth = (u, labels) => Math.max(40, 14 + 7 * Math.max(0, ...(labels || []).map(l => String(l).length)));

export class Chart {
  // spec: unit, min, max, minMax, stacked. key names the chart for hidden lines.
  constructor(host, spec, key) {
    this.host = host; this.spec = spec; this.key = key;
    this.u = null; this.sig = ''; this.raw = []; this.refs = [];
    this.t0 = 0; this.t1 = 0; this.maxValue = undefined;
    this.lines = []; this.common = {};
    // Hover: the line under the cursor (uPlot's focus), the popup and the dot
    // on the line. ↑ and ↓ step through the lines of the popup list.
    this.focus = null; this.hover = false; this.rows = [];
    this.tip = new Tip(spec.tipLines);
    this.onKey = e => this.stepFocus(e);
    this.ro = new ResizeObserver(() => {
      if (!this.u) return;
      this.u.setSize(this.size());
      if (this.legend) this.fitLegend();
    });
    this.ro.observe(host);
  }

  size() { return { width: Math.max(160, this.host.clientWidth), height: 150 }; }

  // lines: [{label, points (Points), color?, band?: 'hi'|'lo'}]; t0, t1 in ms; refs: [{label, value}].
  // A line may carry `about` for the hover popup: {field, tags, of, how}.
  // common: the tags all lines share.
  update({ lines, common = {}, t0, t1, refs = [], maxValue }) {
    this.t0 = t0 / 1000; this.t1 = t1 / 1000; this.refs = refs; this.maxValue = maxValue;
    this.lines = lines; this.common = common;
    const step = chartStep(lines);
    const tables = lines.map(l => table(l.points, step));
    let data = tables.length === 1 ? tables[0] : tables.length ? uPlot.join(tables) : [[], []];
    this.raw = data;
    const sig = lines.map(l => `${l.label}:${l.band || ''}:${l.color ?? ''}`).join('|');
    if (!this.u || sig !== this.sig) {
      this.sig = sig;
      this.build(lines);
    } else {
      this.u.setData(this.stacked().data, true);
      // A legend built before any point came is in no order: sort it now.
      if (this.legendUnsorted && this.raw.slice(1).some(a => a.some(v => v != null))) this.buildLegend();
    }
    this.fillLegend();
  }

  // slide moves the time axis to t0..t1 (ms) and keeps the lines: the view
  // calls it when no line got new points since the last update. A move of
  // less than a pixel is not drawn.
  slide(t0, t1) {
    if (this.u) {
      const px = (t1 / 1000 - this.t1) * this.u.bbox.width / (devicePixelRatio || 1) / Math.max(1, this.t1 - this.t0);
      if (Math.abs(px) < 1 && Math.abs((t1 - t0) - (this.t1 - this.t0) * 1000) < 1) return;
    }
    this.t0 = t0 / 1000; this.t1 = t1 / 1000;
    if (this.u) this.u.setScale('x', { min: this.t0, max: this.t1 });
  }

  // shown tells for each line whether it is drawn: by the chart once it is
  // built, by the hidden lines remembered for this chart before.
  shown() {
    return [true, ...this.lines.map((l, k) => this.u ? this.u.series[k + 1].show : !isHidden(this.key, l.label))];
  }

  // stacked is what the chart draws: the raw data, or on a stacked chart the
  // drawn lines on top of each other and the layers between them.
  stacked() {
    if (!this.spec.stacked) return { data: this.raw, bands: [] };
    return stack(this.raw, this.shown());
  }

  // restack draws a stacked chart again after a line was hidden or shown:
  // the lines above it move down or up.
  restack() {
    if (!this.spec.stacked) return;
    const { data, bands } = this.stacked();
    this.u.delBand();
    for (const [a, b] of bands) this.u.addBand({ series: [a, b], fill: this.colors[a] + '40' });
    this.u.setData(data, true);
  }

  // ---------- legend ----------
  // The chart's own legend, the lines with the highest peak first: compact
  // (one row of items and "+N ▾" for the rest, the default) or expanded (all
  // lines in an even grid, "less ▴"). A legend that fits in one row has no
  // button. A click on an item hides or shows its line. Values follow the
  // cursor, or show the newest value of each line.

  buildLegend() {
    if (this.legend) this.legend.remove();
    const el = document.createElement('div');
    el.className = 'legend ' + (isExpanded(this.key) ? 'expanded' : 'compact');
    const time = document.createElement('span');
    time.className = 'lt';
    const items = document.createElement('div');
    items.className = 'items';
    const more = document.createElement('button');
    more.className = 'more';
    more.addEventListener('click', () => {
      setExpanded(this.key, !isExpanded(this.key));
      this.buildLegend();
      this.fillLegend();
    });
    el.append(time, items, more);
    this.host.append(el);
    this.legend = el;
    this.legendTime = time;
    this.legendMore = more;
    // The lines with the highest peak in the window come first. Each peak is
    // found once, not in every comparison of the sort.
    const peaks = this.raw.map(col => {
      let top = -Infinity;
      for (const v of col || []) if (v != null && v > top) top = v;
      return top;
    });
    const order = this.u.series.map((_, i) => i).slice(1).sort((a, b) => peaks[b] - peaks[a]);
    this.legendUnsorted = !order.some(i => isFinite(peaks[i]));
    this.legendItems = order.map(i => {
      const s = this.u.series[i];
      const it = document.createElement('button');
      it.className = 'li' + (s.show ? '' : ' off');
      it.setAttribute('aria-pressed', String(s.show));
      const sw = document.createElement('i');
      sw.style.background = this.colors[i];
      const lab = document.createElement('span');
      lab.className = 'lab';
      lab.textContent = s.label;
      it.title = s.label;
      const val = document.createElement('b');
      it.append(sw, lab, val);
      it.addEventListener('click', () => {
        this.u.setSeries(i, { show: !this.u.series[i].show });
        it.classList.toggle('off', !this.u.series[i].show);
        it.setAttribute('aria-pressed', String(this.u.series[i].show));
        this.restack();
      });
      items.append(it);
      return { i, val, el: it };
    });
    requestAnimationFrame(() => this.fitLegend());
  }

  // fitLegend shows "+N ▾" when the compact row hides some items.
  fitLegend() {
    const items = this.legend.querySelector('.items');
    if (this.legend.classList.contains('expanded')) {
      this.legendMore.textContent = 'less ▴';
      this.legendMore.title = 'Back to one row';
      this.legendMore.hidden = false;
      return;
    }
    const bottom = items.getBoundingClientRect().bottom;
    const hidden = [...items.children].filter(c => c.getBoundingClientRect().top >= bottom - 1).length;
    this.legendMore.hidden = hidden === 0;
    this.legendMore.textContent = `+${hidden} ▾`;
    this.legendMore.title = `Show all ${items.children.length} lines`;
  }

  // fillLegend writes the values at the cursor, or the newest value of each line.
  fillLegend() {
    const u = this.u;
    if (!u || !this.legend) return;
    const unit = this.spec.unit || '';
    const idx = u.cursor.idx;
    this.legendTime.textContent = idx != null && u.data[0][idx] != null ? clock(u.data[0][idx], true) : 'now';
    for (const { i, val } of this.legendItems) {
      const col = this.raw[i] || [];
      let k = idx;
      if (k == null) for (k = col.length - 1; k >= 0 && col[k] == null; k--);
      val.textContent = fmt(unit, k != null && k >= 0 ? col[k] : undefined);
    }
  }

  build(lines) {
    if (this.u) this.u.destroy();
    this.u = null; // shown() reads the remembered hidden lines until the new chart exists
    const { data, bands: layers } = this.stacked();
    const colors = palette(), unit = this.spec.unit || '';
    const grid = css('--grid'), faint = css('--faint');
    const series = [{ value: (u, v) => v == null ? '–' : clock(v, true) }];
    const bands = [];
    // The legend takes each line's colour from here: uPlot fills its own
    // series._stroke only when it first draws, after the legend is built.
    this.colors = [null];
    lines.forEach((l, i) => {
      const color = colors[(l.color ?? i) % colors.length];
      this.colors.push(color);
      const s = {
        label: l.label,
        stroke: color,
        width: l.band ? 0.5 : 1.5,
        show: !isHidden(this.key, l.label),
        points: { show: false },
        // The legend shows the reading itself, also on a stacked chart.
        value: (u, v, si, idx) => fmt(unit, idx == null ? v : this.raw[si]?.[idx] ?? v),
      };
      if (lines.length === 1 && !l.band) s.fill = color + '1f';
      series.push(s);
      if (l.band === 'hi' && lines[i + 1]?.band === 'lo') bands.push({ series: [i + 1, i + 2], fill: color + '33' });
    });
    for (const [a, b] of layers) bands.push({ series: [a, b], fill: this.colors[a] + '40' });
    const opts = {
      ...this.size(),
      series,
      bands,
      scales: {
        x: { time: true, range: () => [this.t0, this.t1] },
        y: { range: (u, lo, hi) => this.yRange(lo, hi) },
      },
      axes: [
        { stroke: faint, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 }, values: (u, ticks) => ticks.map(t => clock(t, false)) },
        { stroke: faint, size: axisWidth, grid: { stroke: grid, width: 1 }, ticks: { show: false }, ...(axisIncrs(unit) ? { incrs: axisIncrs(unit) } : {}),  values: (u, ticks) => valueLabels(unit, ticks) },
      ],
      // focus: the line nearest to the cursor in y is the one under it, at
      // any distance (prox); the others fade. hover.prox: a line with no
      // point right under the cursor uses its nearest point within 16 px.
      focus: { alpha: 0.2 },
      cursor: {
        sync: { key: 'hostdash', setSeries: false },
        drag: { x: false, y: false, setScale: false },
        focus: { prox: Infinity },
        hover: { prox: 16 },
        points: { show: false },
      },
      legend: { show: false },
      hooks: {
        setSeries: [(u, i, o) => {
          if (i != null && o && 'show' in o) setHidden(this.key, u.series[i].label, !o.show);
          if (o && o.focus) this.focus = i;
        }],
        draw: [u => this.drawRefs(u)],
        setCursor: [() => { this.fillLegend(); this.showTip(); }],
      },
    };
    this.u = new uPlot(opts, data, this.host);
    this.dot = $('div', 'tip-dot');
    this.u.over.append(this.dot);
    this.u.over.addEventListener('mouseenter', () => { this.hover = true; addEventListener('keydown', this.onKey); });
    this.u.over.addEventListener('mouseleave', () => {
      this.hover = false;
      removeEventListener('keydown', this.onKey);
      this.tip.hide();
      this.dot.hidden = true;
      this.markLegend(null);
    });
    this.buildLegend();
  }

  // ---------- hover ----------

  // showTip fills the popup for the cursor's moment, when the cursor is on
  // this chart (other charts only follow its time).
  showTip() {
    const u = this.u;
    const idx = u?.cursor.idx;
    if (!this.hover || idx == null) { this.tip.hide(); this.dot.hidden = true; return; }
    const at = i => u.cursor.idxs?.[i] ?? idx;
    this.rows = tipRows(this.lines.map((l, k) => {
      const i = k + 1;
      const shown = u.series[i].show;
      return { i, label: l.label, color: this.colors[i], about: l.about,
        value: shown ? this.raw[i]?.[at(i)] ?? null : null, drawn: shown ? u.data[i]?.[at(i)] ?? null : null };
    }));
    let focus = this.focus;
    if (!this.rows.some(r => r.i === focus)) focus = this.rows[0]?.i ?? null;
    const box = u.over.getBoundingClientRect(), unit = this.spec.unit || '';
    this.tip.show({
      x: box.left + u.cursor.left, y: box.top + u.cursor.top,
      time: clock(u.data[0][idx], true), rows: this.rows, focus, common: this.common,
      text: v => fmt(unit, v),
    });
    // The dot sits on the line under the cursor (on a stacked chart, on its top).
    const j = focus == null ? null : at(focus), y = j == null ? null : u.data[focus][j];
    this.dot.hidden = y == null;
    if (y != null) {
      this.dot.style.left = u.valToPos(u.data[0][j], 'x') + 'px';
      this.dot.style.top = u.valToPos(y, 'y') + 'px';
      this.dot.style.borderColor = this.colors[focus];
    }
    this.markLegend(focus);
  }

  // stepFocus moves the line under the cursor up (↑) or down (↓) the popup
  // list, for lines that lie on top of each other. The next mouse move picks
  // the nearest line again.
  stepFocus(e) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' || this.rows.length < 2) return;
    e.preventDefault();
    const k = this.rows.findIndex(r => r.i === this.focus);
    const next = this.rows[Math.min(this.rows.length - 1, Math.max(0, (k < 0 ? 0 : k) + (e.key === 'ArrowUp' ? -1 : 1)))];
    this.u.setSeries(next.i, { focus: true });
    this.showTip();
  }

  // markLegend underlines the legend item of the line under the cursor.
  markLegend(focus) {
    for (const { i, el } of this.legendItems || []) el.classList.toggle('focus', i === focus);
  }

  yRange(dmin, dmax) {
    return yBounds(this.spec, this.spec.max ?? this.maxValue, dmin, dmax);
  }

  // drawRefs draws dashed reference lines such as a power cap or the core count.
  drawRefs(u) {
    if (!this.refs.length) return;
    const ctx = u.ctx, b = u.bbox, dpr = devicePixelRatio || 1, color = css('--ref');
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    for (const r of this.refs) {
      if (r.value == null) continue;
      const y = Math.round(u.valToPos(r.value, 'y', true)) + 0.5;
      if (y < b.top || y > b.top + b.height) continue;
      ctx.beginPath(); ctx.moveTo(b.left, y); ctx.lineTo(b.left + b.width, y); ctx.stroke();
      if (r.label) ctx.fillText(r.label, b.left + 4 * dpr, y - 3 * dpr);
    }
    ctx.restore();
  }

  destroy() {
    this.ro.disconnect();
    this.tip.destroy();
    removeEventListener('keydown', this.onKey);
    if (this.u) this.u.destroy();
    if (this.legend) this.legend.remove();
    this.u = null;
  }
}
