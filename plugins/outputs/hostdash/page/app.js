// The page: time bar and tabs at the top, a card per section with its tag
// filter and grouping, tiles and charts. State is in the URL hash.

import { Data, shapeOf } from './api.js';
import { $ } from './dom.js';
import { Tile } from './tile.js';
import { Chart } from './chart.js';
import { fmt, span, age } from './format.js';
import { Combined, latest, peak } from './combine.js';
import { tagValues, allTagValues, filterGroups, bucketGroups, keptTags, sectionView, storedFor, matchValue, parseHash, formatHash, AGG_NAMES, defaultAgg, overviewBlocks, worstStatus, withGroupTag, withoutGroupTag, switchMode, tileValue, capLines, countText } from './model.js';

const data = new Data();
let state = parseHash(location.hash);

// A part of the page that is built and thrown away as a whole: the overview,
// or one section card. Its views are refreshed on every poll.
let parts = [];  // parts on screen
let part = null; // the part being built
const cards = new Map(); // section id -> {el, part, shape}
const newPart = () => { part = { views: [], charts: [] }; parts.push(part); return part; };
const addView = v => part.views.push(v);
function dropPart(p) {
  for (const c of p.charts) c.destroy();
  parts = parts.filter(x => x !== p);
}

// A chart with more lines than this gets a "band" button: a shortcut that sets
// "band by ()" in the query bar of its section.
const BAND_ABOVE = 8;
const RANGES_MIN = [5, 15, 30, 60, 180, 360, 720, 1440];

// State changes rebuild as little as possible, so the page never jumps:
// the time range only redraws, a section setting rebuilds only its card.
function commit(next) {
  state = next;
  history.replaceState(null, '', formatHash(state));
}
function setRange(ms) {
  commit({ ...state, range: ms });
  renderTop();
  for (const p of parts) for (const c of p.charts) c.redraw = true;
  update();
}
function setTab(id) {
  commit({ ...state, tab: id, section: null });
  showTab();
  scrollTo(0, 0);
}
// setSection shows a new view of a section. The link keeps only what differs
// from the configuration of the section (null: back to the configuration).
// The section is taken from the current layout: a popup can outlive the
// layout its card was built from.
function setSection(sec, view) {
  sec = sectionById(sec.id) ?? sec;
  const sections = { ...state.sections };
  const stored = view && storedFor(sec, view, fallbackAgg(sec));
  if (stored) sections[sec.measurement] = stored; else delete sections[sec.measurement];
  commit({ ...state, sections });
  rebuildCard(sec);
}
const sectionById = id => data.layout?.tabs.flatMap(t => t.sections || []).find(s => s.id === id);
const range = () => {
  const win = data.layout ? data.layout.windowMs : 3600e3;
  return Math.min(state.range || win, win);
};
// fallbackAgg is the function of a grouping that nobody chose: by the unit of
// the first field of the first chart.
const fallbackAgg = sec => defaultAgg(sec.units?.[sec.charts?.[0]?.fields[0]]);
const sectionState = sec => sectionView(sec, state.sections[sec.measurement], fallbackAgg(sec));
const changed = sec => sec.measurement in state.sections;
// A section without config (sec.auto) starts collapsed, the others open. A
// click is remembered in this browser.
function isCollapsed(sec) {
  let v = null;
  try { v = localStorage.getItem('hostdash:collapsed:' + sec.id); } catch { /* storage off */ }
  return v == null ? !!sec.auto : v === '1';
}
function setCollapsed(sec, on) {
  try { localStorage.setItem('hostdash:collapsed:' + sec.id, on ? '1' : '0'); } catch { /* storage off */ }
}

// model applies the section's tag filter and grouping.
function model(sec) {
  const st = sectionState(sec);
  const tags = tagValues(sec.groups || []);
  const groups = filterGroups(sec.groups || [], st.filter);
  // "agg by cpu" combines the series that differ only in cpu into one line;
  // no grouping (null) is a line per series.
  const keep = keptTags(tags, st.group);
  const buckets = bucketGroups(groups, keep);
  return { st, tags, keep, groups, buckets, agg: st.agg };
}
const has = (b, field) => b.groups.some(g => g.series[field] != null);
const pointsOf = (groups, field) => groups.map(g => g.series[field] != null ? data.pts.get(g.series[field]) : null);
// latestOf is the last value of the line of bucket b, without combining the
// whole window.
const latestOf = (b, field, agg) => b ? latest(pointsOf(b.groups, field), agg) : undefined;
// valueOf is the latest value of a field in one group.
const valueOf = (g, field) => g.series[field] != null ? data.pts.get(g.series[field])?.lastValue() : undefined;
// first is the first group that has the field, as a bucket of one group.
const first = (groups, field) => {
  const g = groups.find(x => x.series[field] != null);
  return g ? { groups: [g] } : undefined;
};
function textOf(b, field) {
  for (const g of b.groups) if (g.series[field] != null && data.texts.has(g.series[field])) return data.texts.get(g.series[field]);
  return undefined;
}
function tagOf(b, tag) {
  const vals = new Set(b.groups.map(g => g.tags[tag] ?? ''));
  return vals.size === 1 ? [...vals][0] : '…';
}
// aggOf is how the series of a line combine for a field: the function of the
// grouping. Without a grouping a line is one series, and the function by the
// unit of the field does nothing to it.
const aggOf = (sec, agg, field) => agg ?? defaultAgg(sec.units?.[field]);
function valueText(sec, b, field, agg) {
  if (!b) return '–';
  if ((sec.text || []).includes(field)) return textOf(b, field) ?? '–';
  return fmt(sec.units?.[field], latestOf(b, field, aggOf(sec, agg, field)));
}
function partsText(sec, parts, b, agg) {
  return (parts || []).map(p => p.f ? valueText(sec, b, p.f, agg) : p.tag ? (b ? tagOf(b, p.tag) : '') : p.s).join('');
}

// ---------- top: title, status, time bar, tabs ----------

// renderTop builds the buttons of the time bar and the tabs only when the
// window or the tabs change, and else updates them in place: a button made
// again between the press and the release of the mouse loses the click, and
// the keyboard loses its focus.
let topShape = '';
function renderTop() {
  const L = data.layout;
  document.getElementById('title').textContent = L.title;
  document.title = L.title + ' · hostdash';
  const bar = document.getElementById('time'), nav = document.getElementById('tabs');
  const shape = JSON.stringify([L.windowMs, L.tabs.map(t => [t.id, t.title])]);
  if (shape !== topShape) {
    topShape = shape;
    bar.textContent = '';
    for (const m of RANGES_MIN) {
      const ms = m * 60e3;
      if (ms > L.windowMs) continue;
      const b = $('button', '', span(ms));
      b.dataset.ms = String(ms);
      b.addEventListener('click', () => setRange(ms === L.windowMs ? null : ms));
      bar.append(b);
    }
    nav.textContent = '';
    nav.setAttribute('role', 'tablist');
    for (const t of L.tabs) {
      const b = $('button', '', t.title);
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      // The status of a tab is a colour and, for screen readers, a text.
      b.append($('span', 'sr'));
      b.addEventListener('click', () => setTab(t.id));
      nav.append(b);
    }
  }
  for (const b of bar.children) {
    const on = +b.dataset.ms === range();
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const active = activeTab().id;
  for (const b of nav.children) {
    const id = b.dataset.tab, on = id === active;
    const status = id === 'overview' ? 'ok' : pageStatus(id);
    b.className = (on ? 'active' : '') + (status !== 'ok' ? ' st-' + statusClass(status) : '');
    b.setAttribute('aria-selected', String(on));
    b.title = status !== 'ok' ? status : '';
    b.querySelector('.sr').textContent = status !== 'ok' ? `, ${status}` : '';
  }
}

// renderStatus shows the state of the page next to the title: live, Telegraf
// silent, the plugin out of reach (offline) or an error of the page itself.
function renderStatus(kind) {
  const L = data.layout, dot = document.getElementById('dot'), text = document.getElementById('status-text');
  if (kind === 'offline') { dot.className = 'down'; text.textContent = 'offline — retrying'; return; }
  if (kind === 'page') { dot.className = 'warn'; text.textContent = 'page error, see the console'; return; }
  dot.className = L.silent ? 'warn' : 'live';
  text.textContent = (L.silent ? 'Telegraf sends nothing' : 'live') + ` · ${L.series} series`;
}

// The statuses of the sections, in the latest layout, which can be newer
// than the one the page was built from.
const statusOf = id => (data.layout.statuses || []).find(s => s.id === id);
const pageStatus = page => worstStatus((data.layout.statuses || []).filter(s => s.page === page).map(s => s.status), data.layout.statusOrder);
// statusClass is a CSS class name for a status: "no data" has a space.
const statusClass = s => s.replace(' ', '-');

const activeTab = () => data.layout.tabs.find(t => t.id === state.tab) || data.layout.tabs[0];

// ---------- tabs ----------

// render rebuilds the whole tab and keeps the scroll position.
let shownTab = ''; // what render built: the tabs and the sections of the active tab
const tabShape = () => {
  const tab = activeTab();
  return JSON.stringify([data.layout.tabs.map(t => [t.id, t.title]), tab.id, (tab.sections || []).map(s => s.id)]);
};
function render() {
  if (!data.layout) return;
  closePopup();
  shownTab = tabShape();
  const y = scrollY;
  for (const p of [...parts]) dropPart(p);
  cards.clear();
  renderTop();
  const pane = document.getElementById('pane');
  pane.textContent = '';
  const tab = activeTab();
  if (tab.id === 'overview') {
    newPart();
    renderOverview(pane);
  } else {
    const target = pendingScroll && targetSection(tab);
    if (target && isCollapsed(target)) setCollapsed(target, false);
    for (const sec of tab.sections || []) pane.append(buildCard(sec));
  }
  scrollTo(0, y);
}

// A link to a section scrolls to it once, after the first poll that drew the
// tab it opened: a chart gets its height with its first points. The polls
// after it keep the position.
let pendingScroll = !!state.section;
const targetSection = tab => (tab.sections || []).find(s => s.measurement === state.section);
// sectionHref is the address of a section on its tab, with the current view.
const sectionHref = (page, key) => formatHash({ ...state, tab: page, section: key });
// scrollToSection puts the top of the linked section under the sticky top
// bar; without one on the tab, the tab starts at the top.
function scrollToSection() {
  const sec = state.section && targetSection(activeTab());
  const el = sec && cards.get(sec.id)?.el;
  if (!el) { scrollTo(0, 0); return; }
  const bar = document.querySelector('header.top').offsetHeight;
  scrollTo(0, el.getBoundingClientRect().top + scrollY - bar - 8);
}

// refresh applies a new layout: the whole tab when its tabs or sections
// changed, else only the cards whose section changed (a new series of one
// measurement does not redraw every chart).
function refresh() {
  const tab = activeTab();
  if (tab.id === 'overview' || tabShape() !== shownTab) { render(); return; }
  renderTop();
  for (const sec of tab.sections || []) {
    const c = cards.get(sec.id);
    if (c && c.shape !== shapeOf(sec)) rebuildCard(sec);
  }
}

function buildCard(sec) {
  const p = newPart();
  const el = sectionCard(sec);
  cards.set(sec.id, { el, part: p, shape: shapeOf(sec) });
  return el;
}

// rebuildCard replaces one section card in place and draws it at once.
function rebuildCard(sec) {
  const old = cards.get(sec.id);
  if (!old) { render(); update(); return; }
  const y = scrollY;
  dropPart(old.part);
  const el = buildCard(sec);
  old.el.replaceWith(el);
  if (popup && !popup.anchor.isConnected) closePopup();
  scrollTo(0, y);
  for (const v of cards.get(sec.id).part.views) v.update();
}

// renderOverview shows a card for each tab, in their order: its worst status,
// its sections as chips, with the titles and in the order they have on the
// tab, and the reasons of those not ok. The cards follow the statuses of each
// layout.
function renderOverview(pane) {
  const grid = $('div', 'overview');
  pane.append(grid);
  const blocks = overviewBlocks(data.layout.statuses, data.layout.statusOrder);
  for (const block of blocks) {
    const card = $('div', 'card ov-tab');
    const pill = $('span', 'pill');
    const head = $('div', 'ov-head');
    const title = $('a', 'ov-title', block.page);
    head.append(title, pill);
    const chips = $('div', 'ov-chips'), problems = $('ul', 'ov-problems');
    card.append(head, chips, problems);
    grid.append(card);
    addView({ update() {
      title.href = formatHash({ ...state, tab: block.page, section: null });
      const now = overviewBlocks(data.layout.statuses, data.layout.statusOrder).find(b => b.page === block.page) || { status: 'no data', sections: [] };
      const cls = 'st-' + statusClass(now.status);
      card.className = 'card ov-tab ' + cls;
      pill.className = 'pill ' + cls;
      pill.textContent = now.status;
      // The chips are links: rebuilt only when the sections, their statuses
      // or links change, so that a poll between pressing and releasing the
      // mouse does not eat the click. Their reasons change in place.
      const href = sec => sectionHref(sec.page, sec.measurement);
      const shown = JSON.stringify(now.sections.map(s => [s.id, s.title, s.status, href(s)]));
      if (shown !== chips.dataset.shown) {
        chips.dataset.shown = shown;
        chips.textContent = '';
        for (const sec of now.sections) {
          const chip = $('a', 'chip st-' + statusClass(sec.status), sec.title);
          chip.href = href(sec);
          chips.append(chip);
        }
      }
      now.sections.forEach((sec, i) => {
        chips.children[i].title = sec.status + (sec.reasons?.length ? ': ' + sec.reasons.join('; ') : '');
      });
      problems.textContent = '';
      for (const sec of now.sections) {
        if (sec.status !== 'ok') for (const r of sec.reasons || []) problems.append($('li', '', `${sec.title}: ${r}`));
      }
    } });
  }
  if (!blocks.length) pane.append($('p', 'empty', 'No metrics yet.'));
}

// ---------- a section ----------

function sectionCard(sec) {
  const m = model(sec);
  const card = $('section', 'card section');
  const head = $('header', 'section-head');
  const toggle = $('button', 'collapse', isCollapsed(sec) ? '▸' : '▾');
  toggle.title = 'Collapse or expand';
  toggle.addEventListener('click', () => { setCollapsed(sec, !isCollapsed(sec)); rebuildCard(sec); kick(); });
  // The title is a link to the section, like a heading on GitHub: a click
  // puts the address of the section into the address bar.
  const title = $('h2');
  const link = $('a', '', sec.title);
  link.addEventListener('click', e => {
    e.preventDefault();
    commit({ ...state, section: sec.measurement });
    scrollToSection();
  });
  title.append(link);
  const badge = $('span', 'badge');
  const ageEl = $('span', 'age');
  let newest = 0, newestAt = -1;
  const collapsed = isCollapsed(sec);
  head.append(sec.empty ? $('span', 'collapse') : toggle, title, badge, ageEl);
  card.append(head);
  addView({ update() {
    // The link carries the view of the page as it is now.
    link.href = sectionHref(sec.page, sec.measurement);
    const status = statusOf(sec.id)?.status ?? 'ok';
    badge.textContent = status === 'ok' ? '' : status;
    badge.className = 'badge' + (status === 'ok' ? '' : ' st-' + statusClass(status));
    // A collapsed section is not asked for: its points are old, so it shows
    // no age. The newest point is looked for only when the measurement changed.
    if (collapsed) return;
    if (newestAt < 0 || data.changedSince(sec.measurement, newestAt)) {
      newestAt = data.seq;
      newest = 0;
      for (const g of sec.groups || []) for (const id of Object.values(g.series)) newest = Math.max(newest, data.pts.get(id)?.lastTime() ?? 0);
    }
    ageEl.textContent = newest ? `updated ${age(data.clock() - newest)} ago` : '';
  } });
  // A section of the config whose input wrote nothing yet.
  if (sec.empty) { card.classList.add('nodata'); card.append($('p', 'empty', 'No data yet.')); return card; }
  if (collapsed) { card.classList.add('collapsed'); return card; }

  // A note shows the values of the first series, whatever the grouping.
  if (sec.note) {
    const note = $('p', 'note');
    const home = m.groups.length ? { groups: [m.groups[0]] } : undefined;
    addView({ update() { note.textContent = partsText(sec, sec.note, home, null); } });
    card.append(note);
  }
  if (allTagValues(sec.groups || []).size) card.append(queryBar(sec, m));

  if (sec.tiles?.length) {
    const box = $('div', 'tiles');
    for (const t of sec.tiles) box.append(tileView(sec, t, m));
    card.append(box);
  }
  if (sec.charts?.length) {
    const box = $('div', 'charts');
    for (const c of sec.charts) box.append(chartView(sec, c, m));
    card.append(box);
  }
  return card;
}

// ---------- the query bar ----------
// One line per section. A click on its free space opens a menu: "filter" or
// "group by", each with the tag keys next to it. A key adds a block:
//   filter    "sensor = k10*"   one or more values or * masks; = or ≠
//   group by  "avg by cpu, die" a line per value combination of the keys
// A click on a block edits it, × removes it. No group block: a line per series.

let popup = null;   // the open popup: {el, onClose}
let reopen = null;  // a popup to open again after its card was rebuilt: {sec, tag}

// closePopup removes the open popup. later: run its onClose after the
// current click, whose handler would otherwise find its card rebuilt.
function closePopup({ later = false } = {}) {
  if (!popup) return;
  const p = popup;
  popup = null;
  p.el.remove();
  if (p.onClose) later ? setTimeout(p.onClose) : p.onClose();
}
function openPopup(anchor, el, onClose, { right = false } = {}) {
  closePopup();
  const r = anchor.getBoundingClientRect();
  el.classList.add('popup');
  el.style.top = `${r.bottom + scrollY + 4}px`;
  el.style.left = `${(right ? r.right + 4 : r.left) + scrollX}px`;
  if (right) el.style.top = `${r.top + scrollY}px`;
  document.body.append(el);
  popup = { el, onClose, anchor };
  fitPopup(el);
  return el;
}
// fitPopup moves a popup left so that it stays inside the window.
function fitPopup(el) {
  const over = el.getBoundingClientRect().right - (innerWidth - 8);
  if (over > 0) el.style.left = `${Math.max(8 + scrollX, parseFloat(el.style.left) - over)}px`;
}
// A click outside closes the popup; capture runs before the click's own
// handler, which still runs.
document.addEventListener('click', e => {
  if (popup && !popup.el.contains(e.target) && !popup.anchor.contains(e.target)) closePopup({ later: true });
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopup(); });

function queryBar(sec, m) {
  const bar = $('div', 'query');
  const st = m.st;
  const filter = st.filter || {};
  const save = next => setSection(sec, next);
  const q = {
    sec, m, st, filter, save, tags: allTagValues(sec.groups || []),
    withFilter(tag, f) {
      const next = { ...filter };
      if (f == null) delete next[tag]; else next[tag] = f;
      save({ ...st, filter: Object.keys(next).length ? next : null });
    },
  };
  for (const [tag, f] of Object.entries(filter)) bar.append(filterBlock(q, tag, f));
  if (st.group) bar.append(groupBlock(q));

  const add = $('button', 'add', '+');
  add.title = 'Add a filter or a grouping';
  add.setAttribute('aria-label', add.title);
  add.addEventListener('click', e => { e.stopPropagation(); addMenu(q, bar, add.getBoundingClientRect().left); });
  bar.append(add);
  if (!Object.keys(filter).length && !st.group) bar.append($('span', 'ph', 'filter or group'));
  bar.append($('span', 'cnt', countText(m.groups.length, (sec.groups || []).length, m.buckets.length)));
  if (changed(sec)) {
    const reset = $('button', 'reset', '↺');
    reset.title = 'Back to the configuration of this section';
    reset.addEventListener('click', e => { e.stopPropagation(); closePopup(); setSection(sec, null); });
    bar.append(reset);
  }
  bar.addEventListener('click', e => { if (!e.target.closest('.blk, button')) addMenu(q, bar, e.clientX); });
  return bar;
}

function xButton(title, fn) {
  const x = $('button', 'x', '×');
  x.title = title;
  x.addEventListener('click', e => { e.stopPropagation(); closePopup(); fn(); });
  return x;
}

// filterBlock is "tag = values ×": a click edits the values, = switches to ≠.
function filterBlock(q, tag, f) {
  const blk = $('span', 'blk filter');
  const op = $('button', 'op', f.op === '!=' ? '≠' : '=');
  op.title = 'Switch between = and ≠';
  op.addEventListener('click', e => { e.stopPropagation(); q.withFilter(tag, { ...f, op: f.op === '!=' ? '=' : '!=' }); });
  blk.append($('span', 'k', tag), op, $('span', f.values.length ? 'v' : 'v empty', f.values.length ? f.values.join(', ') : 'value'),
    xButton(`Remove the filter on ${tag}`, () => q.withFilter(tag, null)));
  blk.addEventListener('click', e => { e.stopPropagation(); valuesPopup(q.sec, blk, tag, f, q.withFilter, q.tags); });
  // The block holds buttons, so it is no button itself, but acts as one.
  blk.tabIndex = 0;
  blk.setAttribute('role', 'button');
  blk.addEventListener('keydown', e => {
    if (e.target === blk && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); blk.click(); }
  });
  if (reopen && reopen.sec === q.sec.id && reopen.tag === tag) {
    reopen = null;
    // The old popup belongs to the card that was just replaced: drop it quietly.
    if (popup) { popup.el.remove(); popup = null; }
    requestAnimationFrame(() => valuesPopup(q.sec, blk, tag, f, q.withFilter, q.tags));
  }
  return blk;
}

// groupBlock is "agg by tag, tag ×" or "agg without tag ×", as in PromQL:
// by keeps the tags and combines over the others, without combines over
// them. A click on agg picks how the series combine, on by or without
// switches the mode.
function groupBlock(q) {
  const { st, m, save } = q;
  const blk = $('span', 'blk group');
  const agg = $('button', 'agg', m.agg);
  agg.title = 'How the series of one line are combined';
  agg.addEventListener('click', e => {
    e.stopPropagation();
    const menu = $('div', 'menu');
    for (const a of AGG_NAMES) {
      const it = $('button', 'item' + (a === m.agg ? ' on' : ''), a);
      it.addEventListener('click', () => { closePopup(); save({ ...st, agg: a }); });
      menu.append(it);
    }
    openPopup(agg, menu);
  });
  const { mode, tags } = st.group;
  const op = $('button', 'op', mode);
  op.disabled = !tags.length;
  op.title = !tags.length ? 'by (): one line. Add a tag to switch to without'
    : mode === 'by' ? 'by keeps these tags: switch to without, which combines over them'
      : 'without combines over these tags: switch to by, which keeps them';
  op.addEventListener('click', e => { e.stopPropagation(); save(switchMode(st)); });
  blk.append(agg, op);
  if (!tags.length) blk.append($('span', 'gtag all', '()'));
  for (const tag of tags) {
    const t = $('span', 'gtag', tag);
    t.append(xButton(mode === 'by' ? `Stop keeping ${tag}` : `Stop combining over ${tag}`, () => save(withoutGroupTag(st, tag))));
    blk.append(t);
  }
  blk.append(xButton('Remove grouping: a line per series', () => save({ ...st, group: null, agg: null })));
  return blk;
}

// addMenu opens on a click on the free space of the line: kinds on the left,
// the tag keys of the chosen kind on the right.
function addMenu(q, bar, x) {
  const { st, filter, save, tags } = q;
  const pop = $('div', 'cascade');
  const kinds = $('div', 'menu'), keys = $('div', 'menu');
  keys.hidden = true;
  const showKeys = (kind, btn) => {
    for (const b of kinds.children) b.classList.toggle('on', b === btn);
    keys.hidden = false;
    keys.textContent = '';
    for (const [tag, values] of tags) {
      if (kind === 'filter' && filter[tag]) continue;
      if (kind !== 'filter' && st.group?.tags.includes(tag)) continue;
      const k = $('button', 'item', tag);
      k.append($('span', 'n', String(values.length)));
      k.addEventListener('click', () => {
        closePopup();
        if (kind === 'filter') {
          reopen = { sec: q.sec.id, tag };
          q.withFilter(tag, { op: '=', values: [] });
        } else {
          save(withGroupTag(st, tag, kind));
        }
      });
      keys.append(k);
    }
    if (!keys.children.length) keys.append($('span', 'none', 'no more tags'));
    fitPopup(pop);
  };
  // A section has one grouping: while it has none, by or without starts it;
  // then a tag joins it in its mode.
  const groupKinds = st.group ? [[st.group.mode, `group ${st.group.mode}`]] : [['by', 'group by'], ['without', 'group without']];
  for (const [kind, label] of [['filter', 'filter'], ...groupKinds]) {
    const b = $('button', 'item more', label);
    b.addEventListener('click', ev => { ev.stopPropagation(); showKeys(kind, b); });
    kinds.append(b);
  }
  pop.append(kinds, keys);
  openPopup(bar, pop);
  pop.style.left = `${Math.max(8, x - 20) + scrollX}px`;
  fitPopup(pop);
}

// valuesPopup edits the values of a filter block: type a value or a * mask and
// press Enter, or click a known value. The block goes away if it has no value
// when the popup closes.
function valuesPopup(sec, blk, tag, f, withFilter, tags) {
  const box = $('div', 'menu values');
  const input = $('input');
  input.placeholder = 'value or mask*';
  box.append(input);
  const list = $('div');
  box.append(list);
  const set = values => { reopen = { sec: sec.id, tag }; withFilter(tag, { ...f, values }); };
  const fill = () => {
    list.textContent = '';
    const q = input.value.trim();
    for (const v of tags.get(tag) || []) {
      // A * in the input is a mask, as in the filter itself; else part of the value.
      if (q && !(q.includes('*') ? matchValue(v, q) : v.includes(q))) continue;
      const on = f.values.includes(v);
      const it = $('button', 'item' + (on ? ' on' : ''), (on ? '✓ ' : '') + (v === '' ? '(none)' : v));
      it.addEventListener('click', () => set(on ? f.values.filter(x => x !== v) : [...f.values, v]));
      list.append(it);
    }
    for (const v of f.values) if (!(tags.get(tag) || []).includes(v)) {
      const it = $('button', 'item on', '✓ ' + v);
      it.title = 'A mask or a value not seen now';
      it.addEventListener('click', () => set(f.values.filter(x => x !== v)));
      list.append(it);
    }
  };
  input.addEventListener('input', fill);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) {
      const v = input.value.trim();
      if (!f.values.includes(v)) set([...f.values, v]);
    }
  });
  fill();
  openPopup(blk, box, () => {
    // A filter left without a value is dropped.
    const cur = sectionState(sec).filter?.[tag];
    if (cur && !cur.values.length) withFilter(tag, null);
  });
  input.focus();
}

// ---------- tiles ----------

// A tile shows series, not the lines of the query bar: the latest value of
// its field in each group the filter keeps, combined over the groups with
// the agg of the tile (see tileValue).
function tileView(sec, tile, m) {
  const t = new Tile({ title: tile.title });
  addView({ update() {
    const home = first(m.groups, tile.field);
    if ((sec.text || []).includes(tile.field)) {
      t.set({ value: home ? textOf(home, tile.field) ?? '–' : '–', sub: partsText(sec, tile.sub, home, null), level: '' });
      return;
    }
    const { value, level } = tileValue(tile, m.groups, valueOf);
    t.set({ value: fmt(sec.units?.[tile.field], value), sub: partsText(sec, tile.sub, home, null), level });
  } });
  return t.el;
}

// ---------- charts ----------

function chartView(sec, c, m) {
  const card = $('div', 'chart');
  const head = $('div', 'chart-head');
  head.append($('span', 'title', c.title));
  if (c.hint) head.append($('span', 'hint', c.hint));
  const key = sec.id + '|' + c.title;
  const bucketsOf = f => m.buckets.filter(b => has(b, f));
  const total = c.fields.reduce((n, f) => n + bucketsOf(f).length, 0);
  // band is a way to combine the series of a line (the group block); a
  // stacked chart draws the average instead.
  const banded = m.agg === 'band' && !c.stacked;
  if (!c.stacked && (banded || total > BAND_ABOVE)) {
    const btn = $('button', 'lines-toggle', banded ? 'lines' : 'band');
    btn.title = banded ? 'A line per series: remove the grouping from the query bar'
      : 'Sets "band by ()" in the query bar: one band, min–max and the average of each field';
    btn.addEventListener('click', () => {
      const st = sectionState(sectionById(sec.id) ?? sec); // now, not when the card was built
      if (banded) setSection(sec, { ...st, group: null, agg: null });
      else setSection(sec, { ...st, group: { mode: 'by', tags: [] }, agg: 'band' });
    });
    head.append(btn);
  }
  // Lines above chart_lines are not drawn: the chart says how many.
  const cut = $('span', 'hint cut');
  head.append(cut);
  const plot = $('div', 'plot');
  card.append(head, plot);
  const chart = new Chart(plot, { unit: c.unit, min: c.min, max: c.max, minMax: c.minMax, stacked: c.stacked, tipLines: data.layout.tipLines }, key);
  part.charts.push(chart);
  // Tags with one value for all lines (host …): the popup shows them once.
  const common = {};
  for (const [k, vs] of allTagValues(m.buckets.flatMap(b => b.groups))) if (vs.length === 1 && vs[0] !== '') common[k] = vs[0];
  const home = f => m.buckets.find(b => has(b, f));
  const lastOf = f => latestOf(home(f), f, aggOf(sec, m.agg, f));

  // The lines of the chart, made once per card: a line per field and
  // bucket, with the ids of its series and its combination, which each
  // write updates only from the first changed time on.
  const specs = [];
  let color = 0;
  c.fields.forEach((field, fi) => {
    const bs = bucketsOf(field), name = c.labels?.[fi] || field;
    for (const b of bs) {
      let label = name;
      if (bs.length > 1) label = c.fields.length === 1 ? (b.label || label) : `${label} ${b.label}`;
      const members = b.groups.filter(g => g.series[field] != null);
      const agg = aggOf(sec, m.agg, field);
      // What the hover popup tells about the line: its field, its tags and,
      // for several series, how they were combined.
      const about = { field: c.fields.length > 1 ? name : '', tags: b.tags, of: members.length };
      const ids = members.map(g => g.series[field]);
      // The line's series as a band (min–max) and their average, in one colour.
      const isBand = !c.stacked && agg === 'band' && members.length > 1;
      const how = isBand ? null : agg === 'band' ? 'avg' : agg;
      specs.push({ label, color, about, ids, isBand, how, pre: c.fields.length > 1 || bs.length > 1 ? label + ' ' : '', comb: new Combined(isBand ? 'band' : how) });
      color++;
    }
  });
  const allIds = specs.flatMap(sp => sp.ids);

  // A reply that brought the measurement no changes, and a tick of the
  // page's clock, only move the time axis; the lines are combined again
  // only when their series changed.
  let drawn = -1; // the merge the lines were made after
  addView({ update() {
    const t1 = data.clock(), t0 = t1 - range();
    if (drawn >= 0 && !chart.redraw && !data.changedSince(sec.measurement, drawn)) {
      chart.slide(t0, t1);
      return;
    }
    const from = drawn < 0 ? -Infinity : data.changedFrom(allIds, drawn);
    if (from === undefined && !chart.redraw) {
      drawn = data.seq;
      chart.slide(t0, t1);
      return;
    }
    chart.redraw = false;
    drawn = data.seq;
    const cutoff = t1 - data.layout.windowMs;
    let lines = [];
    for (const sp of specs) {
      if (from !== undefined) sp.comb.update(sp.ids.map(id => data.pts.get(id)), from, cutoff);
      if (sp.isBand) {
        const r = sp.comb.out;
        lines.push({ label: sp.pre + 'avg', points: r.mid, color: sp.color, about: { ...sp.about, how: 'avg' } },
          { label: sp.pre + 'max', points: r.hi, color: sp.color, band: 'hi', about: { ...sp.about, how: 'max' } },
          { label: sp.pre + 'min', points: r.lo, color: sp.color, band: 'lo', about: { ...sp.about, how: 'min' } });
      } else {
        lines.push({ label: sp.label, points: sp.comb.line, color: sp.color, about: { ...sp.about, how: sp.how } });
      }
    }
    const capped = capLines(lines, data.layout.chartLines, l => peak(l.points, t0));
    lines = capped.lines;
    cut.textContent = capped.hidden ? `+${capped.hidden} lines not drawn` : '';
    cut.title = capped.hidden ? `The chart draws the ${data.layout.chartLines} lines with the highest peak; filter or group the series to see the others` : '';
    chart.update({
      lines, common, t0, t1,
      maxValue: c.maxField ? lastOf(c.maxField) : undefined,
      refs: (c.refs || []).map(r => ({ label: r.label, value: r.value ?? lastOf(r.field) })),
    });
  } });
  return card;
}

// ---------- polling ----------

// neededMeasurements is what the page asks changes for: the measurements of
// the open sections of the tab. The overview shows statuses only.
function neededMeasurements() {
  const tab = activeTab();
  if (tab.id === 'overview') return [];
  return [...new Set((tab.sections || []).filter(s => !s.empty && !isCollapsed(s)).map(s => s.measurement))];
}

function update() {
  for (const p of parts) for (const v of p.views) v.update();
}

// ---------- talking to the plugin ----------

// One request for changes at a time: it waits on the server for the next
// write and brings the changes of the measurements on screen and the
// statuses. A new set of measurements (another tab, a section opened or
// closed) aborts it and asks again at once; a hidden page asks nothing.
const WAIT_S = 25;
let waiting = null;  // AbortController of the request in flight
let wake = null;     // ends the pause of a hidden page
let sleeping = null; // ends the pause before a retry
let retryMs = 0;

// kick makes the loop ask again now, for the measurements on screen now,
// also in the pause before a retry.
function kick() {
  if (waiting) waiting.abort();
  if (sleeping) sleeping();
}

// pause waits ms before a retry, or until kick.
const pause = ms => new Promise(resolve => {
  const timer = setTimeout(() => { sleeping = null; resolve(); }, ms);
  sleeping = () => { clearTimeout(timer); sleeping = null; resolve(); };
});

// loop asks, waits and draws, for as long as the page is open. A request
// that fails (the plugin out of reach, an HTTP error) is retried after a
// pause that doubles from 2 s to 30 s; an error while drawing is shown as
// an error of the page, not as "offline".
async function loop() {
  for (;;) {
    if (document.hidden) await new Promise(resolve => { wake = resolve; });
    const ctl = new AbortController();
    waiting = ctl;
    let rebuild = false;
    try {
      if (!data.layout) rebuild = await data.loadLayout();
      const version = await data.fetch(neededMeasurements(), { wait: WAIT_S, signal: ctl.signal });
      // A new layout (series came or went, the config was reloaded) or a new
      // server process.
      if (version !== data.layout.version) rebuild = await data.loadLayout() || rebuild;
    } catch (e) {
      if (ctl.signal.aborted) continue; // another set, or the page went hidden
      console.error(e);
      renderStatus('offline');
      retryMs = Math.min(retryMs ? 2 * retryMs : 2000, 30000);
      await pause(retryMs);
      continue;
    } finally {
      if (waiting === ctl) waiting = null;
    }
    retryMs = 0;
    try {
      // The first layout is drawn once a reply came: before, a failed
      // request left it loaded but not drawn.
      if (rebuild || !shownTab) refresh();
      else renderTop(); // the statuses on the tabs
      renderStatus();
      update();
      if (pendingScroll) {
        pendingScroll = false;
        scrollToSection();
      }
    } catch (e) {
      console.error(e);
      renderStatus('page');
    }
  }
}

// The page's own clock: once a second, while the page is seen, the time axes
// move to now and the ages count on; no request. The lines are combined
// again only when a reply brought changes.
setInterval(() => { if (!document.hidden && data.layout) update(); }, 1000);

addEventListener('visibilitychange', () => {
  if (document.hidden) {
    kick();
    return;
  }
  if (wake) { wake(); wake = null; }
  if (data.layout) update();
});

// showTab draws the tab at once from the points the page has, and asks the
// server for what it lacks. A section link scrolls now when the tab's
// measurements are loaded, else after the reply that loads them.
function showTab() {
  render();
  update();
  if (pendingScroll && neededMeasurements().every(m => data.since.has(m))) {
    pendingScroll = false;
    scrollToSection();
  }
  kick();
}

// A link with another hash (a chip on the overview, the back button) opens its
// tab, and its section if it names one.
addEventListener('hashchange', () => {
  state = parseHash(location.hash);
  pendingScroll = true;
  showTab();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); update(); });
loop();
