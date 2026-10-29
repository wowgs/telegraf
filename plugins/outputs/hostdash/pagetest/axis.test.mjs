// node --test plugins/outputs/hostdash/pagetest
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueLabels, axisIncrs, yBounds } from '../page/axis.js';

test('valueLabels: one scale, the digits the step needs, the shortest labels', () => {
  assert.deepEqual(valueLabels('B', [0, 2 ** 30, 2 ** 31]), ['0', '1G', '2G']);
  assert.deepEqual(valueLabels('B', [0, 2 ** 29, 2 ** 30]), ['0', '0.5G', '1.0G']);
  assert.deepEqual(valueLabels('%', [0, 25, 50]), ['0', '25%', '50%']);
  assert.deepEqual(valueLabels('', [0, 0.25, 0.5]), ['0', '0.25', '0.50']);
  assert.deepEqual(valueLabels('', [0, 2500, 5000]), ['0', '2.5k', '5.0k']);
  assert.deepEqual(valueLabels('s/s', [0, 0.5, 1]), ['0', '50%', '100%']);
  assert.deepEqual(valueLabels('', [null, 1, 2]), ['', '1', '2']);
});

test('valueLabels: ticks 50K apart on 1.42T get full, distinct labels in one format', () => {
  const lo = 1.42 * 2 ** 40, labels = valueLabels('B', [lo, lo + 51200, lo + 102400]);
  assert.equal(new Set(labels).size, 3, labels.join(' '));
  assert.equal(new Set(labels.map(l => l.length)).size, 1, labels.join(' '));
});

test("axisIncrs: bytes step in the binary scale of the values, other units keep uPlot's", () => {
  const G = 2 ** 30, T = 2 ** 40;
  const g = axisIncrs('B')(null, 1, 14.9 * G, 15.1 * G);
  assert.ok(g.some(v => Math.abs(v - 0.1 * G) < 1), '0.1G');
  assert.ok(!g.includes(100 * 2 ** 20), 'no 100M on a G axis');
  assert.deepEqual(g, [...g].sort((x, y) => x - y), 'ascending, as uPlot needs');
  assert.ok(axisIncrs('B')(null, 1, 1.41 * T, 1.43 * T).some(v => Math.abs(v - 0.01 * T) < 1), '0.01T');
  assert.ok(axisIncrs('B')(null, 1, 0, 100).every(v => v >= 1));
  assert.equal(axisIncrs('%'), undefined);
  assert.deepEqual(valueLabels('B', [1450 * G, 1460 * G]), ['1450G', '1460G']);
  assert.deepEqual(valueLabels('B', [14.9 * G, 15 * G, 15.1 * G]), ['14.9G', '15.0G', '15.1G']);
  assert.deepEqual(valueLabels('B', [1.41 * T, 1.42 * T, 1.43 * T]), ['1.41T', '1.42T', '1.43T']);
  assert.deepEqual(valueLabels('B', [15300 * 2 ** 20, 15400 * 2 ** 20]), ['15300M', '15400M'], 'exact wins over short');
});

test('yBounds: the top follows the data, max is a ceiling, min_max a floor for the top', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const [lo, hi] = yBounds({ min: 0 }, 100, 0.3, 2);
  assert.equal(lo, 0); near(hi, 2.2);
  assert.deepEqual(yBounds({ min: 0 }, 100, 0, 95), [0, 100], 'never above the ceiling');
  assert.deepEqual(yBounds({ min: 0 }, 1, 0, 0), [0, 1], 'all zero: up to the ceiling');
  assert.deepEqual(yBounds({ min: 20, minMax: 90 }, undefined, 35, 50), [20, 90]);
  assert.deepEqual(yBounds({}, undefined, -5, 10).map(v => +v.toFixed(9)), [-5, 11]);
  assert.deepEqual(yBounds({ min: 0 }, undefined, null, null), [0, 1], 'no data');
});
