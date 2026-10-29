// node --test plugins/outputs/hostdash/pagetest
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare, tagValues, allTagValues, labelKeys, filterGroups, bucketGroups, keptTags, sectionView, storedFor, overviewBlocks, worstStatus, parseHash, formatHash, defaultAgg, tagText, tipRows, tipWindow, withGroupTag, withoutGroupTag, switchMode, tileValue, capLines, countText } from '../page/model.js';
import { fmt, span } from '../page/format.js';
import { combine, band } from './helpers.mjs';

const ORDER = ['ok', 'warn', 'bad', 'errors', 'no data'];

const g = tags => ({ tags, series: {} });

test('naturalCompare orders numbers by value', () => {
  assert.deepEqual(['10', '2', '1'].sort(naturalCompare), ['1', '2', '10']);
  assert.deepEqual(['cpu10', 'cpu2'].sort(naturalCompare), ['cpu2', 'cpu10']);
});

test('naturalCompare is antisymmetric: names equal as numbers go by their text', () => {
  assert.equal(Math.sign(naturalCompare('x=01', 'x=1')), -Math.sign(naturalCompare('x=1', 'x=01')));
  assert.notEqual(naturalCompare('x=01', 'x=1'), 0);
  assert.deepEqual(['x=1', 'x=01'].sort(naturalCompare), ['x=01', 'x=1']);
  assert.deepEqual(['x=01', 'x=1'].sort(naturalCompare), ['x=01', 'x=1']);
  assert.equal(naturalCompare('a', 'a'), 0);
});

test('tagValues lists only tags that differ', () => {
  const v = tagValues([g({ cpu: '0', host: 'a' }), g({ cpu: '10', host: 'a' }), g({ cpu: '2', host: 'a' })]);
  assert.deepEqual([...v.keys()], ['cpu']);
  assert.deepEqual(v.get('cpu'), ['0', '2', '10']);
});

test('filterGroups: =, != and masks; a missing tag is ""', () => {
  const gs = [g({ sensor: 'k10a' }), g({ sensor: 'k10b' }), g({ sensor: 'nvme' }), g({})];
  assert.equal(filterGroups(gs, { sensor: { op: '=', values: ['k10*'] } }).length, 2);
  assert.equal(filterGroups(gs, { sensor: { op: '!=', values: ['k10*'] } }).length, 2);
  assert.equal(filterGroups(gs, { sensor: { op: '=', values: ['nvme', ''] } }).length, 2);
  assert.equal(filterGroups(gs, { sensor: { op: '=', values: [] } }).length, 4);
  assert.equal(filterGroups(gs, null).length, 4);
});

test('bucketGroups merges groups that differ only in dropped tags', () => {
  const gs = [g({ cpu: '0', die: 'x' }), g({ cpu: '1', die: 'x' }), g({ cpu: '2', die: 'y' })];
  assert.deepEqual(bucketGroups(gs, ['die']).map(b => [b.label, b.groups.length]), [['x', 2], ['y', 1]]);
  assert.deepEqual(bucketGroups(gs, []).map(b => b.groups.length), [3]);
});

test('combine aggregates on aligned times', () => {
  const a = [[1000, 1], [3000, 3]], b = [[1004, 5], [3002, 7]];
  assert.deepEqual(combine([a, b], 'avg'), [[1000, 3], [3000, 5]]);
  assert.deepEqual(combine([a, b], 'max'), [[1000, 5], [3000, 7]]);
  assert.deepEqual(combine([a, b], 'sum'), [[1000, 6], [3000, 10]]);
  assert.deepEqual(combine([a]), a);
  assert.deepEqual(band([a, b]).lo, [[1000, 1], [3000, 3]]);
});


test('hash state round-trips', () => {
  const s = parseHash('#System?t=900000&f.temp.sensor=a,b&n.temp.chip=x*&g.linux_cpu=cpu&a.linux_cpu=max&w.irq=cpu,irq');
  assert.equal(s.tab, 'System');
  assert.equal(s.range, 900000);
  assert.deepEqual(s.sections.temp.filter, { sensor: { op: '=', values: ['a', 'b'] }, chip: { op: '!=', values: ['x*'] } });
  assert.deepEqual(s.sections.linux_cpu.group, { mode: 'by', tags: ['cpu'] });
  assert.equal(s.sections.linux_cpu.agg, 'max');
  assert.deepEqual(s.sections.irq.group, { mode: 'without', tags: ['cpu', 'irq'] });
  assert.deepEqual(parseHash(formatHash(s)), s);
});

test('hash: a section after the tab, like a Markdown anchor', () => {
  const s = parseHash('#Load/system?t=900000');
  assert.equal(s.tab, 'Load');
  assert.equal(s.section, 'system');
  assert.equal(s.range, 900000);
  assert.equal(formatHash(s), '#Load/system?t=900000');
  assert.equal(parseHash('#Load').section, null);
  assert.equal(parseHash('#Load/').section, null);
  assert.equal(formatHash({ ...s, section: null, range: null }), '#Load');
  // A "/" in a tab name is encoded and stays in the name.
  const odd = { tab: 'A/B', section: 'smart_device', range: null, sections: {} };
  assert.equal(formatHash(odd), '#A%2FB/smart_device');
  assert.deepEqual(parseHash(formatHash(odd)), odd);
});

test('defaultAgg: rates and counts add up, the rest is averaged', () => {
  for (const u of ['B/s', '1/s', 'tok/s', 'count', 'tok']) assert.equal(defaultAgg(u), 'sum', u);
  for (const u of ['%', '°C', 'Hz', 'W', 'B', 's', 's/s', '', undefined]) assert.equal(defaultAgg(u), 'avg', String(u));
});

test('the link holds only what is set: no agg is no agg', () => {
  assert.equal(parseHash('#System?g.cpu=cpu').sections.cpu.agg, undefined);
  const s = parseHash('#System?g.cpu=cpu&a.cpu=avg');
  assert.equal(s.sections.cpu.agg, 'avg');
  assert.match(formatHash(s), /a\.cpu=avg/);
});

test('band is a way to combine: kept in the hash, the average for one number', () => {
  const s = parseHash('#System?g.cpu=cpu&a.cpu=band&a.mem=bogus');
  assert.equal(s.sections.cpu.agg, 'band');
  assert.equal(s.sections.mem, undefined, 'an unknown name is ignored');
  assert.match(formatHash(s), /a\.cpu=band/);
  assert.deepEqual(combine([[[0, 1]], [[0, 3]]], 'band'), [[0, 2]]);
});

test('format', () => {
  assert.equal(fmt('B', 3 * 2 ** 30), '3.00 GiB');
  assert.equal(fmt('s/s', 0.5), '50%');
  assert.equal(fmt('x', undefined), '–');
  assert.equal(span(3600e3), '1 h');
  assert.equal(span(300e3), '5 min');
});

test('allTagValues lists every tag, also with one value', () => {
  const v = allTagValues([g({ cpu: '1', host: 'a' }), g({ cpu: '0', host: 'a' })]);
  assert.deepEqual([...v.keys()], ['cpu', 'host']);
  assert.deepEqual(v.get('host'), ['a']);
  assert.deepEqual(v.get('cpu'), ['0', '1']);
});

test('grouping: null keeps every series, [] merges all, [tags] groups by them', () => {
  const gs = [g({ cpu: '0', die: 'x' }), g({ cpu: '1', die: 'x' }), g({ cpu: '2', die: 'y' })];
  assert.equal(bucketGroups(gs, [...tagValues(gs).keys()]).length, 3);
  assert.equal(bucketGroups(gs, []).length, 1);
  assert.deepEqual(bucketGroups(gs, ['die', 'cpu']).map(b => b.label), ['0', '1', '2']); // cpu decides die
});

test('labelKeys drops a tag that another tag decides', () => {
  const gs = [g({ name: 'nvme0n1', wwid: 'eui.a' }), g({ name: 'nvme0n1p1' }), g({ name: 'nvme1n1', wwid: 'eui.b' }), g({ name: 'loop0' })];
  assert.deepEqual(labelKeys(gs, ['name', 'wwid']), ['name']);
  assert.deepEqual(bucketGroups(gs, ['name', 'wwid']).map(b => b.label), ['loop0', 'nvme0n1', 'nvme0n1p1', 'nvme1n1']);
  const both = [g({ a: '1', b: 'x' }), g({ a: '2', b: 'y' })];
  assert.deepEqual(labelKeys(both, ['a', 'b']), ['a']);
  const indep = [g({ a: '1', b: 'x' }), g({ a: '1', b: 'y' }), g({ a: '2', b: 'x' })];
  assert.deepEqual(labelKeys(indep, ['a', 'b']), ['a', 'b']);
});

test('popup rows: highest value first, lines without a value left out; tags in full', () => {
  const rows = tipRows([
    { i: 1, label: 'cpu1', value: 5 }, { i: 2, label: 'cpu0', value: 9 },
    { i: 3, label: 'cpu2', value: null }, { i: 4, label: 'cpu10', value: 5 },
  ]);
  assert.deepEqual(rows.map(r => r.i), [2, 1, 4], 'by value, a tie in natural order');
  assert.equal(tagText({ cpu: 'cpu3', die: '0', none: '' }), 'cpu=cpu3 die=0');
  assert.equal(tagText(undefined), '');
});

test('by keeps its tags and combines over the others; without combines over its tags', () => {
  // The Scheduler section: series differ only in cpu.
  const cpus = ['cpu0', 'cpu1', 'cpu2', 'cpu3'].map(c => g({ cpu: c, host: 'box' }));
  const lines = group => bucketGroups(cpus, keptTags(tagValues(cpus), group)).length;
  assert.equal(lines(null), 4, 'no grouping: a line per series');
  assert.equal(lines({ mode: 'by', tags: ['cpu'] }), 4, 'by cpu: a line per CPU');
  assert.equal(lines({ mode: 'by', tags: [] }), 1, 'by (): one line');
  assert.equal(lines({ mode: 'without', tags: ['cpu'] }), 1, 'without cpu: one line over all CPUs');
  // Interrupts: a sum per CPU over irq and device.
  const gs = [g({ cpu: '0', irq: '1', dev: 'x' }), g({ cpu: '0', irq: '2', dev: 'y' }), g({ cpu: '1', irq: '1', dev: 'x' })];
  const tags = tagValues(gs);
  assert.deepEqual(keptTags(tags, { mode: 'by', tags: ['cpu'] }), ['cpu']);
  assert.deepEqual(bucketGroups(gs, keptTags(tags, { mode: 'by', tags: ['cpu'] })).map(b => b.label), ['0', '1']);
  assert.deepEqual(keptTags(tags, { mode: 'without', tags: ['cpu'] }).sort(), ['dev', 'irq']);
  assert.equal(bucketGroups(gs, keptTags(tags, { mode: 'without', tags: ['cpu'] })).length, 2);
  assert.deepEqual(keptTags(tags, { mode: 'by', tags: ['nope'] }), [], 'a tag the series lack keeps nothing apart');
});

test('in the link: g is by (empty is one line), w is without, a=none is no grouping', () => {
  const one = parseHash('#System?g.cpu=');
  assert.deepEqual(one.sections.cpu, { group: { mode: 'by', tags: [] } });
  assert.match(formatHash(one), /g\.cpu=(&|$)/);
  const none = parseHash('#System?a.cpu=none');
  assert.deepEqual(none.sections.cpu, { group: null });
  assert.match(formatHash(none), /a\.cpu=none/);
  assert.deepEqual(parseHash('#S?a.cpu=none&g.cpu=cpu').sections.cpu.group, { mode: 'by', tags: ['cpu'] }, 'a grouping wins over none');
  assert.equal(parseHash('#S?w.cpu=').sections.cpu, undefined, 'without no tags is no grouping to keep');
});

test('a section opens with its configuration; the link holds only your changes', () => {
  const byCpu = { mode: 'by', tags: ['cpu'] };
  const sched = { group: byCpu, agg: 'avg' };
  // Nothing in the link: the configuration.
  assert.deepEqual(sectionView(sched, undefined, 'sum'), { filter: null, group: byCpu, agg: 'avg' });
  // Ungrouped by hand: group null in the link wins over the configuration.
  const none = { filter: null, group: null, agg: null };
  assert.deepEqual(storedFor(sched, none, 'avg'), { group: null });
  assert.deepEqual(sectionView(sched, { group: null }, 'avg'), none);
  // Only the function changed: the grouping comes from the configuration.
  assert.deepEqual(storedFor(sched, { filter: null, group: byCpu, agg: 'max' }, 'avg'), { agg: 'max' });
  assert.deepEqual(sectionView(sched, { agg: 'max' }, 'avg'), { filter: null, group: byCpu, agg: 'max' });
  // The mode switched: stored, with the tags.
  const without = { mode: 'without', tags: ['cpu'] };
  assert.deepEqual(storedFor(sched, { filter: null, group: without, agg: 'avg' }, 'avg'), { group: without });
  // Back to the configuration by hand: nothing to keep.
  assert.equal(storedFor(sched, { filter: null, group: { mode: 'by', tags: ['cpu'] }, agg: 'avg' }, 'sum'), null);
  // A section without a grouping in its configuration.
  const plain = {};
  assert.deepEqual(sectionView(plain, undefined, 'sum'), none);
  assert.equal(storedFor(plain, none, 'sum'), null);
  const mine = { filter: null, group: byCpu, agg: 'sum' };
  assert.deepEqual(storedFor(plain, mine, 'sum'), { group: byCpu }, 'the fallback function is not stored');
  assert.deepEqual(sectionView(plain, { group: byCpu }, 'sum'), mine);
  assert.deepEqual(storedFor(plain, { ...mine, agg: 'band' }, 'sum'), { group: byCpu, agg: 'band' });
  // Filters are always yours.
  const f = { cpu: { op: '!=', values: ['cpu-total'] } };
  assert.deepEqual(storedFor(sched, { filter: f, group: byCpu, agg: 'avg' }, 'avg'), { filter: f });
});

test('overview: the sections under their tabs, in the order of the config', () => {
  // The server's order: the config. Storage has no data, so it has no tab on the page, but keeps its place.
  const statuses = [
    { id: 'Load/system', title: 'Load', page: 'Load', status: 'ok' },
    { id: 'Load/pressure', title: 'Pressure', page: 'Load', status: 'warn' },
    { id: 'Load/kernel', title: 'Kernel', page: 'Load', status: 'ok' },
    { id: 'Storage/disk', title: 'Disks', page: 'Storage', status: 'no data' },
    { id: 'Storage/diskio', title: 'Disk I/O', page: 'Storage', status: 'no data' },
    { id: 'Network/net', title: 'Network', page: 'Network', status: 'bad' },
  ];
  const blocks = overviewBlocks(statuses, ORDER);
  assert.deepEqual(blocks.map(b => [b.page, b.status, b.sections.map(s => s.title)]), [
    ['Load', 'warn', ['Load', 'Pressure', 'Kernel']],
    ['Storage', 'no data', ['Disks', 'Disk I/O']],
    ['Network', 'bad', ['Network']],
  ]);
  assert.equal(worstStatus([], ORDER), 'ok');
  assert.equal(worstStatus(['bad', 'errors', 'warn'], ORDER), 'errors');
  assert.equal(worstStatus(['warn', 'bad'], ['ok', 'bad', 'warn']), 'warn', 'the order comes from the server');
});

test('tipWindow: at most k rows, the focus in the middle where it can be', () => {
  assert.deepEqual(tipWindow(5, 2, 20), [0, 5]);
  assert.deepEqual(tipWindow(230, 0, 20), [0, 20]);
  assert.deepEqual(tipWindow(230, 100, 20), [90, 110]);
  assert.deepEqual(tipWindow(230, 229, 20), [210, 230]);
  assert.deepEqual(tipWindow(21, 20, 20), [1, 21]);
});

test('the grouping block: the first tag starts it with band, tags join it in its mode, the mode switches', () => {
  const empty = { filter: null, group: null, agg: null };
  const first = withGroupTag(empty, 'cpu');
  assert.deepEqual(first, { filter: null, group: { mode: 'by', tags: ['cpu'] }, agg: 'band' });
  assert.deepEqual(withGroupTag(empty, 'cpu', 'without').group, { mode: 'without', tags: ['cpu'] });
  assert.deepEqual(withGroupTag({ ...first, agg: 'max' }, 'irq', 'without'), { filter: null, group: { mode: 'by', tags: ['cpu', 'irq'] }, agg: 'max' }, 'a tag joins the block in its mode');
  assert.deepEqual(switchMode(first).group, { mode: 'without', tags: ['cpu'] });
  assert.deepEqual(withoutGroupTag(first, 'cpu').group, { mode: 'by', tags: [] }, 'by without tags: one line');
  assert.deepEqual(withoutGroupTag(switchMode(first), 'cpu'), { filter: null, group: null, agg: null }, 'without without tags: no grouping');
  const one = withoutGroupTag(first, 'cpu');
  assert.equal(switchMode(one), one, 'by () does not turn into without ()');
});

test('hash: a changed function of the configured grouping is kept', () => {
  const sec = { id: 'Load/cpu', measurement: 'cpu', group: { mode: 'by', tags: ['cpu'] }, agg: 'avg' };
  const stored = storedFor(sec, { filter: null, group: { mode: 'by', tags: ['cpu'] }, agg: 'max' }, 'avg');
  assert.deepEqual(stored, { agg: 'max' });
  const s = { tab: 'Load', section: null, range: null, sections: { cpu: stored } };
  const back = parseHash(formatHash(s));
  assert.equal(sectionView(sec, back.sections.cpu, 'avg').agg, 'max');
});

test('hash: a filter without values stays out of the address', () => {
  const s = { tab: 'Load', section: null, range: null, sections: { cpu: { filter: { cpu: { op: '=', values: [] } } } } };
  assert.equal(formatHash(s), '#Load');
});

test('a tile counts series, not the lines of the query bar', () => {
  const groups = [{ v: { used: 30, total: 100 } }, { v: { used: 90, total: 100 } }, { v: { total: 50 } }];
  const valueOf = (g, f) => g.v[f];
  assert.deepEqual(tileValue({ field: 'used' }, groups, valueOf), { value: 30, level: '' }, 'first by default');
  assert.equal(tileValue({ field: 'used', agg: 'sum' }, groups, valueOf).value, 120);
  assert.equal(tileValue({ field: 'used', agg: 'max' }, groups, valueOf).value, 90);
  // of is taken in the same group, as a check does: 90/100, not 90/250.
  assert.equal(tileValue({ field: 'used', agg: 'max', of: 'total', warn: 0.5, bad: 0.85 }, groups, valueOf).level, 'bad');
  assert.equal(tileValue({ field: 'used', of: 'total', warn: 0.5, bad: 0.85 }, groups, valueOf).level, 'ok');
  assert.equal(tileValue({ field: 'used', warn: 20, below: true }, groups, valueOf).level, 'ok');
  assert.equal(tileValue({ field: 'used', of: 'none', warn: 0.5 }, groups, valueOf).level, '', 'no base, no level');
  assert.deepEqual(tileValue({ field: 'gone' }, groups, valueOf), { value: undefined, level: '' });
});

test('capLines keeps the lines with the highest peak, a band as one', () => {
  const l = (label, p, band) => ({ label, p, band });
  const lines = [l('a', 1), l('b', 5), l('c avg', 2), l('c max', 9, 'hi'), l('c min', 0, 'lo'), l('d', 3)];
  const r = capLines(lines, 2, x => x.p);
  assert.deepEqual(r.lines.map(x => x.label), ['b', 'c avg', 'c max', 'c min']);
  assert.equal(r.hidden, 2);
  assert.deepEqual(capLines(lines, 100, x => x.p), { lines, hidden: 0 });
});

test('countText: groups shown of all, and the lines they make', () => {
  assert.equal(countText(16, 16, 1), '16 groups → 1 line');
  assert.equal(countText(4, 16, 4), '4 of 16 groups → 4 lines');
});
