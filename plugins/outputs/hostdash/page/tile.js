// A tile: a name, one value in large type and a line below it. The tile only
// shows what it is given; app.js picks the series and the values.

import { $ } from './dom.js';

export class Tile {
  // title: the name; sub: the line below the value; hint: the tooltip.
  constructor({ title, sub = ' ', hint }) {
    this.el = $('div', 'tile');
    if (hint) this.el.title = hint;
    this.value = $('div', 'v', '–');
    this.sub = $('div', 's', sub || ' ');
    this.el.append($('div', 'k', title), this.value, this.sub);
  }

  // set changes what is given: value and sub are text, level is '', 'ok',
  // 'warn' or 'bad' (the colour of the left edge).
  set({ value, sub, level }) {
    if (value !== undefined) this.value.textContent = value;
    if (sub !== undefined) this.sub.textContent = sub || ' ';
    if (level !== undefined) this.el.className = 'tile ' + level;
  }
}
