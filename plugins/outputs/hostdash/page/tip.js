// The hover popup of a chart: the time, the line under the cursor with all its
// tags (its own, then the shared ones), and every line at that moment, the
// highest value first. The chart (chart.js) decides which line is under the
// cursor and gives the rows.

import { $ } from './dom.js';
import { tagText, tipWindow } from './model.js';

// tagTable lays the tags of a line out as two columns, the key and the value:
// first the tags that tell this line from the others, then the ones all
// lines share, fainter.
function tagTable(own = {}, common = {}) {
  const rows = [...Object.entries(own).map(e => [...e, '']), ...Object.entries(common).filter(([k]) => !(k in own)).map(e => [...e, ' shared'])]
    .filter(([, v]) => v !== '');
  if (!rows.length) return null;
  const box = $('div', 'tip-tags');
  for (const [k, v, cls] of rows) box.append($('span', 'tk' + cls, k), $('span', 'tv' + cls, v));
  return box;
}

const swatch = color => { const i = $('i'); i.style.background = color; return i; };

export class Tip {
  // lines: how many rows the list shows at most (tip_lines of the plugin).
  constructor(lines = 20) {
    this.lines = lines;
    this.el = $('div', 'tip');
    this.el.hidden = true;
    document.body.append(this.el);
  }

  // show draws the popup next to the cursor at x, y (viewport px).
  // rows: [{i, label, color, value, about: {field, tags, of, how}}], already
  // sorted; focus: the i of the line under the cursor; common: tags that all
  // lines share; text: a value as text.
  show({ x, y, time, rows, focus, common, text }) {
    const el = this.el;
    el.replaceChildren($('div', 'tip-time', time));
    const f = rows.find(r => r.i === focus);
    if (f) {
      const head = $('div', 'tip-focus');
      const top = $('div', 'tip-row');
      top.append(swatch(f.color), $('span', 'tip-what', f.label), $('b', '', text(f.value)));
      head.append(top);
      const tags = tagTable(f.about?.tags, common);
      if (tags) head.append(tags);
      if (f.about?.of > 1) head.append($('div', 'tip-note', `${f.about.how} of ${f.about.of} series`));
      el.append(head);
    }
    let on = null, list = null;
    if (rows.length > 1) {
      list = $('div', 'tip-list');
      // Only the rows around the focus are built: a chart can have hundreds
      // of lines, and the popup is drawn again on every move of the pointer.
      const [from, to] = tipWindow(rows.length, Math.max(0, rows.findIndex(r => r.i === focus)), this.lines);
      if (from > 0) list.append($('div', 'tip-more', `${from} more above`));
      for (const r of rows.slice(from, to)) {
        const a = r.about || {};
        const what = [a.field, tagText(a.tags), a.of > 1 ? a.how : ''].filter(Boolean).join(' ') || r.label;
        const row = $('div', 'tip-row' + (r.i === focus ? ' on' : ''));
        row.append(swatch(r.color), $('span', 'tip-what', what), $('b', '', text(r.value)));
        if (r.i === focus) on = row;
        list.append(row);
      }
      if (to < rows.length) list.append($('div', 'tip-more', `${rows.length - to} more below`));
      el.append(list);
    }
    el.hidden = false;
    // The line under the cursor stays in the middle of a long list.
    if (on) list.scrollTop = on.offsetTop - list.offsetTop - (list.clientHeight - on.offsetHeight) / 2;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = x + 16;
    if (left + w > innerWidth - 8) left = Math.max(8, x - 16 - w);
    el.style.left = left + 'px';
    el.style.top = Math.min(Math.max(8, y - 24), innerHeight - h - 8) + 'px';
  }

  hide() { this.el.hidden = true; }

  destroy() { this.el.remove(); }
}
