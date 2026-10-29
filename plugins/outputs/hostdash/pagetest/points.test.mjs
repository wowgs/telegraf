// node --test plugins/outputs/hostdash/pagetest
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Points } from '../page/points.js';
import { Combined, latest, peak, table } from '../page/combine.js';
import { Data } from '../page/api.js';

test('Points: push, the same time again replaces, trim, from', () => {
  const p = Points.of([[1000, 1], [2000, 2], [3000, 3]]);
  p.push(2000, 9);
  assert.deepEqual(p.pairs(), [[1000, 1], [2000, 9]], 'a time not after the last drops the points from it on');
  p.push(4000, 4);
  assert.equal(p.from(2500), 2);
  assert.equal(p.from(0), 0);
  assert.equal(p.from(5000), 3);
  p.trim(2000);
  assert.deepEqual(p.pairs(), [[2000, 9], [4000, 4]]);
  assert.equal(p.lastTime(), 4000);
  assert.equal(p.lastValue(), 4);
});

test('Points: a sliding window keeps the arrays near its size', () => {
  const p = new Points();
  let maxCap = 0;
  for (let t = 0; t < 100000; t++) {
    p.push(t * 1000, t);
    p.trim((t - 359) * 1000);
    maxCap = Math.max(maxCap, p.t.length);
  }
  assert.equal(p.length, 360);
  assert.ok(maxCap <= 1024, `capacity ${maxCap}`);
});

test('table: a line of 2 points breaks at a pause by the step of the other lines', () => {
  const two = Points.of([[0, 1], [3600e3, 2]]);
  assert.deepEqual(table(two)[1], [1, 2], 'no step known: no break');
  assert.deepEqual(table(two, 10000)[1], [1, null, 2]);
});

test('peak and latest', () => {
  const p = Points.of([[0, 5], [1000, 1], [2000, 3]]);
  assert.equal(peak(p, 500), 3);
  assert.equal(latest([p, Points.of([[2100, 7]])], 'sum'), 10);
});

// The page combines lines again only from the first changed time. Random
// writes, as a server sends them (new points, the last point again with a
// new value, series that start again whole), must give the same lines as
// combining all of it after every write.
test('incremental combining equals combining all of it', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pack = pts => ({ t: pts.map((p, i) => i ? p[0] - pts[i - 1][0] : p[0]), v: pts.map(p => p[1]) });
  const ids = [1, 2, 3, 4];
  const last = new Map(ids.map(id => [id, 0]));
  for (const agg of ['avg', 'sum', 'min', 'max', 'band']) {
    const d = new Data();
    d.layout = { windowMs: 60e3 };
    const inc = new Combined(agg);
    let drawn = -1;
    for (let w = 0; w < 300; w++) {
      const s = {};
      for (const id of ids) {
        if (rnd() < 0.3) continue;
        let t = last.get(id);
        const pts = [];
        if (rnd() < 0.2 && t) pts.push([t, rnd()]); // the last point again
        for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) pts.push([t += 1000 + Math.floor(rnd() * 400) - 200, rnd()]);
        last.set(id, t);
        s[id] = { ...pack(pts), ...(rnd() < 0.05 ? { full: true } : {}) };
      }
      d.merge({ series: { m: { s } } });
      const now = Math.max(...last.values()), cutoff = now - 60e3;
      const from = drawn < 0 ? -Infinity : d.changedFrom(ids, drawn);
      // Two writes between draws, sometimes: the page was busy.
      if (rnd() < 0.2 && from !== -Infinity) continue;
      if (from !== undefined) inc.update(ids.map(id => d.pts.get(id)), from, cutoff);
      drawn = d.seq;
      const all = new Combined(agg).update(ids.map(id => d.pts.get(id)), -Infinity, cutoff);
      for (const k of Object.keys(all.out)) assert.deepEqual(inc.out[k].pairs(), all.out[k].pairs(), `${agg} ${k} after write ${w}`);
    }
  }
});
