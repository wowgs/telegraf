// The points of one series, or of one combined line, on the page: two
// columns, times (unix ms) and values, in typed arrays with a start, as the
// plugin keeps them. A point costs 16 bytes, not an object per point. Times
// grow; the same time again replaces the point. Pure: tested by
// pagetest/points.test.mjs.

export class Points {
  constructor(cap = 8) {
    this.t = new Float64Array(cap);
    this.v = new Float64Array(cap);
    this.lo = 0; // the first point
    this.hi = 0; // after the last point
  }

  // of makes points from [[t, v], ...].
  static of(pairs) {
    const p = new Points(Math.max(8, pairs.length));
    for (const [t, v] of pairs) p.push(t, v);
    return p;
  }

  get length() { return this.hi - this.lo; }
  time(i) { return this.t[this.lo + i]; }
  value(i) { return this.v[this.lo + i]; }
  lastTime() { return this.hi > this.lo ? this.t[this.hi - 1] : undefined; }
  lastValue() { return this.hi > this.lo ? this.v[this.hi - 1] : undefined; }

  // from is the index of the first point at or after time t.
  from(t) {
    let a = this.lo, b = this.hi;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.t[m] < t) a = m + 1; else b = m;
    }
    return a - this.lo;
  }

  // cut drops the points from index i on.
  cut(i) { this.hi = this.lo + Math.max(0, Math.min(i, this.length)); }

  // push appends a point; a time not after the last one drops the points
  // from it on first (a reading of the same moment again replaces it).
  push(t, v) {
    if (this.hi > this.lo && t <= this.t[this.hi - 1]) this.cut(this.from(t));
    if (this.hi === this.t.length) this.room();
    this.t[this.hi] = t;
    this.v[this.hi] = v;
    this.hi++;
  }

  // room makes space for one more point: the points move to the front of
  // the arrays when half of them is free, else the arrays double.
  room() {
    const n = this.length;
    const cap = this.lo >= n ? this.t.length : 2 * this.t.length;
    this.resize(cap);
  }

  resize(cap) {
    const n = this.length;
    const t = cap === this.t.length ? this.t : new Float64Array(cap);
    const v = cap === this.v.length ? this.v : new Float64Array(cap);
    if (t === this.t) { t.copyWithin(0, this.lo, this.hi); v.copyWithin(0, this.lo, this.hi); }
    else { t.set(this.t.subarray(this.lo, this.hi)); v.set(this.v.subarray(this.lo, this.hi)); }
    this.t = t; this.v = v; this.lo = 0; this.hi = n;
  }

  // trim drops the points before cutoff; arrays much larger than what is
  // left shrink, so a series that got fewer points gives the memory back.
  trim(cutoff) {
    this.lo += this.from(cutoff);
    const n = this.length;
    if (this.t.length > 2 * n + 64) this.resize(Math.max(8, n + (n >> 1)));
  }

  // pairs is [[t, v], ...]: for the tests.
  pairs() {
    const out = [];
    for (let i = this.lo; i < this.hi; i++) out.push([this.t[i], this.v[i]]);
    return out;
  }
}
