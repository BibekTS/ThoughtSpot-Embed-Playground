/**
 * auth.js — Trusted Auth token-claims playground.
 *
 * Lets a tester mint ThoughtSpot full-access tokens with the full (non-secret)
 * claim surface and watch the result live:
 *   • identity + JIT provisioning  (username, auto_create, display_name, email, org)
 *   • group_identifiers[]          (group-keyed RLS / ABAC)
 *   • user_parameters              (ABAC/RLS entitlements: runtime_filters, runtime_sorts, parameters)
 *
 * The secret_key never reaches the browser — the Node token server injects it.
 * `user_parameters` is deprecated in TS 10.4.0.cl+; group_identifiers is the durable path.
 */

import { getState, setAuth, setState } from './state.js';

const API_BASE = window.TS_API_BASE || '';
const OPERATORS = ['EQ', 'NE', 'LT', 'LE', 'GT', 'GE', 'IN', 'NOT_IN', 'BW', 'CONTAINS', 'BEGINS_WITH', 'ENDS_WITH', 'LIKE'];

let _log = () => {};
let _onApplied = () => {};
let _countdown = null;
let _lastToken = '';

export function seedAuthHooks({ logEvent, onTokenApplied }) {
  _log = logEvent || _log;
  _onApplied = onTokenApplied || _onApplied;
  window.__onAuthToken = renderInspector; // embed.js calls this on every getAuthToken (incl. autoLogin)
}

/** state.auth → cfg.trustedAuth (consumed by embed.js / initSDK). */
export function buildTrustedAuthConfig(auth) {
  return {
    tokenEndpoint: '/api/auth/token',
    autoLogin: true,
    requestBody: tokenRequestBody(auth),
  };
}

/**
 * state.auth → the POST /api/auth/token body. The ONLY place the body shape is defined: the SDK's
 * getAuthToken (embed.js, via cfg.trustedAuth.requestBody) and the inspector's Mint both send this,
 * so they cannot drift apart. Pass-through of the full (non-secret) claim surface — the server
 * injects the secret_key. Empty claims are `undefined`, so JSON.stringify drops them.
 */
export function tokenRequestBody(auth) {
  const custom = auth.tokenType === 'custom';
  const variableValues = custom ? (auth.variableValues || []).filter(v => v.name) : [];
  const objects = custom ? (auth.objects || []).filter(Boolean) : [];
  return {
    tokenType: auth.tokenType || 'full',
    username: auth.username || undefined,
    validitySeconds: auth.validitySeconds,
    orgId: auth.orgId || undefined,
    autoCreate: auth.autoCreate || undefined,
    displayName: auth.displayName || undefined,
    email: auth.email || undefined,
    groups: auth.groups?.length ? auth.groups : undefined,
    // full path (deprecated 10.4.0.cl+) vs custom path (ABAC via RLS variables) — send only the one that applies.
    userParameters: custom ? undefined : buildUserParameters(auth),
    persistOption: custom ? (auth.persistOption || 'REPLACE') : undefined,
    variableValues: variableValues.length ? variableValues : undefined,
    objects: objects.length ? objects : undefined,
  };
}

function buildUserParameters(auth) {
  const up = {};
  const f = (auth.runtimeFilters || []).filter(x => x.column);
  const so = (auth.runtimeSorts || []).filter(x => x.column);
  const p = (auth.parameters || []).filter(x => x.name);
  if (f.length) up.runtime_filters = f.map(x => ({ column_name: x.column, operator: x.opKey, values: x.values, persist: !!x.persist }));
  if (so.length) up.runtime_sorts = so.map(x => ({ column_name: x.column, order: x.order, persist: !!x.persist }));
  if (p.length) up.parameters = p.map(x => ({ name: x.name, values: x.values, persist: !!x.persist }));
  return Object.keys(up).length ? up : undefined;
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.hidden = false;
  modal.querySelectorAll('[data-close="auth"]').forEach(b => b.onclick = () => { modal.hidden = true; });
  renderBody();
  loadServerStatus();
}

const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

function renderBody() {
  const a = getState().auth;
  const body = document.getElementById('auth-body');
  body.innerHTML = '';

  // Server status
  const status = el('div', 'auth-status');
  status.id = 'auth-server-status';
  status.innerHTML = `<div class="as-row"><span>Token server</span><span id="as-state">checking…</span></div>
    <div class="as-row"><span>Secret</span><span id="as-secret">—</span></div>
    <div class="as-row"><span>Host</span><span id="as-host">—</span></div>
    <div class="as-row as-allow"><span>Allowlist</span><span id="as-allow">—</span></div>`;
  body.appendChild(status);

  // Setup guide — filled by loadServerStatus() once /api/auth/config answers.
  // Walks through the one-time secret-key setup when the server isn't ready to mint.
  const guide = el('div');
  guide.id = 'auth-setup-guide';
  body.appendChild(guide);

  // Repaint status + guide from the cached config so field-driven re-renders don't
  // reset the card to "checking…" (openAuthModal still re-probes for fresh data).
  if (_lastCfg !== undefined) applyServerStatus(_lastCfg);

  const custom = a.tokenType === 'custom';

  // Token type — picks the mint endpoint and which ABAC surface is available.
  body.appendChild(group('Token type', [
    selectField('Endpoint', a.tokenType || 'full', [
      { v: 'full', t: 'full — auth/token/full (plain trusted auth)' },
      { v: 'custom', t: 'custom — auth/token/custom (ABAC via RLS variables)' },
    ], v => { setAuth({ tokenType: v }); renderBody(); }),
    hint(custom
      ? 'custom is the ABAC endpoint — it accepts variable_values (modern RLS) + a required persist_option. A cluster runs ONE token workflow at a time (full OR custom), not both in parallel.'
      : 'full is the default. Switch to custom to test ABAC via RLS formula variables (variable_values).'),
  ]));

  // Identity
  body.appendChild(group('Identity & provisioning', [
    field('Username', a.username, v => setAuth({ username: v }), '(server default)'),
    twoCol(
      field('Validity (sec)', a.validitySeconds, v => setAuth({ validitySeconds: Number(v) || 300 }), '300', 'number'),
      field(custom ? 'Org identifier' : 'Org ID', a.orgId, v => setAuth({ orgId: v }), '(default)'),
    ),
    hint(custom
      ? 'Org identifier: on a custom token you can use the org’s name or its id. Leave blank for the default org.'
      : 'Org ID: on a full token this must be the org’s NUMBER (numeric id), not its name — a name is silently ignored. Leave blank for the default org.'),
    toggle('Auto-create user (JIT)', a.autoCreate, v => setAuth({ autoCreate: v })),
    guardSlot('auth-jit-note'), // filled by paintGuardNotes() from /api/auth/config
    twoCol(
      field('Display name', a.displayName, v => setAuth({ displayName: v }), 'For JIT'),
      field('Email', a.email, v => setAuth({ email: v }), 'For JIT'),
    ),
  ]));

  // Groups
  body.appendChild(group(custom ? 'Groups (groups[].identifier)' : 'Groups (group_identifiers)', [
    chipsEditor(a.groups, list => setAuth({ groups: list }), 'Type a group name, press Enter'),
    guardSlot('auth-groups-note'), // filled by paintGuardNotes() from /api/auth/config
    hint('Adding a group makes this token act as if the user belongs to that group — so you can test group-based security (RLS) rules.'),
  ]));

  if (custom) {
    // Modern ABAC: variable_values on auth/token/custom (10.14.0.cl+).
    body.appendChild(group('ABAC via RLS variables (variable_values)', [
      hint('Each name is a formula variable referenced in an RLS rule via ts_var(name). Values become a WHERE clause at query time (= → IN for multi-value). The forward-track replacement for user_parameters.'),
      selectField('persist_option', a.persistOption || 'REPLACE', [
        { v: 'REPLACE', t: 'REPLACE — overwrite persisted set (right for a stateless mint)' },
        { v: 'APPEND', t: 'APPEND — add to persisted (API default; accumulates/leaks)' },
        { v: 'NONE', t: 'NONE — do not persist (not allowed with variable_values)' },
        { v: 'RESET', t: 'RESET — clear persisted (not allowed with variable_values)' },
      ], v => { setAuth({ persistOption: v }); renderBody(); }),
      hint(a.persistOption === 'NONE' || a.persistOption === 'RESET'
        ? '⚠ NONE/RESET are rejected by ThoughtSpot when variable_values are present — the server will 400. Use REPLACE or APPEND, or clear the variables below.'
        : 'REPLACE makes each mint authoritative. APPEND is the API default and silently accumulates entitlements across mints — the slow-leak this pattern prevents.'),
      subhead('Variables'),
      variableEditor('variableValues'),
      subhead('Scope to models (optional)'),
      chipsEditor(a.objects, list => setAuth({ objects: list }), 'LOGICAL_TABLE GUID or name, Enter'),
      hint('Limits the variable_values to specific models (objects[].identifier, type LOGICAL_TABLE). Leave empty to apply everywhere.'),
    ]));
  } else {
    // Legacy ABAC entitlements baked into the session (full endpoint).
    body.appendChild(group('ABAC / RLS entitlements (user_parameters)', [
      hint('⚠ Deprecated in TS 10.4.0.cl+ — switch the token type to "custom" and use variable_values. Still works on full for now.'),
      subhead('Runtime filters'),
      filterEditor('runtimeFilters'),
      subhead('Runtime sorts'),
      sortEditor('runtimeSorts'),
      subhead('Parameters'),
      paramEditor('parameters'),
    ]));
  }

  // Actions
  const actions = el('div', 'auth-actions');
  const mint = el('button', 'tb-btn', 'Mint token (inspect)');
  mint.onclick = () => mintToken(false);
  const apply = el('button', 'tb-btn tb-btn-primary', 'Mint & apply to embed');
  apply.onclick = () => mintToken(true);
  actions.append(mint, apply);
  body.appendChild(actions);

  // Inspector
  const insp = el('div', 'tok-inspect');
  insp.innerHTML = `
    <div class="tok-block"><div class="tok-lbl">Request to token server <span class="tok-redact">secret redacted</span></div><pre id="tok-req">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">Raw token <span id="tok-exp" class="tok-exp"></span> <button id="tok-copy" class="bp-mini">Copy</button></div><pre id="tok-raw">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">Decoded JWT claims</div><pre id="tok-dec">—</pre></div>
    <div class="tok-block"><div class="tok-lbl">getAuthToken invocations</div><div id="tok-log" class="tok-log"><div class="tok-empty">No requests yet.</div></div></div>`;
  body.appendChild(insp);
  document.getElementById('tok-copy').onclick = () => { if (_lastToken) navigator.clipboard.writeText(_lastToken); };
  syncCopyBtn();
}

// Copy is only meaningful while a current token is on screen — disable it otherwise so the button
// can't imply there is something to copy.
function syncCopyBtn() {
  const b = document.getElementById('tok-copy');
  if (b) b.disabled = !_lastToken;
}

// ── Field builders ───────────────────────────────────────────────────────────
function group(title, children) {
  const g = el('div', 'auth-group');
  g.appendChild(el('div', 'auth-group-t', title));
  children.forEach(c => g.appendChild(c));
  return g;
}
function subhead(t) { return el('div', 'auth-sub', t); }
function hint(t) { return el('div', 'fld-hint', t); }
// A slot whose contents depend on the live server config (group/JIT guards). Starts hidden;
// paintGuardNotes() fills it once /api/auth/config answers, so a blocked field explains itself
// in plain language instead of failing with a silent 403 in the Event Log.
function guardSlot(id) { const d = el('div', 'guard-note'); d.id = id; d.hidden = true; return d; }
function twoCol(a, b) { const r = el('div', 'two-col'); r.append(a, b); return r; }
function field(label, value, onChange, ph, type = 'text') {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  const i = el('input', 'inp'); i.type = type; i.value = value ?? ''; i.placeholder = ph || '';
  i.addEventListener('change', () => onChange(i.value.trim()));
  f.appendChild(i); return f;
}
function toggle(label, value, onChange) {
  const f = el('label', 'tgl'); f.innerHTML = `<span>${label}</span>`;
  const i = el('input'); i.type = 'checkbox'; i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  f.append(i, el('span', 'tgl-slider')); return f;
}
function selectField(label, value, opts, onChange) {
  const f = el('div', 'fld');
  f.appendChild(el('label', 'fld-lbl', label));
  const sel = el('select', 'inp');
  opts.forEach(o => { const op = el('option'); op.value = o.v; op.textContent = o.t; if (o.v === value) op.selected = true; sel.appendChild(op); });
  sel.addEventListener('change', () => onChange(sel.value));
  f.appendChild(sel); return f;
}
// One editable row per entry of state.auth[key], plus a "+ Add" button. `build(row)` returns the
// row's input cells and a `read()` that turns them back into the row object to store; `blank()` is
// a fresh empty row. Every value lands in an input's .value — never markup.
function rowsEditor(key, addLabel, blank, build) {
  const a = getState().auth; const rows = el('div', 'rows');
  (a[key] || []).forEach((row, i) => {
    const r = el('div', 'frow');
    const { cells, read } = build(row);
    const x = el('button', 'frow-x', '✕');
    cells.forEach(c => { c.onchange = () => updateAuthRow(key, i, read()); });
    x.onclick = () => removeAuthRow(key, i);
    r.append(...cells, x); rows.appendChild(r);
  });
  const add = el('button', 'sec-add', addLabel);
  add.onclick = () => addAuthRow(key, blank());
  const w = el('div'); w.append(rows, add); return w;
}
const csv = (s) => s.split(',').map(v => v.trim()).filter(Boolean);
// Options are our own constants; the (link-derived) current value is only compared, never injected.
function mkSel(opts, cur) { const s = el('select', 'inp inp-sm'); s.innerHTML = opts.map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join(''); return s; }
function variableEditor(key) {
  return rowsEditor(key, '+ Add variable', () => ({ name: '', values: [] }), v => {
    const name = mkInp('formula variable name', v.name);
    const val = mkInp('values, comma-sep', (v.values || []).join(', '));
    return { cells: [name, val], read: () => ({ name: name.value.trim(), values: csv(val.value) }) };
  });
}
function chipsEditor(list, onChange, ph) {
  const wrap = el('div', 'chips-editor');
  const chips = el('div', 'chips');
  (list || []).forEach((g, i) => {
    const c = el('span', 'chip');
    c.textContent = g; // g is hash-controlled (state.auth.groups/objects) — must not be HTML
    const x = el('button', 'chip-x', '✕');
    x.onclick = () => { const l = [...list]; l.splice(i, 1); onChange(l); renderBody(); };
    c.appendChild(x); chips.appendChild(c);
  });
  const inp = el('input', 'inp'); inp.placeholder = ph;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && inp.value.trim()) { onChange([...(list || []), inp.value.trim()]); renderBody(); } });
  wrap.append(chips, inp); return wrap;
}
function filterEditor(key) {
  return rowsEditor(key, '+ Add filter', () => ({ column: '', opKey: 'EQ', values: [], persist: false }), f => {
    const col = mkInp('column', f.column);
    const op = mkSel(OPERATORS, f.opKey);
    const val = mkInp('values, comma-sep', (f.values || []).join(', '));
    return { cells: [col, op, val], read: () => ({ column: col.value.trim(), opKey: op.value, values: csv(val.value), persist: f.persist }) };
  });
}
function sortEditor(key) {
  return rowsEditor(key, '+ Add sort', () => ({ column: '', order: 'ASC', persist: false }), f => {
    const col = mkInp('column', f.column);
    const ord = mkSel(['ASC', 'DESC'], f.order);
    return { cells: [col, ord], read: () => ({ column: col.value.trim(), order: ord.value, persist: f.persist }) };
  });
}
function paramEditor(key) {
  return rowsEditor(key, '+ Add parameter', () => ({ name: '', values: [], persist: false }), p => {
    const name = mkInp('name', p.name);
    const val = mkInp('values, comma-sep', (p.values || []).join(', '));
    return { cells: [name, val], read: () => ({ name: name.value.trim(), values: csv(val.value), persist: p.persist }) };
  });
}
function mkInp(ph, val) { const i = el('input', 'inp inp-sm'); i.placeholder = ph; i.value = val || ''; return i; }
function addAuthRow(key, row) { const a = getState().auth; setAuth({ [key]: [...(a[key] || []), row] }); renderBody(); }
function updateAuthRow(key, i, row) { const a = getState().auth; const l = [...(a[key] || [])]; l[i] = row; setAuth({ [key]: l }); }
function removeAuthRow(key, i) { const a = getState().auth; const l = [...(a[key] || [])]; l.splice(i, 1); setAuth({ [key]: l }); renderBody(); }

// ── Setup guide ────────────────────────────────────────────────────────────
// Rendered under the status card. cfg = the /api/auth/config payload, or null
// when the token server is unreachable. Dynamic values (hosts, usernames) go in
// via textContent — never innerHTML.
function renderSetupGuide(cfg) {
  const slot = document.getElementById('auth-setup-guide');
  if (!slot) return;
  slot.innerHTML = '';

  const topbarHost = (getState().host || '').trim();

  if (cfg && cfg.secretConfigured) {
    // Ready — say so, then flag the two mistakes that still bite.
    const ok = el('div', 'setup-ready');
    ok.appendChild(el('div', 'setup-ready-t', '✓ Ready to connect'));
    const d = el('div', 'setup-ready-d');
    d.textContent = 'The server has the secret key (read from TS_SECRET_KEY in .env, server-side only — never sent to the browser) and can mint tokens. Close this panel and click Connect — a token is minted automatically for the embed. Everything below is optional claims (groups, JIT, ABAC).';
    ok.appendChild(d);
    slot.appendChild(ok);

    const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
    if (topbarHost && cfg.thoughtSpotHost && norm(topbarHost) !== norm(cfg.thoughtSpotHost)) {
      const w = el('div', 'setup-warn');
      w.textContent = `⚠ Host mismatch — the top bar points at ${topbarHost}, but the token server mints against ${cfg.thoughtSpotHost} (THOUGHTSPOT_HOST in .env). A token for one cluster is rejected by the other; make them match.`;
      slot.appendChild(w);
    }
    if (!cfg.defaultUsername && !(getState().auth.username || '').trim()) {
      const w = el('div', 'setup-warn');
      w.textContent = '⚠ No username to mint for — set TS_DEFAULT_USERNAME in .env (and restart), or type a Username in the Identity section below.';
      slot.appendChild(w);
    }
    return;
  }

  // Not ready — one-time setup walkthrough.
  const g = el('div', 'setup-guide');
  g.appendChild(el('div', 'setup-guide-t', cfg
    ? 'One-time setup — the server has no secret key yet'
    : 'One-time setup — the token server is not running'));

  const steps = el('ol', 'setup-steps');
  const step = (title, ...parts) => {
    const li = el('li', 'setup-step');
    li.appendChild(el('div', 'setup-step-t', title));
    parts.forEach(p => {
      if (typeof p === 'string') { const d = el('div', 'setup-step-d'); d.textContent = p; li.appendChild(d); }
      else li.appendChild(p);
    });
    steps.appendChild(li);
  };

  if (!cfg) {
    step('Start the local token server',
      'In the project folder run `npm start`, then use the app at http://localhost:3000. A plain static host (e.g. Live Server on :5500) has no /api/auth/token endpoint and cannot mint tokens.',
      'Then hit Recheck below — if the Secret row already shows “configured ✓” you can skip the remaining steps.');
  }

  step('Copy the secret key from ThoughtSpot',
    'In ThoughtSpot open Develop → Customizations → Security settings, enable “Trusted authentication”, and copy the secret_key it reveals. This needs admin/developer privileges — ask an admin if the toggle is greyed out.');

  // .env snippet — prefill the host from the top bar so it's paste-ready.
  const envText = [
    `THOUGHTSPOT_HOST=${topbarHost || 'https://your-instance.thoughtspot.cloud'}`,
    'TS_SECRET_KEY=paste-the-secret-key-here',
    'TS_DEFAULT_USERNAME=user.to.mint.tokens.for',
  ].join('\n');
  const envBlock = el('div', 'env-block');
  const pre = el('pre');
  pre.textContent = envText;
  const copy = el('button', 'bp-mini', 'Copy');
  copy.onclick = () => {
    navigator.clipboard.writeText(envText)
      .then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1600); })
      .catch(() => { copy.textContent = 'Select & copy manually'; });
  };
  envBlock.append(pre, copy);
  const secNote = el('div', 'setup-secnote');
  secNote.textContent = '🔒 Keep the secret in .env — never hardcode it in client-side JS or commit it to git. .env is gitignored here, and the server reads TS_SECRET_KEY from it and injects it into the token request; the browser only ever receives short-lived tokens, never the key itself.';
  step('Store the secret in a .env file at the project root', envBlock, secNote,
    'Optional: TS_USERNAME_ALLOWLIST=alice,bob to let the UI mint for more users (fail-closed to the default user when empty).');

  step('Restart the server, then recheck',
    'Stop the server (Ctrl-C) and run `npm start` again so it picks up the .env changes. When the Secret row above shows “configured ✓”, close this panel and click Connect in the top bar.');

  g.appendChild(steps);

  const recheck = el('button', 'tb-btn setup-recheck', 'Recheck');
  recheck.onclick = () => {
    const st = document.getElementById('as-state');
    if (st) { st.textContent = 'checking…'; st.className = ''; }
    loadServerStatus();
  };
  g.appendChild(recheck);
  slot.appendChild(g);
}

// ── Server status + mint ───────────────────────────────────────────────────
let _lastCfg; // last /api/auth/config result: object = online, null = offline, undefined = never probed

async function loadServerStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`);
    try { window.__onApiCall?.({ scope: 'playground', method: 'GET', path: '/api/auth/config', status: res.status }); } catch (_) {}
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _lastCfg = await res.json();
  } catch (e) {
    _lastCfg = null;
  }
  applyServerStatus(_lastCfg);
}

// Paint the status card + setup guide from a (possibly cached) config. Kept separate from the
// fetch so renderBody() can repaint from cache instead of leaving "checking…" after a re-render.
function applyServerStatus(cfg) {
  const setTxt = (id, txt, cls) => { const e = document.getElementById(id); if (e) { e.textContent = txt; if (cls) e.className = cls; } };
  if (!cfg) {
    setTxt('as-state', `offline — run: npm start`, 'as-bad');
    setTxt('as-secret', '—');
    renderSetupGuide(null);
    paintGuardNotes(null);
    return;
  }
  setTxt('as-state', 'online ✓', 'as-ok');
  setTxt('as-secret', cfg.secretConfigured ? 'configured ✓' : 'NOT configured ✗', cfg.secretConfigured ? 'as-ok' : 'as-bad');
  setTxt('as-host', cfg.thoughtSpotHost || '(not set)');
  const allow = document.getElementById('as-allow');
  if (allow) {
    allow.innerHTML = '';
    (cfg.allowlist || []).forEach(u => { const c = el('button', 'auth-chip'); c.textContent = u; c.onclick = () => { setAuth({ username: u }); renderBody(); }; allow.appendChild(c); });
    if (!(cfg.allowlist || []).length) allow.textContent = '(none)';
  }
  renderSetupGuide(cfg);
  paintGuardNotes(cfg);
}

// Plain-language, self-updating notices under the Groups field and Auto-create toggle.
// They read the server's fail-closed guards (cfg.groupGuard, cfg.allowJit) so a tester sees
// WHY a claim is blocked and the exact one-line fix — instead of a silent 403 in the Event Log.
// Content is static (no user/upstream data), so innerHTML with <code> is safe here.
function paintGuardNotes(cfg) {
  const set = (id, blocked, html) => {
    const e = document.getElementById(id);
    if (!e) return;
    if (!cfg) { e.hidden = true; return; }          // offline — the setup guide already covers it
    e.hidden = false;
    e.className = `guard-note ${blocked ? 'guard-blocked' : 'guard-ok'}`;
    e.innerHTML = html;
  };

  // Groups guard: 'none' = all blocked, 'any' = wildcard, or an array of allowed names.
  const gg = cfg && cfg.groupGuard;
  if (gg === 'none') {
    set('auth-groups-note', true,
      '🔒 The server is blocking <b>all</b> groups right now, so adding one here will fail (look for a red ✗ in the Event Log at the bottom). ' +
      '<b>To allow groups:</b> add <code>TS_GROUP_ALLOWLIST=*</code> to your <code>.env</code> file, then restart the server (stop it and run <code>npm start</code>). ' +
      'Even after that, a group only changes the numbers you see if ThoughtSpot has a row-level-security (RLS) rule built for that group.');
  } else if (gg) {
    const which = gg === 'any' ? 'any group' : `only these groups: <b>${[].concat(gg).join(', ')}</b> (others are rejected)`;
    set('auth-groups-note', false,
      `✓ The server allows ${which}. Remember: a group only changes the numbers you see if ThoughtSpot has a row-level-security (RLS) rule built for it.`);
  } else {
    set('auth-groups-note', true, '');
  }

  // JIT (auto_create) guard.
  if (cfg && cfg.allowJit) {
    set('auth-jit-note', false,
      '✓ Auto-create is enabled on the server. A brand-new user (plus the Display name / Email below) is provisioned on first sign-in.');
  } else {
    set('auth-jit-note', true,
      '🔒 Auto-create is turned <b>off</b> on the server, so switching it on here will fail. ' +
      '<b>To allow it:</b> add <code>TS_ALLOW_JIT=true</code> to your <code>.env</code> file, then restart the server.');
  }
}

async function mintToken(apply) {
  const a = getState().auth;
  const body = tokenRequestBody(a); // the same body the SDK's getAuthToken sends
  _log('Auth', `Minting token (user: ${body.username || '(default)'}, groups: [${(a.groups || []).join(', ')}])`);
  try {
    const res = await fetch(`${API_BASE}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try { window.__onApiCall?.({ scope: 'playground', method: 'POST', path: '/api/auth/token', status: res.status }); } catch (_) {}
    // An HTML 5xx (a proxy error page, a crashed process behind a reverse proxy) makes res.json()
    // throw, which used to land in the catch below and report "is the Node server running?" — the
    // server plainly IS running, it just didn't answer JSON. Say what actually happened instead.
    let data;
    try {
      data = await res.json();
    } catch (_) {
      const msg = `HTTP ${res.status} — non-JSON response from the token server (${res.headers.get('content-type') || 'unknown content-type'}); check the server log or a proxy in front of it.`;
      renderInspector({ requestBody: body, error: msg });
      _log('Auth', `✗ ${msg}`);
      return;
    }
    if (!res.ok) {
      const detail = upstreamDetail(data);
      const msg = detail ? `${data.error || 'HTTP ' + res.status} — ${detail}` : (data.error || `HTTP ${res.status}`);
      renderInspector({ requestBody: body, error: msg, response: data });
      _log('Auth', `✗ ${msg}`);
      return;
    }
    renderInspector({ requestBody: data.echo?.requestBody || body, response: data });
    _log('Auth', data.warning
      ? `⚠ token minted for ${data.valid_for_username || body.username || '(default)'} — ${data.warning}`
      : `✓ token minted for ${data.valid_for_username || body.username || '(default)'}`);
    if (apply) {
      setState({ authType: 'TrustedAuthTokenCookieless' });
      document.getElementById('auth-select').value = 'TrustedAuthTokenCookieless';
      _onApplied(data.token);
      document.getElementById('auth-modal').hidden = true;
    }
  } catch (err) {
    renderInspector({ requestBody: body, error: err.message });
    _log('Auth', `✗ ${err.message} — is the Node server running?`);
  }
}

// Dig the human-readable message out of ThoughtSpot's nested upstream error envelope, e.g.
// { upstream: { error: { message: { debug: { debug: '["The JWT Beta endpoint is disabled…"]' } } } } }.
function upstreamDetail(data) {
  try {
    const d = data?.upstream?.error?.message?.debug ?? data?.upstream?.error?.message ?? data?.upstream;
    if (!d) return '';
    let msg = (typeof d === 'string') ? d : (d.debug ?? d.message ?? '');
    if (typeof msg === 'string' && msg.trim().startsWith('[')) {
      try { const arr = JSON.parse(msg); if (Array.isArray(arr)) msg = arr.join(' '); } catch (_) {}
    }
    return typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch (_) { return ''; }
}

// ── Inspector rendering (also called on every getAuthToken via window.__onAuthToken) ──
function renderInspector(info = {}) {
  const req = document.getElementById('tok-req');
  if (req && info.requestBody) req.textContent = JSON.stringify(info.requestBody, null, 2);
  appendLog(info);
  const raw = document.getElementById('tok-raw');
  const dec = document.getElementById('tok-dec');
  if (info.error) {
    // Clear the copy buffer too. Leaving the PREVIOUS mint's token here meant Copy silently handed
    // back a stale credential while the panel showed an error — the worst kind of wrong.
    _lastToken = '';
    syncCopyBtn();
    if (raw) raw.textContent = `Error: ${info.error}`;
    if (dec) dec.textContent = '—';
    stopCountdown();
    return;
  }
  const token = info.response?.token || '';
  _lastToken = token;
  syncCopyBtn();
  if (raw) raw.textContent = token || '—';
  if (dec) {
    try {
      const parts = token.split('.');
      dec.textContent = parts.length >= 2
        ? JSON.stringify({ header: decodeSeg(parts[0]), payload: decodeSeg(parts[1]) }, null, 2)
        : 'Opaque token (not a decodable JWT).';
    } catch { dec.textContent = 'Opaque token (not a decodable JWT).'; }
  }
  let exp = info.response?.expiration_time_in_millis;
  if (!exp) { try { exp = decodeSeg(token.split('.')[1]).exp * 1000; } catch { exp = 0; } }
  startCountdown(exp);
}
function decodeSeg(seg) {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}
function appendLog(info) {
  const log = document.getElementById('tok-log');
  if (!log) return;
  const empty = log.querySelector('.tok-empty'); if (empty) empty.remove();
  const t = new Date().toTimeString().slice(0, 8);
  const line = el('div', 'tok-line');
  const timeEl = el('span', 'tl-t'); timeEl.textContent = t;
  line.append(timeEl, document.createTextNode(' '));
  if (info.error) {
    // info.error may contain upstream TS error text (attacker-controllable) — use textContent.
    const errEl = el('span', 'tl-bad'); errEl.textContent = `✗ ${info.error}`;
    line.appendChild(errEl);
  } else {
    const user = info.response?.valid_for_username || info.requestBody?.username || '(default)';
    const okEl = el('span', 'tl-ok'); okEl.textContent = '✓ minted';
    line.append(okEl, document.createTextNode(` for ${user}`));
    if (info.response?.warning) {
      // upstream/warning text is not trusted markup — textContent only.
      const warnEl = el('div', 'tl-warn'); warnEl.textContent = `⚠ ${info.response.warning}`;
      line.appendChild(warnEl);
    }
  }
  log.insertBefore(line, log.firstChild);
}
function startCountdown(exp) {
  stopCountdown();
  const e = document.getElementById('tok-exp');
  if (!e || !exp) { if (e) e.textContent = ''; return; }
  const tick = () => {
    const r = Math.max(0, exp - Date.now()); const s = Math.floor(r / 1000);
    e.textContent = `expires in ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    e.classList.toggle('warn', r < 30000);
    if (r <= 0) { e.textContent = 'expired'; stopCountdown(); }
  };
  tick(); _countdown = setInterval(tick, 1000);
}
function stopCountdown() { if (_countdown) { clearInterval(_countdown); _countdown = null; } }
