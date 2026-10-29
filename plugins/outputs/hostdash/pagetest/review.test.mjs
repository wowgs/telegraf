// node --test plugins/outputs/hostdash/pagetest
// Cases from the code review of 2026-10-21: each failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, formatHash, defaultAgg, stack, tipRows } from '../page/model.js';
import { latest, table } from '../page/combine.js';
import { Points } from '../page/points.js';
import { combine, band } from './helpers.mjs';
import { shapeOf } from '../page/api.js';
import { fmt } from '../page/format.js';
import { yBounds } from '../page/axis.js';

test('table: one short step does not break a regular line', () => {
  const p = [];
  for (let t = 0; t <= 100000; t += 10000) p.push([t, 1]);
  p.splice(1, 0, [2000, 1]); // one 2 s step
  assert.equal(table(Points.of(p))[1].filter(v => v === null).length, 0);
  p.push([200000, 1]); // a real pause
  assert.equal(table(Points.of(p))[1].filter(v => v === null).length, 1);
});

test('combine: a series counts once per grid second', () => {
  assert.deepEqual(combine([[[10000, 5], [10300, 7]], [[10000, 1]]], 'sum'), [[10000, 8]]);
  assert.deepEqual(combine([[[0, 1], [10000, 3]], [[0, 5], [10000, 5]]], 'avg'), [[0, 3], [10000, 4]]);
});

test('band and latest agree with combine', () => {
  const s = [[[0, 1], [10000, 4]], [[0, 3], [10000, 2]], [[10000, 9]]];
  const b = band(s);
  assert.deepEqual(b.lo, combine(s, 'min'));
  assert.deepEqual(b.hi, combine(s, 'max'));
  assert.deepEqual(b.mid, combine(s, 'avg'));
  assert.equal(latest(s.map(Points.of), 'sum'), combine(s, 'sum').at(-1)[1]);
  assert.equal(latest([Points.of([])], 'sum'), undefined);
});

test('hash: names with dots, values with commas, the empty value and bad escapes', () => {
  const state = {
    tab: 'System', section: null, range: null,
    sections: {
      'cpu.x': { filter: { 'a.b': { op: '=', values: ['v,1', ''] }, dev: { op: '!=', values: [''] } }, group: { mode: 'without', tags: ['t,1', 'u'] }, agg: 'max' },
    },
  };
  assert.deepEqual(parseHash(formatHash(state)), state);
  assert.equal(parseHash('#%E0').tab, '');
  assert.doesNotThrow(() => parseHash('#System?f.cpu.%E0=x&g.%E0=%E0'));
});

test('yBounds: the top covers negative data', () => {
  const [lo, hi] = yBounds({}, undefined, -80, -50);
  assert.equal(lo, -80);
  assert.ok(hi >= -50, `top ${hi}`);
});

test('defaultAgg takes a missing unit', () => {
  assert.equal(defaultAgg(null), 'avg');
  assert.equal(defaultAgg(undefined), 'avg');
});

test('fmt picks the unit after rounding', () => {
  const cases = [
    ['', 999.99, '1.0k'], ['', 1e13, '10.00T'], ['B', 1048575, '1.0 MiB'], ['B', 500, '500 B'],
    ['', -0.001, '0.00'], ['s', -5, '-5 s'], ['s', -90000, '-1d 1h'], ['Hz', 999600000, '1.00 GHz'],
    ['count', -12345, '-12k'], ['', 9999.6, '10k'], ['', 999999, '1.00M'], ['B/s', 1536, '1.5 KiB/s'],
  ];
  for (const [unit, v, want] of cases) assert.equal(fmt(unit, v), want, `${unit} ${v}`);
});

test('stack: a hidden line adds nothing and the layers skip it', () => {
  const data = [[0, 1], [1, 2], [10, 20], [100, null]];
  assert.deepEqual(stack(data, [true, true, true, true]),
    { data: [[0, 1], [1, 2], [11, 22], [111, null]], bands: [[2, 1], [3, 2]] });
  const r = stack(data, [true, true, false, true]);
  assert.deepEqual(r.data, [[0, 1], [1, 2], [10, 20], [101, null]]);
  assert.deepEqual(r.bands, [[3, 1]]);
  assert.deepEqual(stack(data, [true, false, true, true]).bands, [[3, 2]]);
});

test('tipRows: a stacked chart lists the lines as drawn, top first', () => {
  // value: the line's own reading; drawn: the top of its layer.
  const rows = [{ label: 'a', value: 5, drawn: 5 }, { label: 'b', value: 1, drawn: 6 }, { label: 'c', value: 2, drawn: null }];
  assert.deepEqual(tipRows(rows).map(r => r.label), ['b', 'a', 'c']);
  assert.deepEqual(tipRows([{ label: 'x', value: 1 }, { label: 'y', value: 3 }]).map(r => r.label), ['y', 'x']);
});

test('shapeOf ignores what changes on every refresh', () => {
  const sec = { id: 'cpu', status: 'ok', groups: [{ tags: { cpu: 'cpu0' }, series: { usage: 1 } }] };
  assert.equal(shapeOf(sec), shapeOf({ ...sec, status: 'warn' }));
  assert.notEqual(shapeOf(sec), shapeOf({ ...sec, groups: [...sec.groups, { tags: { cpu: 'cpu1' }, series: { usage: 2 } }] }));
  // A new server process numbers the series again: same tags, other ids.
  assert.notEqual(shapeOf(sec), shapeOf({ ...sec, groups: [{ tags: { cpu: 'cpu0' }, series: { usage: 7 } }] }));
  assert.equal(shapeOf({ series: 31, tabs: [] }), shapeOf({ series: 32, tabs: [] }));
  // The reasons carry the values that crossed a check, new on every layout.
  const statuses = r => ({ statuses: [{ id: 'CPU/cpu', page: 'CPU', status: 'warn', reasons: [r] }] });
  assert.equal(shapeOf(statuses('cpu.usage_user max 7.9 ≥ 5')), shapeOf(statuses('cpu.usage_user max 8.1 ≥ 5')));
});
