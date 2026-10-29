// Tag filtering and grouping of series, tiles, and the page state in the
// URL. Pure functions: no DOM, tested by pagetest/*.test.mjs.

import { AGGS } from './combine.js';

// naturalCompare orders digit runs as numbers: "cpu2" < "cpu10". Names
// equal as numbers ("x01", "x1") are ordered as plain strings, so the order
// never depends on the input. Mirrors naturalLess in layout.go.
export function naturalCompare(a, b) {
  a = String(a); b = String(b);
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) || [], pb = b.match(re) || [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) {
      const tx = x.replace(/^0+/, ''), ty = y.replace(/^0+/, '');
      if (tx.length !== ty.length) return tx.length - ty.length;
      if (tx !== ty) return tx < ty ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// tagValues lists, for every tag whose value differs between the groups, its
// values in natural order. A group without the tag has the value "".
export function tagValues(groups) {
  return new Map([...allTagValues(groups)].filter(([, vals]) => vals.length > 1));
}

// allTagValues lists every tag of the groups with its values in natural order,
// including tags with one value. A group without the tag has the value "".
export function allTagValues(groups) {
  const keys = new Set();
  for (const g of groups) for (const k of Object.keys(g.tags)) keys.add(k);
  const out = new Map();
  for (const k of [...keys].sort()) out.set(k, [...new Set(groups.map(g => g.tags[k] ?? ''))].sort(naturalCompare));
  return out;
}

// tagText writes tags in full: "cpu=cpu3 die=0".
export const tagText = tags => Object.entries(tags || {}).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' ');

// tipRows orders the lines at one moment for the hover popup: the highest
// first, so the list runs top to bottom like the lines on the chart. Each row
// is placed by where its line is drawn (drawn: on a stacked chart, the top of
// its layer) and shows its own value. Lines without a value there (hidden,
// or no point) are left out.
export function tipRows(rows) {
  const y = r => r.drawn ?? r.value;
  return rows.filter(r => r.value != null).sort((a, b) => y(b) - y(a) || naturalCompare(a.label, b.label));
}

// tipWindow picks the rows of the hover popup: at most k of n rows, the row
// at focus in the middle where it can be. It returns [from, to).
export function tipWindow(n, focus, k) {
  if (n <= k) return [0, n];
  const from = Math.min(Math.max(0, focus - (k >> 1)), n - k);
  return [from, from + k];
}

// stack puts the lines of a stacked chart on top of each other: data is
// uPlot's [times, line 1, line 2, ...] and shown[i] tells whether line i is
// drawn. Each drawn line adds to the drawn lines before it; a hidden line
// keeps its own values and adds nothing. bands are the pairs of a drawn line
// and the drawn line below it, which the layer between them fills.
export function stack(data, shown) {
  const out = [data[0]], bands = [];
  let below = null; // the last drawn line so far, stacked
  for (let i = 1; i < data.length; i++) {
    if (!shown[i]) { out.push(data[i]); continue; }
    const line = below == null ? data[i] : data[i].map((v, k) => v == null ? v : v + (out[below][k] ?? 0));
    if (below != null) bands.push([i, below]);
    out.push(line);
    below = i;
  }
  return { data: out, bands };
}

// matchValue compares a tag value with a pattern where * matches anything.
export function matchValue(value, pattern) {
  if (!pattern.includes('*')) return value === pattern;
  const re = new RegExp('^' + pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

// filterGroups keeps the groups that pass every filter. filter maps a tag to
// {op: '=' | '!=', values: [patterns]}; a filter without values does nothing yet.
export function filterGroups(groups, filter) {
  if (!filter) return groups;
  const active = Object.entries(filter).filter(([, f]) => f.values.length);
  return groups.filter(g => active.every(([k, f]) => {
    const hit = f.values.some(p => matchValue(g.tags[k] ?? '', p));
    return f.op === '!=' ? !hit : hit;
  }));
}

// labelKeys drops from keys every tag whose value another key already decides
// (name=nvme0n1 always has the same wwid, so wwid adds nothing to a label).
// Of two keys that decide each other, the first one stays.
export function labelKeys(groups, keys) {
  const decides = (a, b) => {
    const m = new Map();
    for (const g of groups) {
      const va = g.tags[a] ?? '', vb = g.tags[b] ?? '';
      if (m.has(va) && m.get(va) !== vb) return false;
      m.set(va, vb);
    }
    return true;
  };
  return keys.filter((b, j) => !keys.some((a, i) => a !== b && decides(a, b) && (!decides(b, a) || i < j)));
}

// A grouping is how the series of a section make lines, as in PromQL:
// { mode: 'by', tags } keeps these tags and combines over the others (no
// tags: one line), { mode: 'without', tags } combines over these tags; null
// is no grouping, a line per series.

// sectionView is what a section shows: the grouping of its configuration
// (sec.group, sec.agg), or what the link holds for it (stored: filter, group,
// agg, each set only when you changed it; group null is no grouping). A
// grouping always has a function: the one stored, else the configured one,
// else fallbackAgg.
export function sectionView(sec, stored, fallbackAgg) {
  const s = stored ?? {};
  const group = s.group !== undefined ? s.group : sec.group ?? null;
  const agg = group ? s.agg ?? sec.agg ?? fallbackAgg : null;
  return { filter: s.filter ?? null, group, agg };
}

const sameGroup = (a, b) => (a?.mode ?? '') === (b?.mode ?? '') && (a?.tags ?? []).join('\u0000') === (b?.tags ?? []).join('\u0000');

// storedFor is what the link keeps of a section's view: only what differs
// from its configuration. null: the section shows its configuration.
export function storedFor(sec, view, fallbackAgg) {
  const conf = sectionView(sec, null, fallbackAgg);
  const out = {};
  if (view.filter && Object.keys(view.filter).length) out.filter = view.filter;
  if (!sameGroup(view.group, conf.group)) out.group = view.group ?? null;
  if (view.group && view.agg !== sectionView(sec, { group: view.group }, fallbackAgg).agg) out.agg = view.agg;
  return Object.keys(out).length ? out : null;
}

// keptTags are the tags whose values tell the lines apart: with by its tags,
// with without all the other tags, without a grouping all of them.
export function keptTags(tags, group) {
  const all = [...tags.keys()];
  if (!group) return all;
  if (group.mode === 'by') return group.tags.filter(t => tags.has(t));
  return all.filter(t => !group.tags.includes(t));
}

// withGroupTag adds tag to the grouping of a view. The first tag starts a
// grouping in mode with band (min–max and the average of each line); later
// tags join the grouping in its mode, and the function stays.
export function withGroupTag(view, tag, mode = 'by') {
  if (view.group) return { ...view, group: { ...view.group, tags: [...view.group.tags, tag] } };
  return { ...view, group: { mode, tags: [tag] }, agg: view.agg ?? 'band' };
}

// withoutGroupTag takes tag out of the grouping: by without tags stays, as
// one line; without without tags is no grouping.
export function withoutGroupTag(view, tag) {
  const tags = view.group.tags.filter(t => t !== tag);
  if (view.group.mode === 'without' && !tags.length) return { ...view, group: null, agg: null };
  return { ...view, group: { ...view.group, tags } };
}

// switchMode turns by into without and back; the tags stay, their meaning
// changes, as an edit of the query would. by () stays: without no tags
// would combine nothing.
export function switchMode(view) {
  if (!view.group.tags.length) return view;
  return { ...view, group: { ...view.group, mode: view.group.mode === 'by' ? 'without' : 'by' } };
}

// bucketGroups puts groups with the same values of the kept tags into one
// bucket. With no kept tags all groups are one bucket.
export function bucketGroups(groups, keep) {
  const buckets = new Map();
  const shown = labelKeys(groups, keep);
  for (const g of groups) {
    const vals = keep.map(k => g.tags[k] ?? '');
    const key = vals.join('\u0000');
    let b = buckets.get(key);
    if (!b) {
      b = { key, label: shown.map(k => g.tags[k] ?? '').filter(v => v !== '').join(' '), tags: {}, groups: [] };
      for (const k of keep) b.tags[k] = g.tags[k] ?? '';
      buckets.set(key, b);
    }
    b.groups.push(g);
  }
  return [...buckets.values()].sort((a, b) => naturalCompare(a.label, b.label));
}

// The ways to combine the series of one line, as the group block offers them.
// band is min, max and avg at once: the chart draws the min–max range as a
// band and the average as a line; a single number (a tile, a note) is the avg.
export const AGG_NAMES = [...Object.keys(AGGS), 'band'];

// defaultAgg is the function a grouping gets when neither the configuration
// nor you chose one, by the unit of a field: rates and counts add up (B/s,
// 1/s, tok/s, count, tok), the rest is averaged (%, °C, Hz, W, B …). s/s is a
// share of time, shown as a percentage, so it is averaged too.
export function defaultAgg(unit) {
  unit = unit ?? '';
  if (unit === 's/s') return 'avg';
  return unit === 'count' || unit === 'tok' || unit.endsWith('/s') ? 'sum' : 'avg';
}

// TILE_AGGS combine the values of the groups for a tile: the first group
// (the default), the highest or the sum, as the agg of a tile in the config.
const TILE_AGGS = { first: v => v[0], max: v => Math.max(...v), sum: v => v.reduce((a, b) => a + b, 0) };

// tileValue is what a tile shows, from the series and not from the lines of
// the query bar: the latest value of its field in each group (valueOf),
// combined over the groups with the agg of the tile. Its level compares
// value/of with warn and bad, with of taken in the same group, as a check of
// the plugin does; without thresholds, or without a base, there is no level.
export function tileValue(tile, groups, valueOf) {
  const f = TILE_AGGS[tile.agg] || TILE_AGGS.first;
  const vals = [], shares = [];
  for (const g of groups) {
    const v = valueOf(g, tile.field);
    if (v == null) continue;
    vals.push(v);
    if (tile.of) {
      const base = valueOf(g, tile.of);
      if (base) shares.push(v / base);
    }
  }
  if (!vals.length) return { value: undefined, level: '' };
  const value = f(vals);
  let level = '';
  const r = tile.of ? (shares.length ? f(shares) : undefined) : value;
  if (r != null && (tile.warn != null || tile.bad != null)) {
    const worse = t => tile.below ? r < t : r >= t;
    level = tile.bad != null && worse(tile.bad) ? 'bad' : tile.warn != null && worse(tile.warn) ? 'warn' : 'ok';
  }
  return { value, level };
}

// capLines keeps at most k lines of a chart: the ones with the highest peak
// (peakOf), in their order. The three lines of a band (avg, max, min) count
// as one, by the peak of its max. It returns the lines kept and how many
// were left out.
export function capLines(lines, k, peakOf) {
  const units = [];
  for (const l of lines) {
    if (l.band === 'lo') { units[units.length - 1].lines.push(l); continue; }
    if (l.band === 'hi') { units[units.length - 1].lines.push(l); units[units.length - 1].peak = peakOf(l); continue; }
    units.push({ lines: [l], peak: peakOf(l) });
  }
  if (!(k > 0) || units.length <= k) return { lines, hidden: 0 };
  const top = new Set(units.map((u, i) => i).sort((a, b) => units[b].peak - units[a].peak || a - b).slice(0, k));
  return { lines: units.filter((u, i) => top.has(i)).flatMap(u => u.lines), hidden: units.length - k };
}

// countText is the count at the end of the query bar: the groups (tag sets)
// shown of all, and the lines they make.
export function countText(shown, total, lines) {
  return `${shown === total ? total : `${shown} of ${total}`} ${total === 1 ? 'group' : 'groups'} → ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

// The page state lives in the URL hash: #<tab>?t=<ms>&f.<sec>.<tag>=a,b*&n.<sec>.<tag>=c&g.<sec>=tag,tag&a.<sec>=max
// (f: tag is one of the values, n: tag is none of them; * is a mask; g: a
// grouping by these tags, empty for one line; w: a grouping without these
// tags; a: its function, none for no grouping). Only the sections you
// changed are in it, see storedFor; a filter without values is not.
// <sec> is the section key: its measurement. Each name part and each list
// item is percent-encoded, '.' and ',' too, so names with dots and values
// with commas come back as they were.

const enc = s => encodeURIComponent(s).replace(/\./g, '%2E');
const dec = s => { try { return decodeURIComponent(s); } catch { return null; } };
const list = items => items.map(enc).join(',');
const unlist = text => text === '' ? [] : text.split(',').map(dec);

// The part before "?" is <tab> or <tab>/<section key>, like the anchor of a
// heading in Markdown: #Load/system opens the tab Load at the section system.
// Both names are encoded, so a "/" in a tab name stays in the name.
export function parseHash(hash) {
  const raw = hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const slash = path.indexOf('/');
  const tab = dec(slash < 0 ? path : path.slice(0, slash)) ?? '';
  const section = slash < 0 ? null : dec(path.slice(slash + 1)) || null;
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const state = { tab, section, range: null, sections: {} };
  const sec = k => (state.sections[k] ??= {});
  for (const [name, value] of params) {
    const parts = name.split('.').map(dec);
    if (parts.includes(null)) continue;
    if (name === 't') {
      const v = Number(value);
      if (v > 0) state.range = v;
    } else if ((parts[0] === 'f' || parts[0] === 'n') && parts.length === 3) {
      // A filter keeps at least one value: "" is the value "", not none.
      const values = value === '' ? [''] : unlist(value);
      if (values.includes(null)) continue;
      (sec(parts[1]).filter ??= {})[parts[2]] = { op: parts[0] === 'n' ? '!=' : '=', values };
    } else if ((parts[0] === 'g' || parts[0] === 'w') && parts.length === 2) {
      // g: by (an empty list is one line), w: without.
      const tags = unlist(value);
      if (!tags.includes(null) && (parts[0] === 'g' || tags.length)) sec(parts[1]).group = { mode: parts[0] === 'g' ? 'by' : 'without', tags };
    } else if (parts[0] === 'a' && parts.length === 2) {
      // none: no grouping, also where the configuration groups.
      if (value === 'none') { if (sec(parts[1]).group === undefined) sec(parts[1]).group = null; }
      else if (AGG_NAMES.includes(value)) sec(parts[1]).agg = value;
    }
  }
  return state;
}

export function formatHash(state) {
  const params = new URLSearchParams();
  if (state.range) params.set('t', String(state.range));
  for (const [k, s] of Object.entries(state.sections).sort()) {
    for (const [tag, f] of Object.entries(s.filter || {}).sort()) {
      if (f.values.length) params.set(`${f.op === '!=' ? 'n' : 'f'}.${enc(k)}.${enc(tag)}`, list(f.values));
    }
    if (s.group === null) params.set(`a.${enc(k)}`, 'none');
    if (s.group) params.set(`${s.group.mode === 'by' ? 'g' : 'w'}.${enc(k)}`, list(s.group.tags));
    // The function alone is kept too: a changed function of the configured grouping.
    if (s.group !== null && s.agg) params.set(`a.${enc(k)}`, s.agg);
  }
  const q = params.toString();
  const at = state.section ? '/' + encodeURIComponent(state.section) : '';
  return '#' + encodeURIComponent(state.tab || 'overview') + at + (q ? '?' + q : '');
}

// worstStatus is the worst of the statuses by order, from the best to the
// worst, as the layout of the plugin gives it (statusOrder). A tab shows the
// worst of its sections.
export const worstStatus = (list, order) => list.reduce((w, s) => order.indexOf(s) > order.indexOf(w) ? s : w, order[0] ?? 'ok');

// overviewBlocks puts the statuses of the sections under their tabs. The
// server sends them in the order of the config, so the tabs and their
// sections come in the order they have on the page, also a tab or section
// that has no data yet. Each block has the worst status of its sections.
export function overviewBlocks(statuses, order) {
  const byPage = new Map();
  for (const sec of statuses || []) {
    if (!byPage.has(sec.page)) byPage.set(sec.page, []);
    byPage.get(sec.page).push(sec);
  }
  return [...byPage].map(([page, sections]) => ({ page, status: worstStatus(sections.map(x => x.status), order), sections }));
}
