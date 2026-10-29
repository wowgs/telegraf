// Talks to the plugin: one request for changes waits on the server for the
// next write and brings the changes of the measurements on screen and the
// statuses; the layout comes only when it is new.

import { Points } from './points.js';

// Counters, statuses and the layout version change with the writes and are
// updated in place; only the rest of the layout decides what the page
// rebuilds.
const VOLATILE = new Set(['series', 'silent', 'status', 'version']);
// The reasons of a status are a list, with the values that crossed a check.
const VOLATILE_LISTS = new Set(['reasons']);

// shapeOf is the part of a layout (or of one section) that the page is built
// from: all of it but the volatile values. Of the keys in VOLATILE only plain
// values are volatile: the series of a group (field → id) share the name of
// the series count but name the points a chart draws, so they stay.
export const shapeOf = x => JSON.stringify(x, (k, v) =>
  VOLATILE_LISTS.has(k) || (VOLATILE.has(k) && typeof v !== 'object') ? undefined : v);

// configShape is the part of a section that its config decides: all of it
// but its groups. When it changes, the fields the server sends for the
// measurement may have changed too.
const configShape = sec => shapeOf({ ...sec, groups: undefined });

// sections lists the sections of a layout.
const sectionsOf = layout => (layout?.tabs || []).flatMap(t => t.sections || []);

// decode turns the times of /api/series into unix ms: the first time, then
// the step to each next point.
export function decode(steps) {
  const out = new Array(steps.length);
  let t = 0;
  for (let i = 0; i < steps.length; i++) out[i] = t += steps[i];
  return out;
}

export class Data {
  constructor() {
    this.layout = null;
    this.pts = new Map();     // series id -> Points
    this.texts = new Map();   // series id -> latest text
    this.since = new Map();   // measurement -> the server's write seq its last reply was made at
    this.now = Date.now();    // server time of the last reply
    this.nowAt = Date.now();  // when it came, by the page's clock
    this.after = 0;           // seq of the last reply: a request waits for writes after it
    this.shape = '';
    this.start = null;        // start of the server process the points belong to
    // What changed, for views that redraw only then: seq counts the merges,
    // changedAt is the merge that last brought a measurement changes, and
    // resetAt the merge after which every measurement counts as changed.
    // changes keeps per series the merge of its last change, the one
    // before, and the first time that change sent (-Infinity: all of it).
    this.seq = 0;
    this.changedAt = new Map();
    this.resetAt = 0;
    this.changes = new Map();
  }

  // changedSince tells whether the measurement got changes after merge seq.
  changedSince(measurement, seq) {
    return this.resetAt > seq || (this.changedAt.get(measurement) ?? 0) > seq;
  }

  // changedFrom tells from which time the series changed after merge seq:
  // undefined when none did, -Infinity when it is not known (a series
  // changed twice since, or the server process changed).
  changedFrom(ids, seq) {
    if (this.resetAt > seq) return -Infinity;
    let from;
    for (const id of ids) {
      const c = this.changes.get(id);
      if (!c || c.at <= seq) continue;
      if (c.prevAt > seq) return -Infinity;
      from = Math.min(from ?? Infinity, c.from);
    }
    return from;
  }

  // sameServer keeps the points while the server process stays the same. A new
  // process (a restart, a deploy) numbers its series and writes again, so an
  // old id may now name another series: what the page has is dropped and
  // asked again whole. It tells whether the reply belongs to the process the
  // points are from.
  sameServer(start) {
    if (start === this.start) return true;
    const first = this.start === null;
    this.start = start;
    this.pts.clear();
    this.texts.clear();
    this.since.clear();
    this.after = 0;
    this.changedAt.clear();
    this.changes.clear();
    this.resetAt = ++this.seq;
    return first;
  }

  // loadLayout fetches the layout and tells whether anything but the
  // counters and statuses changed. The page asks for it only when it is new.
  async loadLayout() {
    const r = await fetch('api/layout', { cache: 'no-store' });
    if (!r.ok) throw new Error(`layout: HTTP ${r.status}`);
    const next = await r.json();
    this.sameServer(next.start);
    const shape = shapeOf(next);
    const changed = shape !== this.shape;
    this.shape = shape;
    this.apply(next);
    return changed;
  }

  // apply takes a new layout. A section whose config changed is asked
  // whole: it may show fields the page never got. The points of series
  // that no section names any more are dropped.
  apply(next) {
    const before = new Map(sectionsOf(this.layout).map(s => [s.measurement, configShape(s)]));
    const ids = new Set();
    for (const s of sectionsOf(next)) {
      const was = before.get(s.measurement);
      if (was !== undefined && was !== configShape(s)) this.since.delete(s.measurement);
      for (const g of s.groups || []) for (const id of Object.values(g.series)) ids.add(id);
    }
    for (const map of [this.pts, this.texts, this.changes]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
    this.layout = next;
  }

  // clock is the server's time now: the time of the last reply plus what
  // passed on the page since it came.
  clock() {
    return this.now + (Date.now() - this.nowAt);
  }

  // fetch gets the changes of the measurements in one request: each from
  // the write of its last reply, a new one whole. With wait (s) the server
  // holds the request until a write after the last reply, at most that
  // long; signal aborts it. It puts the statuses, the series count and
  // silent of the reply into the layout and returns the server's layout
  // version, or null when the server process changed.
  async fetch(measurements, { wait = 0, signal } = {}) {
    const q = new URLSearchParams();
    for (const m of measurements) q.append('m', `${m}:${this.since.get(m) ?? 0}`);
    q.set('after', String(this.after));
    if (wait) q.set('wait', String(wait));
    const r = await fetch(`api/series?${q}`, { cache: 'no-store', signal });
    if (!r.ok) throw new Error(`series: HTTP ${r.status}`);
    const d = await r.json();
    // A reply of a new process: drop it and return no version, so the caller
    // loads the layout again and asks for everything whole.
    if (!this.sameServer(d.start)) return null;
    this.merge(d);
    for (const m of measurements) this.since.set(m, d.seq);
    this.after = d.seq;
    this.now = d.now;
    this.nowAt = Date.now();
    if (this.layout) Object.assign(this.layout, { statuses: d.statuses, series: d.count, silent: d.silent });
    return d.version;
  }

  // merge applies the changes of a reply. A full series replaces what the
  // page has; otherwise the points from the first time sent on are replaced
  // (that point may have a new value). A measurement sends its times once
  // when all its changed series share them.
  merge(d) {
    const win = this.layout ? this.layout.windowMs : 3600e3;
    const seq = ++this.seq;
    for (const [m, mc] of Object.entries(d.series || {})) {
      this.changedAt.set(m, seq);
      const shared = mc.t ? decode(mc.t) : null;
      for (const [key, c] of Object.entries(mc.s || {})) {
        const id = +key;
        if (c.text !== undefined) { this.texts.set(id, c.text); continue; }
        const ts = c.t ? decode(c.t) : shared || [], vs = c.v || [];
        let p = this.pts.get(id);
        if (c.full || !p) this.pts.set(id, p = new Points(Math.max(8, ts.length)));
        else if (ts.length) p.cut(p.from(ts[0]));
        for (let i = 0; i < ts.length; i++) p.push(ts[i], vs[i]);
        if (p.length) p.trim(p.lastTime() - win);
        const prev = this.changes.get(id);
        this.changes.set(id, { at: seq, prevAt: prev?.at ?? 0, from: c.full ? -Infinity : ts[0] ?? Infinity });
      }
    }
  }
}
