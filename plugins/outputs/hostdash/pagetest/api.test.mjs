// node --test plugins/outputs/hostdash/pagetest
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Data, decode } from '../page/api.js';

// pack is the columns of /api/series for points: the first time, then the steps.
const pack = pts => ({ t: pts.map((p, i) => i ? p[0] - pts[i - 1][0] : p[0]), v: pts.map(p => p[1]) });

// feed is a fake hostdash process that started at start: series of
// measurements, each point with the write it came in. It answers
// /api/series like the plugin: a series new to the asker whole, then the
// points of the writes after the asker's seq, the times once per
// measurement when its series share them. asked keeps the m parameters.
function feed(start) {
  const f = { start, seq: 0, ms: {}, asked: [], params: [] };
  f.write = (m, id, ...pts) => {
    f.seq++;
    const s = ((f.ms[m] ??= {})[id] ??= { created: f.seq, pts: [] });
    for (const p of pts) {
      const at = s.pts.findIndex(q => q[0] >= p[0]);
      if (at >= 0) s.pts.splice(at); // the same moment again: it replaces
      s.pts.push([p[0], p[1], f.seq]);
    }
  };
  f.fetch = async url => {
    const q = new URL(url, 'http://x/').searchParams.getAll('m');
    f.asked.push(q);
    const series = {};
    for (const item of q) {
      const i = item.lastIndexOf(':'), m = item.slice(0, i), since = +item.slice(i + 1);
      const s = {};
      for (const [id, sr] of Object.entries(f.ms[m] || {})) {
        const full = since < sr.created, pts = full ? sr.pts : sr.pts.filter(p => p[2] > since);
        if (!full && !pts.length) continue;
        s[id] = { ...pack(pts), ...(full ? { full: true } : {}) };
      }
      if (!Object.keys(s).length) continue;
      const ts = Object.values(s).map(c => JSON.stringify(c.t));
      if (ts.every(t => t === ts[0])) {
        for (const c of Object.values(s)) delete c.t;
        series[m] = { t: JSON.parse(ts[0]), s };
      } else {
        series[m] = { s };
      }
    }
    f.params.push(new URL(url, 'http://x/').searchParams);
    return { ok: true, json: async () => ({ now: 0, version: 1, start: f.start, seq: f.seq, series, count: 3, silent: false, statuses: [{ id: 'CPU/cpu', status: 'ok' }] }) };
  };
  return f;
}

const pairs = (d, id) => d.pts.get(id).pairs();

test('times of /api/series: the first time, then the steps', () => {
  assert.deepEqual(decode([1000, 10000, 10000]), [1000, 11000, 21000]);
  assert.deepEqual(decode([]), []);
});

test('the page asks by measurement with the seq of its last reply, and gets only what is new', async () => {
  const f = feed(1);
  globalThis.fetch = f.fetch;
  f.write('cpu', 1, [1000, 1], [11000, 2]);
  f.write('cpu', 2, [1000, 5]);
  const d = new Data();
  await d.fetch(['cpu']);
  assert.deepEqual(f.asked.at(-1), ['cpu:0'], 'whole at first');
  assert.deepEqual(pairs(d, 1), [[1000, 1], [11000, 2]]);

  f.write('cpu', 1, [21000, 3]);
  await d.fetch(['cpu', 'mem']);
  assert.deepEqual(f.asked.at(-1), ['cpu:2', 'mem:0'], 'one entry per measurement, not per series');
  assert.deepEqual(pairs(d, 1).map(p => p[0]), [1000, 11000, 21000]);
  assert.deepEqual(pairs(d, 2), [[1000, 5]], 'series 2 got nothing and keeps its points');
});

test('a point of the same moment again replaces the one of the page; a full series replaces all', () => {
  const d = new Data();
  d.merge({ series: { cpu: { s: { 1: { ...pack([[1000, 1], [11000, 2]]), full: true } } } } });
  d.merge({ series: { cpu: { s: { 1: pack([[11000, 2.5], [21000, 3]]) } } } });
  assert.deepEqual(pairs(d, 1), [[1000, 1], [11000, 2.5], [21000, 3]]);
  d.merge({ series: { cpu: { s: { 1: { ...pack([[30000, 9]]), full: true } } } } });
  assert.deepEqual(pairs(d, 1), [[30000, 9]]);
  d.merge({ series: { cpu: { s: { 7: { text: 'P2' } } } } });
  assert.equal(d.texts.get(7), 'P2');
});

test('a restarted server: what the page has is dropped and asked again whole', async () => {
  const d = new Data();
  const one = feed(100);
  one.write('system', 7, [1000, 1.2], [3000, 1.1]); // id 7 is load1
  globalThis.fetch = one.fetch;
  assert.equal(await d.fetch(['system']), 1);
  // Process 2 after a deploy: id 7 is now load5, and the writes count again.
  const two = feed(200);
  two.write('system', 7, [9000, 0.5], [19000, 0.6]);
  globalThis.fetch = two.fetch;
  assert.equal(await d.fetch(['system']), null, 'the reply of the new process is not merged');
  assert.equal(d.pts.size, 0);
  assert.equal(await d.fetch(['system']), 1);
  assert.deepEqual(two.asked.at(-1), ['system:0']);
  assert.deepEqual(pairs(d, 7), [[9000, 0.5], [19000, 0.6]], 'fetched whole, nothing of load1 left');
});

test('changedSince: a measurement counts as changed only after a reply with its changes', async () => {
  const f = feed(1);
  globalThis.fetch = f.fetch;
  f.write('cpu', 1, [1000, 1]);
  f.write('mem', 2, [1000, 5]);
  const d = new Data();
  await d.fetch(['cpu', 'mem']);
  const drawn = d.seq;
  await d.fetch(['cpu', 'mem']);
  assert.equal(d.changedSince('cpu', drawn), false, 'a poll without changes changes nothing');
  f.write('cpu', 1, [11000, 2]);
  await d.fetch(['cpu', 'mem']);
  assert.equal(d.changedSince('mem', drawn), false, 'mem got nothing');
  assert.equal(d.changedSince('cpu', drawn), true);
  // A new server process: every measurement counts as changed.
  const later = d.seq;
  globalThis.fetch = feed(2).fetch;
  await d.fetch(['cpu']);
  assert.equal(d.changedSince('mem', later), true);
});

test('a request waits for the writes after the last reply, and brings the statuses', async () => {
  const f = feed(1);
  globalThis.fetch = f.fetch;
  f.write('cpu', 1, [1000, 1]);
  const d = new Data();
  d.layout = { windowMs: 3600e3, statuses: [], series: 0, silent: true };
  await d.fetch(['cpu'], { wait: 25 });
  assert.equal(f.params.at(-1).get('after'), '0');
  assert.equal(f.params.at(-1).get('wait'), '25');
  f.write('cpu', 1, [11000, 2]);
  await d.fetch(['cpu'], { wait: 25 });
  assert.equal(f.params.at(-1).get('after'), '1', 'the seq of the last reply');
  assert.deepEqual(d.layout.statuses, [{ id: 'CPU/cpu', status: 'ok' }]);
  assert.equal(d.layout.series, 3);
  assert.equal(d.layout.silent, false);
  await d.fetch([]);
  assert.equal(f.params.at(-1).get('wait'), null, 'no wait: an answer at once');
});

test('times shared by the series of a measurement come once', () => {
  const d = new Data();
  d.merge({ series: { cpu: { t: [1000, 10000], s: { 1: { v: [1, 2], full: true }, 2: { v: [5, 6], full: true } } } } });
  assert.deepEqual(pairs(d, 1), [[1000, 1], [11000, 2]]);
  assert.deepEqual(pairs(d, 2), [[1000, 5], [11000, 6]]);
});

test('changedFrom: the first changed time since a merge, or all of it when not known', () => {
  const d = new Data();
  d.merge({ series: { cpu: { s: { 1: { ...pack([[1000, 1], [11000, 2]]), full: true }, 2: { ...pack([[1000, 5]]), full: true } } } } });
  const drawn = d.seq;
  assert.equal(d.changedFrom([1, 2], drawn), undefined, 'nothing after the draw');
  d.merge({ series: { cpu: { s: { 1: pack([[21000, 3]]) } } } });
  assert.equal(d.changedFrom([1, 2], drawn), 21000);
  assert.equal(d.changedFrom([2], drawn), undefined, 'only series 1 changed');
  d.merge({ series: { cpu: { s: { 1: pack([[31000, 4]]) } } } });
  assert.equal(d.changedFrom([1], drawn), -Infinity, 'two changes since: the first is not kept');
  assert.equal(d.changedFrom([1], d.seq - 1), 31000);
  d.merge({ series: { cpu: { s: { 2: { ...pack([[40000, 1]]), full: true } } } } });
  assert.equal(d.changedFrom([2], d.seq - 1), -Infinity, 'a full series changed all of it');
});

test('a new layout: the series no section names are dropped; a section whose config changed is asked whole', () => {
  const d = new Data();
  const sec = (fields, ids) => ({ id: 'CPU/cpu', page: 'CPU', measurement: 'cpu', charts: [{ title: 'x', fields }],
    groups: ids.map((id, i) => ({ tags: { cpu: String(i) }, series: { [fields[0]]: id } })) });
  d.apply({ tabs: [{ id: 'CPU', sections: [sec(['user'], [1, 2])] }] });
  d.merge({ series: { cpu: { s: { 1: { ...pack([[1000, 1]]), full: true }, 2: { ...pack([[1000, 2]]), full: true } } } } });
  d.since.set('cpu', 9);
  d.apply({ tabs: [{ id: 'CPU', sections: [sec(['user'], [1])] }] });
  assert.deepEqual([...d.pts.keys()], [1], 'series 2 is gone from the layout');
  assert.equal(d.since.get('cpu'), 9, 'a group less is no change of the config');
  d.apply({ tabs: [{ id: 'CPU', sections: [sec(['system'], [1])] }] });
  assert.equal(d.since.has('cpu'), false, 'another field: asked whole');
});
