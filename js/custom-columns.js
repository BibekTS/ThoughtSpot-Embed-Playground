/**
 * custom-columns.js — "Customize Columns": one Liveboard table tile, re-rendered as a native
 * ThoughtSpot table whose columns each user can hide and reorder (saved per user).
 *
 * The tile's saved search query (from the Liveboard's TML) is split into COLUMN tokens the user may
 * hide/reorder and everything else (filters, sort, top-N, anything unrecognised), which is always
 * kept verbatim. The rebuilt token string drives a SearchEmbed with the search bar hidden.
 *
 * Pure logic + the dialog live here; js/app.js owns the fetching, caching and rendering. This
 * module must not touch document/localStorage at import time.
 */

// ── Query → columns (emitted into the generated snippet via Function.prototype.toString) ──────────
// The three functions between the markers are pasted into the SDK-code view as-is, so they must stay
// SELF-CONTAINED (JS globals and each other only) and must not mention any SDK identifier, even in a
// comment: the boot-check import-gap scan reads the emitted text.
// @emit-start
export function splitTileQuery(q) {
  const src = String(q ?? '');
  const fail = { ok: false, query: src, columns: [], remainder: src.trim() ? [src.trim()] : [], sortKeys: new Set() };
  if (src.length > 10000) return fail;
  const BUCKETS = new Set(['hourly', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'detailed', 'hour of day', 'day of week',
    'day of month', 'day of quarter', 'day of year', 'week of month', 'week of quarter', 'week of year', 'month of quarter', 'month of year', 'quarter of year']);
  const AGGS = [['unique', 'count'], ['std', 'deviation'], ['count'], ['sum'], ['average'], ['avg'], ['max'], ['min'], ['variance']];
  const STARTS = new Set(['sort', 'top', 'bottom', 'unique', 'std', 'count', 'sum', 'average', 'avg', 'max', 'min', 'variance']);
  const FILTER_WORDS = new Set(['in', 'not', 'contains', 'begins', 'ends', 'with', 'between', 'and', 'after', 'before', 'like', 'is', 'null']);
  const LINK = new Set(['of', 'by', 'for', 'each', 'vs', 'versus', 'per', 'than']);
  const DIRS = new Set(['ascending', 'descending', 'asc', 'desc']);
  // Prefix keywords that bind to the column or aggregate after them ("cumulative sum [x]"). Moving
  // columns around would strand them, so a query using one outside a filter/sort/top clause is
  // treated as unreadable (shown unchanged) whenever it has columns to customize.
  const MODS = new Set(['cumulative', 'moving', 'growth']);
  const re = /\s+|(\[[^\[\]]+\](?:\.(?:'[^']*'|[A-Za-z_][\w-]*))?)|('[^']*'|"[^"]*")|(>=|<=|!=|<>|=|<|>)|(-?\d+(?:\.\d+)?)(?![\w.])|([A-Za-z_][\w-]*)|([(),])/y;
  const L = [];
  for (re.lastIndex = 0; re.lastIndex < src.length;) {
    const s = re.lastIndex, m = re.exec(src);
    if (!m) return fail;
    if (!m[0].trim()) continue;
    const x = { s, e: re.lastIndex, v: m[0] };
    if (m[1]) { const b = m[1].indexOf(']'); x.t = 'col'; x.base = m[1].slice(1, b).trim(); x.suf = m[1].slice(b + 2).replace(/^'|'$/g, '').toLowerCase(); }
    else if (m[2]) x.t = 'str'; else if (m[3]) x.t = 'op'; else if (m[4]) x.t = 'num';
    else if (m[5]) { x.t = 'word'; x.lv = m[5].toLowerCase(); } else x.t = 'punct';
    L.push(x);
  }
  const groups = new Map(), remainder = [], safe = new Set(), sortBases = new Set();
  let risky = false;
  // `clause` marks a filter/sort/top clause: its words are known not to modify a neighbouring column.
  const keep = (a, b, clause) => { remainder.push(src.slice(L[a].s, L[b].e)); if (clause) for (let k = a; k <= b; k++) safe.add(k); };
  const w = (k) => (L[k] && L[k].t === 'word' ? L[k].lv : '');
  const isColTok = (k) => !!L[k] && L[k].t === 'col' && (!L[k].suf || BUCKETS.has(L[k].suf));
  const freeAfter = (k) => !L[k + 1] || L[k + 1].t === 'col' || STARTS.has(w(k + 1));
  const parenEnd = (k) => { let d = 0; for (let j = k; j < L.length; j++) { if (L[j].v === '(') d++; else if (L[j].v === ')' && --d === 0) return j; } return L.length - 1; };
  const filterEnd = (k) => {
    let j = k;
    while (L[j + 1] && (L[j + 1].t === 'op' || FILTER_WORDS.has(w(j + 1)))) j++;
    if (L[j + 1] && L[j + 1].v === '(') return parenEnd(j + 1);
    if (L[j + 1] && L[j + 1].t !== 'punct' && !STARTS.has(w(j + 1))) j++;
    while (L[j + 1]) {
      if (L[j + 1].t === 'str') { j++; continue; }
      if (w(j + 1) === 'and' && L[j + 2] && (L[j + 2].t === 'str' || L[j + 2].t === 'num')) { j += 2; continue; }
      break;
    }
    return j;
  };
  const runEnd = (k) => {
    let j = k;
    while (L[j + 1]) {
      const y = L[j + 1];
      if (y.t === 'num' || y.t === 'str' || (y.t === 'word' && !STARTS.has(y.lv))) { j++; continue; }
      if (y.t === 'col' && LINK.has(w(j))) { j++; continue; }
      break;
    }
    return j;
  };
  const add = (a, b, col, agg) => {
    // A free word right before a column/aggregate may modify it; moving the column would detach it.
    const p = L[a - 1];
    if (p && p.t === 'word' && !STARTS.has(p.lv) && !DIRS.has(p.lv) && !safe.has(a - 1)) risky = true;
    const key = (agg ? agg + ' ' : '') + col.base.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = { key, base: col.base.toLowerCase(), label: (agg ? agg + ' ' : '') + col.base, tokens: [], agg: !!agg }; groups.set(key, g); }
    g.tokens.push(src.slice(L[a].s, L[b].e));
    if (col.suf && !agg) g.label = col.base + ' (' + col.suf + ')';
  };
  for (let i = 0; i < L.length;) {
    const x = L[i];
    if (x.t === 'col') {
      const nx = L[i + 1];
      if (nx && (nx.t === 'op' || FILTER_WORDS.has(w(i + 1)))) { const j = filterEnd(i + 1); keep(i, j, true); i = j + 1; continue; }
      if (isColTok(i) && freeAfter(i)) { add(i, i, x, ''); i++; continue; }
      const j = runEnd(i); keep(i, j); i = j + 1; continue;
    }
    if (x.t === 'word') {
      const agg = AGGS.find((p) => p.every((pw, n) => w(i + n) === pw));
      if (agg && isColTok(i + agg.length) && freeAfter(i + agg.length)) { add(i, i + agg.length, L[i + agg.length], agg.join(' ')); i += agg.length + 1; continue; }
      if (x.lv === 'sort' && w(i + 1) === 'by' && L[i + 2] && L[i + 2].t === 'col') { let j = i + 2; if (DIRS.has(w(j + 1))) j++; sortBases.add(L[i + 2].base.toLowerCase()); keep(i, j, true); i = j + 1; continue; }
      if ((x.lv === 'top' || x.lv === 'bottom') && L[i + 1] && L[i + 1].t === 'num') { keep(i, i + 1, true); i += 2; continue; }
      const j = runEnd(i); keep(i, j); i = j + 1; continue;
    }
    if (x.v === '(') { const j = parenEnd(i); keep(i, j); i = j + 1; continue; }
    keep(i, i); i++;
  }
  const columns = [...groups.values()];
  if (L.some((x, k) => x.t === 'word' && MODS.has(x.lv) && !safe.has(k))) risky = true;
  if (columns.length > 200 || (risky && columns.length)) return fail;
  // Columns a kept sort clause refers to can't be hidden (the sort would fail or bring them back).
  return { ok: true, query: src, columns, remainder, sortKeys: new Set(columns.filter((c) => sortBases.has(c.base)).map((c) => c.key)) };
}
// Attributes first, then measures (that is how the table lays them out anyway); the first default
// column is pinned. A saved order only reorders inside those groups; unknown keys are dropped.
export function orderColumns(split, measures, order) {
  const keys = split.columns.map((c) => c.key), isM = (k) => measures.has(k);
  const def = [...keys.filter((k) => !isM(k)), ...keys.filter(isM)];
  if (!def.length) return [];
  const known = new Set(keys);
  const seen = (Array.isArray(order) ? order : []).filter((k) => known.has(k));
  const rest = [...new Set([...seen, ...def])].filter((k) => k !== def[0]);
  return [def[0], ...rest.filter((k) => !isM(k)), ...rest.filter(isM)];
}
// The token string to search: visible columns in the user's order, then every kept clause verbatim.
// An untouched layout returns the tile's own query unchanged.
export function tileTokenString(split, measures, prefs) {
  const p = prefs || {};
  if (!split.ok || !split.columns.length) return split.query;
  const order = orderColumns(split, measures, p.order);
  const hidden = new Set((Array.isArray(p.hidden) ? p.hidden : []).filter((k) => k !== order[0] && !split.sortKeys.has(k)));
  if (!order.some((k) => hidden.has(k)) && JSON.stringify(order) === JSON.stringify(orderColumns(split, measures, []))) return split.query;
  const byKey = new Map(split.columns.map((c) => [c.key, c]));
  return [...order.filter((k) => !hidden.has(k)).flatMap((k) => byKey.get(k).tokens), ...split.remainder].join(' ');
}
// @emit-end

// ── Tile builder: Liveboard TML → the tile's query, model and column kinds ───────────────────────
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user GUID a SearchEmbed CustomAction payload carries (verified live), or '' when absent/invalid. */
export function userGuidFromPayload(payload) {
  const g = payload?.data?.embedAnswerData?.user?.userGUID;
  return typeof g === 'string' && GUID_RE.test(g) ? g : '';
}

/** Find the tile in the exported Liveboard TML. → { ok, modelId, answer } | { ok:false, error } */
export function findTileViz(lb, vizId) {
  const viz = (Array.isArray(lb?.visualizations) ? lb.visualizations : []).find((v) => v?.viz_guid === vizId);
  if (!viz) return { ok: false, error: 'Visualization not found in this Liveboard’s TML (note tile, or another Liveboard?)' };
  const answer = viz.answer && typeof viz.answer === 'object' ? viz.answer : {};
  if (typeof answer.search_query !== 'string' || !answer.search_query.trim()) {
    return { ok: false, error: 'This tile has no search query (note, SQL or Spotter-based answer)' };
  }
  const fqn = answer.tables?.[0]?.fqn;
  if (typeof fqn !== 'string' || !GUID_RE.test(fqn)) return { ok: false, error: 'Couldn’t resolve the tile’s data source' };
  return { ok: true, modelId: fqn, answer };
}

/** Build the tile model. `kinds` = Map(lower-cased column name → 'ATTRIBUTE' | 'MEASURE'). */
export function tileFromTml(lb, vizId, kinds) {
  const f = findTileViz(lb, vizId);
  if (!f.ok) return f;
  const k = kinds instanceof Map ? kinds : new Map();
  const split = splitTileQuery(f.answer.search_query);
  const measures = new Set(split.columns.filter((c) => c.agg || k.get(c.key) === 'MEASURE').map((c) => c.key));
  const formulas = new Set((Array.isArray(f.answer.formulas) ? f.answer.formulas : [])
    .map((x) => (typeof x?.name === 'string' ? x.name.toLowerCase() : '')).filter(Boolean));
  return {
    ok: true,
    name: String(f.answer.name || 'Table'),
    liveboardName: String(lb?.name || ''),
    modelId: f.modelId,
    split,
    measures,
    // A formula column isn't in the model's column list, so its kind is unknown → treated as an attribute.
    formulaAsAttr: split.columns.some((c) => formulas.has(c.key) && !k.has(c.key)),
    kindsKnown: k.size > 0,
  };
}

// ── Per-user preferences (this browser) ───────────────────────────────────────────────────────────
// A convenience store, like the drill-through presets: NOT shareable state, so it never goes through
// state.js or the #s= hash. Keyed `${host}|${userGuid}|${vizId}`. A real app saves this server-side.
export const COL_PREFS_KEY = 'tsp_colprefs_v1';
const MAX_PREF_ENTRIES = 200;
const strList = (v) => (Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 256) ? v : []);

function readAll() {
  try {
    const obj = JSON.parse(localStorage.getItem(COL_PREFS_KEY) || 'null');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) { return {}; }
}

/** → { hidden: string[], order: string[] } (empty when absent or malformed). */
export function readColPrefs(prefKey) {
  const all = readAll();
  const p = Object.prototype.hasOwnProperty.call(all, prefKey) ? all[prefKey] : null;
  if (!p || typeof p !== 'object') return { hidden: [], order: [] };
  return { hidden: [...strList(p.hidden)], order: [...strList(p.order)] };
}

/** Save (or with `null`, delete) one tile's prefs. → false when storage is blocked/full. */
export function writeColPrefs(prefKey, prefs) {
  if (!/^https?:\/\//.test(String(prefKey))) return false;
  const all = readAll();
  if (prefs === null) delete all[prefKey];
  else all[prefKey] = { hidden: strList(prefs?.hidden), order: strList(prefs?.order), updatedAt: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_PREF_ENTRIES) {
    const age = (k) => (typeof all[k]?.updatedAt === 'number' ? all[k].updatedAt : 0);
    keys.sort((a, b) => age(a) - age(b)).slice(0, keys.length - MAX_PREF_ENTRIES).forEach((k) => { delete all[k]; });
  }
  try { localStorage.setItem(COL_PREFS_KEY, JSON.stringify(all)); return true; } catch (_) { return false; }
}

// ── The "Customize Columns" dialog ───────────────────────────────────────────────────────────────
// Static icon markup only (never interpolated).
const GRIP = '<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="7" r="1.3"/><circle cx="7.5" cy="7" r="1.3"/><circle cx="2.5" cy="11.5" r="1.3"/><circle cx="7.5" cy="11.5" r="1.3"/></g></svg>';
const LOCK = '<svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="6" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M3.2 6V4.3a2.8 2.8 0 015.6 0V6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

/**
 * Open the dialog. Every ThoughtSpot-derived string (column labels, tile name) goes in via
 * textContent / setAttribute. `onApply({hidden, order})` returns false when saving failed, which
 * keeps the dialog open with an error; on success the dialog closes, then `onApplied()` runs (the
 * caller re-renders there). Closing refocuses the opener, else `fallbackFocus()`'s element.
 */
export function openColumnsDialog({ tile, prefs, userLabel, onApply, onApplied, fallbackFocus }) {
  document.getElementById('cc-modal')?.remove();
  const h = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const txt = (tag, cls, t) => { const n = h(tag, cls); n.textContent = t; return n; };
  const btn = (cls, t) => { const b = txt('button', cls, t); b.type = 'button'; return b; };

  const { split, measures } = tile;
  const byKey = new Map(split.columns.map((c) => [c.key, c]));
  const isM = (k) => measures.has(k);
  const defOrder = () => orderColumns(split, measures, []);
  const locked = defOrder()[0];
  const sortKeys = split.sortKeys || new Set();
  const hideable = (k) => k !== locked && !sortKeys.has(k);
  const usable = split.ok && split.columns.length > 0;
  let draft = {
    hidden: new Set(((prefs && prefs.hidden) || []).filter((k) => byKey.has(k) && hideable(k))),
    order: orderColumns(split, measures, prefs && prefs.order),
  };
  let dragKey = null;
  const opener = document.activeElement;

  const modal = h('div', 'modal'); modal.id = 'cc-modal';
  const scrim = h('div', 'modal-scrim');
  const panel = h('div', 'modal-panel modal-panel--center cc-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'cc-title');
  panel.tabIndex = -1; // a click on a non-control keeps focus inside the dialog (Escape/Tab still work)

  const head = h('div', 'modal-head');
  const htxt = h('div');
  const title = txt('h2', 'modal-title', 'Customize Columns'); title.id = 'cc-title';
  htxt.append(title, txt('div', 'modal-sub', `Saved in this browser for ${userLabel} · ${tile.name}`));
  const xbtn = btn('modal-close', '✕'); xbtn.setAttribute('aria-label', 'Close');
  head.append(htxt, xbtn);

  const tools = h('div', 'cc-tools');
  const search = h('input', 'inp cc-search');
  search.type = 'search'; search.placeholder = 'Search fields'; search.setAttribute('aria-label', 'Search fields');
  const reset = btn('sec-apply ghost', 'Reset to default');
  tools.append(search, reset);

  const body = h('div', 'cc-body');
  const checks = h('ul', 'cc-list');
  const order = h('ul', 'cc-list cc-order'); order.setAttribute('aria-describedby', 'cc-hint');
  const toggle = btn('cc-link', '');
  const hint = txt('p', 'cc-hint', 'Drag to reorder, or focus a field and press Alt+↑/↓. Measures always appear after attributes. Filters, sort and top-N from the tile are always kept.'
    + (tile.formulaAsAttr ? ' Formula columns are ordered as attributes.' : '')
    + (tile.kindsKnown ? '' : ' Column types unavailable; ThoughtSpot may reorder attributes and measures.'));
  hint.id = 'cc-hint';
  if (usable) {
    const left = h('section', 'cc-pane'), right = h('section', 'cc-pane');
    const lh = h('div', 'cc-pane-head'); lh.append(txt('h3', '', 'Report columns'), toggle);
    const rh = h('div', 'cc-pane-head'); rh.append(txt('h3', '', 'Field order'));
    left.append(lh, checks);
    right.append(rh, order, hint);
    body.append(left, right);
  } else {
    body.append(txt('p', 'cc-empty', split.ok
      ? 'This tile has no columns that can be customized.'
      : 'This tile’s query couldn’t be read safely, so it’s shown unchanged.'));
  }

  const foot = h('div', 'modal-foot');
  const err = h('span', 'cc-err'); err.setAttribute('role', 'alert');
  const cancel = btn('sec-apply ghost', 'Cancel');
  const apply = btn('sec-apply', 'Apply');
  foot.append(err, cancel, apply);
  const live = h('p', 'cc-live'); live.setAttribute('aria-live', 'polite');
  if (!usable) { apply.disabled = true; reset.disabled = true; search.disabled = true; }

  panel.append(head, tools, body, foot, live);
  modal.append(scrim, panel);

  // A trailing zero-width space toggles so a repeated identical message is announced again.
  const announce = (msg) => { live.textContent = live.textContent === msg ? msg + '\u200b' : msg; };
  const SORT_NOTE = 'Used by the tile’s sort, so it can’t be hidden';
  const sortTag = () => txt('span', 'cc-tag', 'used for sort');
  const label = (k) => byKey.get(k).label;

  function syncToggle() {
    const anyShown = split.columns.some((c) => hideable(c.key) && !draft.hidden.has(c.key));
    toggle.textContent = anyShown ? 'Deselect all' : 'Select all';
  }
  function paintChecks() {
    const q = search.value.trim().toLowerCase();
    checks.replaceChildren();
    // The left list stays in the tile's default order so fields are easy to find.
    for (const k of defOrder()) {
      if (q && !label(k).toLowerCase().includes(q)) continue;
      const li = h('li', 'cc-check' + (k === locked ? ' locked' : ''));
      const lab = h('label');
      const cb = h('input'); cb.type = 'checkbox'; cb.checked = !draft.hidden.has(k);
      if (k === locked) { cb.disabled = true; lab.title = 'Always shown first'; }
      else if (sortKeys.has(k)) { cb.disabled = true; lab.title = SORT_NOTE; }
      cb.addEventListener('change', () => {
        if (cb.checked) draft.hidden.delete(k); else draft.hidden.add(k);
        paintOrder(); syncToggle();
      });
      lab.append(cb, document.createTextNode(label(k)));
      if (k !== locked && sortKeys.has(k)) lab.append(sortTag());
      li.append(lab);
      checks.append(li);
    }
    if (!checks.children.length) checks.append(txt('li', 'cc-empty', `No fields match “${search.value.trim()}”`));
    syncToggle();
  }
  function paintOrder() {
    order.replaceChildren();
    let inMeasures = false;
    for (const k of draft.order.filter((x) => !draft.hidden.has(x))) {
      if (k !== locked && isM(k) && !inMeasures) {
        const g = txt('li', 'cc-group', 'Measures'); g.setAttribute('role', 'presentation');
        order.append(g); inMeasures = true;
      }
      const li = h('li', 'cc-row');
      li.dataset.key = k;
      const icon = h('span', k === locked ? 'cc-lock' : 'cc-grip');
      icon.innerHTML = k === locked ? LOCK : GRIP; // static constants only
      const name = txt('span', 'cc-name', label(k));
      if (k === locked) {
        li.classList.add('locked');
        li.setAttribute('title', 'Always shown first');
        li.append(icon, name);
      } else {
        li.draggable = true; li.tabIndex = 0;
        li.setAttribute('aria-label', `${label(k)}. Alt plus arrow keys to move.${sortKeys.has(k) ? ' Used for sort, can’t be hidden.' : ''}`);
        li.append(icon, name);
        if (sortKeys.has(k)) { li.title = SORT_NOTE; li.append(sortTag()); }
        else {
          const rm = btn('cc-remove', '−');
          rm.setAttribute('aria-label', `Hide ${label(k)}`);
          rm.setAttribute('title', 'Hide');
          rm.addEventListener('click', () => {
            // The row (and this button) is about to be re-rendered away: move focus to the next
            // row's (−), else the previous one's, else the search box — never let it fall to <body>.
            const ks = [...order.querySelectorAll('li.cc-row')].filter((n) => n.querySelector('.cc-remove')).map((n) => n.dataset.key);
            const i = ks.indexOf(k), to = ks[i + 1] ?? ks[i - 1];
            draft.hidden.add(k); paint(); announce(`${label(k)} hidden.`);
            ((to && order.querySelector(`li[data-key="${CSS.escape(to)}"] .cc-remove`)) || search).focus();
          });
          li.append(rm);
        }
        li.addEventListener('dragstart', (e) => { dragKey = k; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); });
        li.addEventListener('dragend', () => { dragKey = null; li.classList.remove('dragging'); clearDrop(); });
        li.addEventListener('dragover', (e) => { if (canDrop(k)) { e.preventDefault(); clearDrop(); li.classList.add('drop-before'); } });
        li.addEventListener('drop', (e) => { e.preventDefault(); if (canDrop(k)) moveBefore(dragKey, k); });
        li.addEventListener('keydown', (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault(); nudge(k, e.key === 'ArrowUp' ? -1 : 1);
        });
      }
      order.append(li);
    }
  }
  const paint = () => { paintChecks(); paintOrder(); };
  const clearDrop = () => order.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'));
  // Reordering stays inside a group: measures always come after attributes.
  const canDrop = (target) => !!dragKey && dragKey !== target && target !== locked && isM(dragKey) === isM(target);
  function moveBefore(src, target) {
    const o = draft.order.filter((k) => k !== src);
    o.splice(o.indexOf(target), 0, src);
    draft.order = orderColumns(split, measures, o);
    paintOrder();
    // The repaint removed the dragged row (focused by its mousedown): refocus it so Escape/Tab work.
    order.querySelector(`li[data-key="${CSS.escape(src)}"]`)?.focus();
    announce(`${label(src)} moved.`);
  }
  function nudge(k, dir) {
    const peers = draft.order.filter((x) => x !== locked && !draft.hidden.has(x) && isM(x) === isM(k));
    const i = peers.indexOf(k), j = i + dir;
    if (j < 0 || j >= peers.length) return;
    const o = [...draft.order];
    const a = o.indexOf(k), b = o.indexOf(peers[j]);
    [o[a], o[b]] = [o[b], o[a]];
    draft.order = orderColumns(split, measures, o);
    paintOrder();
    order.querySelector(`li[data-key="${CSS.escape(k)}"]`)?.focus();
    announce(`${label(k)}, position ${j + 1} of ${peers.length} ${isM(k) ? 'measures' : 'attributes'}.`);
  }

  function close() {
    modal.remove();
    const to = opener && opener.isConnected && opener !== document.body ? opener : fallbackFocus?.();
    if (to && typeof to.focus === 'function') to.focus();
  }
  search.addEventListener('input', paintChecks);
  toggle.addEventListener('click', () => {
    const anyShown = split.columns.some((c) => hideable(c.key) && !draft.hidden.has(c.key));
    draft.hidden = new Set(anyShown ? split.columns.map((c) => c.key).filter(hideable) : []);
    paint();
  });
  reset.addEventListener('click', () => {
    draft = { hidden: new Set(), order: defOrder() };
    search.value = '';
    paint();
    announce('Reset to default.');
  });
  scrim.addEventListener('click', close);
  xbtn.addEventListener('click', close);
  cancel.addEventListener('click', close);
  apply.addEventListener('click', () => {
    err.textContent = '';
    const next = { hidden: [...draft.hidden], order: orderColumns(split, measures, draft.order) };
    if (onApply(next) === false) { err.textContent = 'Couldn’t save your columns (browser storage blocked or full).'; return; }
    close();
    onApplied?.();
  });
  // Escape closes; Tab / Shift+Tab stay inside the dialog. Listeners live on the modal, not document.
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...panel.querySelectorAll('button, input, [tabindex="0"]')].filter((n) => !n.disabled && n.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    // Focus on the panel itself (after a click on a non-control): Tab → first, Shift+Tab → last.
    if (!f.includes(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  if (usable) paint();
  document.body.appendChild(modal);
  (usable ? search : xbtn).focus();
  return modal;
}
