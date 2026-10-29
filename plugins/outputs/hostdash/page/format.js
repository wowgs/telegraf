// Numbers with units, as the page shows them. Pure functions.

// clean drops the sign of a value that prints as zero: "-0.00" is "0.00".
const clean = text => /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;

// num prints a plain number with 2, 1 or 0 decimals by its size.
export const num = v => clean(Number.isInteger(v) || Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// scaled prints v in the largest step it reaches after rounding, so 1048575 B
// is "1.0 MiB", not "1024.0 KiB". steps: [from, divisor, suffix, decimals],
// largest first; the last one is used below every "from".
function scaled(v, steps) {
  const a = Math.abs(v);
  let i = steps.findIndex(([from]) => a >= from);
  if (i < 0) i = steps.length - 1;
  const text = ([, div, , d]) => (v / div).toFixed(d);
  // Rounded up to where the step above starts: print in that step.
  if (i > 0 && Math.abs(+text(steps[i])) * steps[i][1] >= steps[i - 1][0]) i--;
  return clean(text(steps[i])) + steps[i][2];
}

const BYTES = [[2 ** 40, 2 ** 40, ' TiB', 2], [2 ** 30, 2 ** 30, ' GiB', 2], [2 ** 20, 2 ** 20, ' MiB', 1], [1024, 1024, ' KiB', 1], [0, 1, ' B', 0]];
const KILO = [[1e12, 1e12, 'T', 2], [1e9, 1e9, 'G', 2], [1e6, 1e6, 'M', 2], [1e4, 1e3, 'k', 0], [1e3, 1e3, 'k', 1]];
const HERTZ = [[1e9, 1e9, ' GHz', 2], [1e6, 1e6, ' MHz', 0]];

export const bytes = v => scaled(v, BYTES);

export function kilo(v) {
  if (Math.abs(v) >= 1e3) return scaled(v, KILO);
  const text = num(v);
  return Math.abs(+text) >= 1e3 ? scaled(Math.sign(v) * 1e3, KILO) : text;
}

const hertz = v => Math.abs(v) >= 1e6 ? scaled(v, HERTZ) : num(v / 1e3) + ' kHz';

export function duration(s) {
  if (s < 0) return '-' + duration(-s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : num(s) + ' s';
}

// fmt is a value with its unit, short enough for a tile or a legend.
export function fmt(unit = '', v) {
  if (v == null || !isFinite(v)) return '–';
  switch (unit) {
    case '%': return num(v) + '%';
    case 'B': return bytes(v);
    case 'B/s': return bytes(v) + '/s';
    case 'Hz': return hertz(v);
    case '°C': return v.toFixed(1) + ' °C';
    case 'W': return num(v) + ' W';
    case 's': return duration(v);
    case 's/s': return num(v * 100) + '%';
    case '1/s': return kilo(v) + '/s';
    case 'tok': return kilo(v);
    case 'tok/s': return kilo(v) + ' tok/s';
    case 'count': return kilo(v);
    case '': return kilo(v);
    default: return num(v) + ' ' + unit;
  }
}

// span is a time length as the time bar shows it: 5 min, 1 h.
export function span(ms) {
  const m = Math.round(ms / 60e3);
  return m >= 60 && m % 60 === 0 ? `${m / 60} h` : m >= 1 ? `${m} min` : `${Math.round(ms / 1e3)} s`;
}

// age is how long ago something happened: 3 s, 5 min.
export function age(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h`;
}
