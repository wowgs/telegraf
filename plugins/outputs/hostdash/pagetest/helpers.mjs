// Helpers of the page tests: combining [[t, v], ...] lists in one go.
import { Combined } from '../page/combine.js';
import { Points } from '../page/points.js';

// combine is the line of the series combined with agg over the whole window.
export const combine = (series, agg = 'avg') =>
  new Combined(agg).update(series.map(Points.of), -Infinity).line.pairs();

// band is min, max and avg of the series over the whole window.
export function band(series) {
  const { lo, hi, mid } = new Combined('band').update(series.map(Points.of), -Infinity).out;
  return { lo: lo.pairs(), hi: hi.pairs(), mid: mid.pairs() };
}
