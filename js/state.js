/**
 * state.js — single source of truth for the playground.
 *
 * One `state` object holds everything needed to reproduce a test: the connection,
 * the active embed, and every applied option. It is:
 *   • persisted to localStorage (survives reload)
 *   • encoded into the URL hash (#s=…) so a link reproduces the exact setup
 *
 * SECURITY:
 *   • Secrets never enter this object. Bearer tokens and the trusted-auth secret_key live
 *     elsewhere (in-memory / server). Only non-sensitive config is serialized.
 *   • The #s= hash is ATTACKER-CONTROLLABLE (anyone can craft a share link). Everything
 *     decoded from it is run through `sanitize()` — unknown keys are dropped, types are
 *     coerced, lengths are capped, and `host` must be a valid http(s) URL. Prototype-
 *     polluting keys (__proto__/constructor/prototype) are never copied into maps.
 *   • `getHostSource()` reports whether the effective host came from the untrusted hash,
 *     so the controller can require explicit confirmation before connecting to it.
 */

const STORAGE_KEY = 'tsp_state_v1';

const SECTIONS = new Set(['search', 'spotter', 'liveboard', 'liveboard-custom', 'ai-highlights', 'viz', 'fullapp', 'ai-insights', 'spotter-chat']);
const AUTH_TYPES = new Set(['None', 'TrustedAuthTokenCookieless', 'TrustedAuthToken']);
const MAX_STR = 4000;
const MAX_ARR = 500;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Per-section allowlist of embed display-flag keys a shared link may carry.
 *
 * WHY: `flags[section]` is spread LAST into the embed constructor, so without a key allowlist a
 * crafted #s= link could smuggle ANY constructor option in — `flags.viz.answerId` would silently
 * override the explicit answerId, and options far outside the display schema become reachable.
 *
 * These keys MIRROR the `DISPLAY` table in js/app.js (search/spotter/liveboard/viz/fullapp, with
 * liveboard-custom and ai-highlights reusing liveboard's). state.js must not import app.js — the
 * controller is not a dependency of the state layer — so the list is copied here. When a flag is
 * added to DISPLAY, add it here too or shared links will silently drop it.
 */
const LIVEBOARD_FLAG_KEYS = [
  'fullHeight', 'hideLiveboardHeader', 'showLiveboardTitle', 'hideTabPanel', 'enableVizTransformations',
  'isLiveboardCompactHeaderEnabled', 'hideIrrelevantChipsInLiveboardTabs', 'coverAndFilterOptionInPDF',
  'isLiveboardXLSXCSVDownloadEnabled', 'isContinuousLiveboardPDFEnabled', 'isLiveboardMasterpiecesEnabled',
  'isEnhancedFilterInteractivityEnabled', 'isCentralizedLiveboardFilterUXEnabled',
];
const FLAG_KEYS = {
  search: new Set(['collapseDataSources', 'hideDataSources', 'enableSearchAssist',
    'focusSearchBarOnRender', 'hideResults', 'forceTable']),
  spotter: new Set(['disableSourceSelection', 'hideSourceSelection', 'hideSampleQuestions',
    'updatedSpotterChatPrompt', 'enablePastConversationsSidebar', 'enableStopAnswerGenerationEmbed',
    'showSpotterLimitations']),
  liveboard: new Set(LIVEBOARD_FLAG_KEYS),
  'liveboard-custom': new Set(LIVEBOARD_FLAG_KEYS),
  'ai-highlights': new Set(LIVEBOARD_FLAG_KEYS),
  viz: new Set(['fullHeight', 'hideLiveboardHeader', 'enableVizTransformations']),
  fullapp: new Set(['showPrimaryNavbar', 'hideHamburger', 'disableProfileAndHelp',
    'hideObjectSearch', 'pageId']),
};

/** The canonical default shape. Anything not here is not shareable. */
export function defaultState() {
  return {
    host: '',
    authType: 'None',                 // 'None' | 'TrustedAuthTokenCookieless'
    section: 'search',                // active embed
    // data objects
    worksheetId: '',
    liveboardId: '',
    vizId: '',
    answerId: '',
    // search
    searchTokenString: '',
    executeSearch: false,
    // applied options (Action enum *keys*, resolved to enum values at render time)
    hiddenActions: [],
    disabledActions: [],
    disabledActionReason: '',         // custom hover tooltip shown on greyed-out (disabled) actions
    customActions: [],                // [{ id, label, pos, type, webhook, urlTemplate }]
    runtimeParameters: [],            // [{ name, value }]
    activeFilters: [],                // [{ columnName, dataType, opKey, values }]
    activeFilterVia: 'runtime',       // 'runtime' = UpdateRuntimeFilters (invisible) | 'liveboard' = UpdateFilters (visible chip)
    cfbCols: [],                      // custom-liveboard filter bar: ordered column names
    cfbSelected: {},                  // custom-liveboard filter bar: { colName: [selectedValues] }
    cfbSort: {},                      // custom-liveboard filter bar: { colName: 'asc'|'desc'|'custom'|'metric' }
    cfbOrder: {},                     // custom-liveboard filter bar: { colName: [orderedValues] } (custom mode)
    cfbMetric: {},                    // custom-liveboard filter bar: { colName: { col, agg, dir } } (metric mode)
    flags: {},                        // { [section]: { embedOption: value } }
    // Custom export (REST /report/liveboard) — full control over the PDF/file the user gets,
    // bypassing the native Download modal whose sub-options the SDK can't individually hide.
    exportOpts: {
      format: 'PDF',                  // PDF | XLSX | CSV | PNG
      pageSize: 'A4',                 // A4 (paginated → page breaks; GA) | CONTINUOUS (beta, needs enablement)
      orientation: 'LANDSCAPE',       // LANDSCAPE | PORTRAIT
      truncateTable: false,           // false = show ALL columns/rows (fixes wide-table cutoff)
      includeCoverPage: true,
      includeFilterPage: true,
      includePageNumber: true,
      includeCustomLogo: true,
      footerText: '',
      hideNativeDownload: false,      // hide the in-embed Download action, export only via your button
      menuAction: true,               // add a "Preconfigured pdf download" custom action in the Liveboard "…" menu
      actionLabel: 'Preconfigured pdf download', // label of that menu action
      pickerAction: true,             // add a "Customize Export" action that opens a runtime options dialog
      pickerLabel: 'Customize Export', // label of that dialog-opening menu action
    },
    // "Date" PRIMARY custom-action button — a host-side date filter (Today / On a specific date)
    // applied via UpdateRuntimeFilters. Bypasses the native date dialog, whose default operator
    // (Between/Yesterday) the SDK can't preset. Off by default; toggled in Display options.
    dateBtn: {
      enabled: false,
      column: 'Order Date',           // target column
      applyVia: 'runtime',            // 'runtime' = UpdateRuntimeFilters (invisible) | 'liveboard' = UpdateFilters (visible chip)
    },
    // Personal liveboards — per-source-board editable copies, shown as a host-side tab strip
    // (Standard | your copies | ＋ Personalize). Each copy is a full, user-owned clone made via
    // POST metadata/copyobject and tagged for re-discovery. `copies` is keyed by the SOURCE board
    // id so the feature is repeatable for any liveboard; it's a fast-paint cache — the server
    // reconciliation in app.js refreshPersonalCopies() is the source of truth. Off by default.
    personalLb: {
      enabled: false,
      tag: 'Personal',                // scoping tag applied to every copy + used to re-discover them
      activeCopyId: '',               // '' = the Standard board (tab #1); else a copy's liveboardId
      copies: {},                     // { [sourceLiveboardId]: [{ id, title }] }
    },
    styles: { variables: {}, rules: {}, cssUrl: '', strings: {}, stringIDs: {}, exposeIds: false }, // cssUrl → customizations.style.customCSSUrl; strings/stringIDs/exposeIds → customizations.content (Beta)
    // trusted-auth claims (NON-secret) — the token-claims playground
    auth: {
      username: '',
      validitySeconds: 300,
      orgId: '',
      autoCreate: false,
      displayName: '',
      email: '',
      groups: [],                     // group_identifiers[] (full) / groups[{identifier}] (custom)
      tokenType: 'full',              // 'full' → auth/token/full · 'custom' → auth/token/custom (ABAC via RLS variables)
      // ── full only: user_parameters (deprecated 10.4.0.cl+) ──
      runtimeFilters: [],             // user_parameters.runtime_filters[]: { column, opKey, values, persist }
      runtimeSorts: [],               // user_parameters.runtime_sorts[]:   { column, order, persist }
      parameters: [],                 // user_parameters.parameters[]:      { name, values, persist }
      // ── custom only: ABAC via RLS formula variables ──
      persistOption: 'REPLACE',       // REQUIRED on custom. REPLACE|APPEND|NONE|RESET. NONE/RESET invalid w/ variable_values
      variableValues: [],             // variable_values[]: { name (formula variable), values[] } — modern ABAC (10.14.0.cl+)
      objects: [],                    // objects[] LOGICAL_TABLE identifiers to scope the variable_values to specific models
    },
  };
}

let state = defaultState();
const subscribers = new Set();
let _persistTimer = null;
let _hostSource = 'default'; // 'hash' | 'storage' | 'seed' | 'default'
let _holdHostPersist = false; // true while a hash-sourced host is unconfirmed — suppress from localStorage

/** Read-only snapshot. */
export function getState() { return state; }

/** Where the effective host came from. 'hash' = an untrusted shared link → confirm before connecting. */
export function getHostSource() { return _hostSource; }

/**
 * Shallow-merge a patch into state, persist (debounced), and notify subscribers.
 * Nested objects (auth, styles, flags) should be passed whole when changed.
 */
export function setState(patch, { silent = false } = {}) {
  state = { ...state, ...patch };
  if (!silent) notify();
  schedulePersist();
}

/** Convenience for nested auth updates. */
export function setAuth(patch) {
  setState({ auth: { ...state.auth, ...patch } });
}

export function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
/**
 * Suppress the host from being written to localStorage while a hash-sourced host is
 * unconfirmed. URL hash is always updated with the real state (it's already there);
 * only localStorage is sanitised, so the host doesn't auto-connect on the next fresh visit.
 * Call with false once the user explicitly clicks Connect.
 */
export function holdHostPersist(v) { _holdHostPersist = !!v; }
function notify() { subscribers.forEach(fn => { try { fn(state); } catch (e) { console.error(e); } }); }

// ── Persistence + sharing ───────────────────────────────────────────────────
function schedulePersist() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    // When a hash-sourced host is awaiting confirmation, omit the host from localStorage so it
    // can't auto-connect on the next fresh visit (the URL hash already carries the real value).
    const toStore = _holdHostPersist ? { ...state, host: '' } : state;
    try { localStorage.setItem(STORAGE_KEY, encode(toStore)); } catch (_) {}
    // Always reflect the full state (host included) into the URL — it's already in the hash.
    try { history.replaceState(null, '', `#s=${encode(state)}`); } catch (_) {}
  }, 250);
}

/** base64url(JSON) — compact and URL-safe. */
function encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ── Sanitization (untrusted input → safe partial state) ───────────────────────
const str = (v, max = MAX_STR) => (typeof v === 'string' ? v.slice(0, max) : '');
const bool = (v) => !!v;
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const arr = (v, max = MAX_ARR) => (Array.isArray(v) ? v.slice(0, max) : []);
const strArr = (v) => arr(v).map(x => str(x)).filter(x => x !== '');

// Control characters and whitespace inside a URL string: browsers and some parsers strip or
// re-interpret them, so `https://good.com\n@evil.com`-style strings must never survive sanitize.
const CTRL_OR_SPACE = /[\u0000- \u007f]/;

/** Is this an http(s) URL? The single source of truth for the `/^https?:\/\//` guards. */
export function isHttpUrl(v) {
  if (typeof v !== 'string' || CTRL_OR_SPACE.test(v.trim()) ) return false;
  let u; try { u = new URL(v.trim()); } catch { return false; }
  return u.protocol === 'https:' || u.protocol === 'http:';
}

/**
 * A http(s) URL with trailing slashes stripped, or '' if invalid (blocks javascript:/data:/etc).
 * KEEPS path/query/fragment — this is for URL-shaped fields (styles.cssUrl and friends), not for
 * the connection host. It refuses userinfo (`https://app.thoughtspot.com@evil.com` reads as the
 * host `evil.com`) and any embedded control/whitespace character.
 */
function validHost(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t || CTRL_OR_SPACE.test(t)) return '';
  let u; try { u = new URL(t); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password) return ''; // userinfo disguises the real host
  return t.replace(/\/+$/, '');
}

/**
 * The strict form used for `state.host` — the origin the app CONNECTS to (SDK init, credentialed
 * REST). Returns the parsed `u.origin`, never the caller's raw string, so nothing a link author
 * appended can ride along: userinfo, a path, a query, a fragment or embedded control characters
 * all reject outright rather than being silently trimmed.
 */
function validOrigin(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim().replace(/\/+$/, '');
  if (!t || CTRL_OR_SPACE.test(t)) return '';
  let u; try { u = new URL(t); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  if (u.username || u.password) return '';
  if (u.pathname !== '/' || u.search || u.hash) return '';
  return u.origin;
}

/** Copy a plain object's safe own keys through valFn, skipping prototype-polluting keys. */
function cleanMap(obj, valFn) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const val = valFn(obj[k], k);
    if (val !== undefined) out[str(k, 200)] = val;
  }
  return out;
}

function sanitizeAuth(a) {
  const d = defaultState().auth;
  if (!a || typeof a !== 'object') return d;
  return {
    username: str(a.username),
    validitySeconds: Math.min(3600, Math.max(30, num(a.validitySeconds, 300))),
    orgId: str(a.orgId, 64),
    autoCreate: bool(a.autoCreate),
    displayName: str(a.displayName),
    email: str(a.email),
    groups: strArr(a.groups),
    tokenType: a.tokenType === 'custom' ? 'custom' : 'full',
    runtimeFilters: arr(a.runtimeFilters).map(f => ({
      column: str(f?.column), opKey: str(f?.opKey, 32), values: strArr(f?.values), persist: bool(f?.persist),
    })),
    runtimeSorts: arr(a.runtimeSorts).map(s => ({
      column: str(s?.column), order: s?.order === 'DESC' ? 'DESC' : 'ASC', persist: bool(s?.persist),
    })),
    parameters: arr(a.parameters).map(p => ({
      name: str(p?.name), values: strArr(p?.values), persist: bool(p?.persist),
    })),
    persistOption: ['REPLACE', 'APPEND', 'NONE', 'RESET'].includes(a.persistOption) ? a.persistOption : 'REPLACE',
    variableValues: arr(a.variableValues).map(v => ({
      name: str(v?.name), values: strArr(v?.values),
    })),
    objects: strArr(a.objects),
  };
}

/**
 * Whitelist-sanitize a decoded payload into a partial state. Only keys present in the input are
 * returned (so callers can tell what the link actually carried). Everything is type-coerced.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);

  if (has('host')) out.host = validOrigin(raw.host); // stricter than validHost: origin only
  if (has('authType')) out.authType = AUTH_TYPES.has(raw.authType) ? raw.authType : 'None';
  if (has('section')) out.section = SECTIONS.has(raw.section) ? raw.section : 'search';
  if (has('worksheetId')) out.worksheetId = str(raw.worksheetId, 128);
  if (has('liveboardId')) out.liveboardId = str(raw.liveboardId, 128);
  if (has('vizId')) out.vizId = str(raw.vizId, 128);
  if (has('answerId')) out.answerId = str(raw.answerId, 128);
  if (has('searchTokenString')) out.searchTokenString = str(raw.searchTokenString);
  if (has('executeSearch')) out.executeSearch = bool(raw.executeSearch);

  if (has('hiddenActions')) out.hiddenActions = strArr(raw.hiddenActions);
  if (has('disabledActions')) out.disabledActions = strArr(raw.disabledActions);
  if (has('disabledActionReason')) out.disabledActionReason = str(raw.disabledActionReason, 512);

  if (has('customActions')) out.customActions = arr(raw.customActions).map(a => ({
    id: str(a?.id, 128), label: str(a?.label, 256),
    pos: str(a?.pos, 32), target: str(a?.target, 32), type: str(a?.type, 32),
    urlTemplate: str(a?.urlTemplate), webhook: str(a?.webhook),
    drillLiveboardId: str(a?.drillLiveboardId, 128),
  })).filter(a => a.id);

  if (has('runtimeParameters')) out.runtimeParameters = arr(raw.runtimeParameters)
    .map(p => ({ name: str(p?.name, 256), value: str(p?.value) }));

  if (has('activeFilters')) out.activeFilters = arr(raw.activeFilters)
    .map(f => ({ columnName: str(f?.columnName, 256), dataType: ['text', 'number', 'date'].includes(f?.dataType) ? f.dataType : 'text', opKey: str(f?.opKey, 32), values: strArr(f?.values) }));
  if (has('activeFilterVia')) out.activeFilterVia = raw.activeFilterVia === 'liveboard' ? 'liveboard' : 'runtime';

  if (has('cfbCols')) out.cfbCols = strArr(raw.cfbCols);
  if (has('cfbSelected')) out.cfbSelected = cleanMap(raw.cfbSelected, v => strArr(v));
  if (has('cfbSort')) out.cfbSort = cleanMap(raw.cfbSort, v => (['asc', 'desc', 'custom', 'metric'].includes(v) ? v : undefined));
  if (has('cfbOrder')) out.cfbOrder = cleanMap(raw.cfbOrder, v => strArr(v));
  if (has('cfbMetric')) out.cfbMetric = cleanMap(raw.cfbMetric, v => {
    if (!v || typeof v !== 'object') return undefined;
    const agg = ['sum', 'avg', 'max', 'min', 'count'].includes(v.agg) ? v.agg : 'sum';
    return { col: str(v.col, 256), agg, dir: v.dir === 'asc' ? 'asc' : 'desc' };
  });

  if (has('flags')) out.flags = cleanMap(raw.flags, (sectionFlags, section) => {
    const allowed = FLAG_KEYS[section];
    if (!allowed) return undefined; // unknown section → no flags at all
    return cleanMap(sectionFlags, (v, k) => (allowed.has(k)
      ? (typeof v === 'string' ? str(v, 512) : (typeof v === 'number' ? v : bool(v)))
      : undefined));
  });

  if (has('exportOpts') && raw.exportOpts && typeof raw.exportOpts === 'object') {
    const e = raw.exportOpts;
    const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
    const dflt = (v, def) => (v === undefined ? def : bool(v));
    out.exportOpts = {
      format: pick(e.format, ['PDF', 'XLSX', 'CSV', 'PNG'], 'PDF'),
      pageSize: pick(e.pageSize, ['CONTINUOUS', 'A4'], 'A4'),
      orientation: pick(e.orientation, ['LANDSCAPE', 'PORTRAIT'], 'LANDSCAPE'),
      truncateTable: bool(e.truncateTable),
      includeCoverPage: dflt(e.includeCoverPage, true),
      includeFilterPage: dflt(e.includeFilterPage, true),
      includePageNumber: dflt(e.includePageNumber, true),
      includeCustomLogo: dflt(e.includeCustomLogo, true),
      footerText: str(e.footerText, 256),
      hideNativeDownload: bool(e.hideNativeDownload),
      menuAction: dflt(e.menuAction, true),
      // Migrate the old default labels ('Export', 'Custom Export option') → the new default so
      // persisted setups pick up the rename; a label the user deliberately typed is kept as-is.
      actionLabel: ((l) => (l && l !== 'Export' && l !== 'Custom Export option' ? l : 'Preconfigured pdf download'))(str(e.actionLabel, 64)),
      pickerAction: dflt(e.pickerAction, true),
      pickerLabel: str(e.pickerLabel, 64) || 'Customize Export',
    };
  }

  if (has('dateBtn') && raw.dateBtn && typeof raw.dateBtn === 'object') {
    out.dateBtn = {
      enabled: bool(raw.dateBtn.enabled),
      column: str(raw.dateBtn.column, 256) || 'Order Date',
      applyVia: raw.dateBtn.applyVia === 'liveboard' ? 'liveboard' : 'runtime',
    };
  }

  if (has('personalLb') && raw.personalLb && typeof raw.personalLb === 'object') {
    const p = raw.personalLb;
    // `activeCopyId` and every copies[].id are GUIDs from the attacker-controllable #s= hash that get
    // fed into credentialed REST/embed calls — cap lengths, coerce types, and let cleanMap drop
    // prototype-polluting keys. Nothing is contacted until the user confirms the host (pendingHostConfirm).
    out.personalLb = {
      enabled: bool(p.enabled),
      tag: str(p.tag, 128) || 'Personal',
      activeCopyId: str(p.activeCopyId, 128),
      copies: cleanMap(p.copies, list => arr(list).map(c => ({
        id: str(c?.id, 128), title: str(c?.title, 256), label: str(c?.label, 120),
      })).filter(c => c.id)),
    };
  }

  if (has('styles')) out.styles = {
    variables: cleanMap(raw.styles?.variables, v => str(v, 512)),
    rules: cleanMap(raw.styles?.rules, decls => cleanMap(decls, v => str(v, 512))),
    cssUrl: validHost(raw.styles?.cssUrl), // http(s) only — blocks javascript:/data: from shared links
    strings: cleanMap(raw.styles?.strings, v => str(v, 512)),     // customizations.content.strings (literal UI-text swaps)
    stringIDs: cleanMap(raw.styles?.stringIDs, v => str(v, 512)), // customizations.content.stringIDs (ID-based swaps)
    exposeIds: !!raw.styles?.exposeIds,                           // customizations.content.exposeTranslationIDs (ID discovery)
  };

  if (has('auth')) out.auth = sanitizeAuth(raw.auth);
  return out;
}

/**
 * Load state on boot. Priority: URL hash → localStorage → optional seed (config.js).
 * Returns the resolved state. Records where the effective host came from (getHostSource()).
 */
export function loadState(seed = {}) {
  const seedClean = sanitize(seed);
  const base = { ...defaultState(), ...seedClean };

  let hashObj = null, storageObj = null;
  const hash = location.hash.match(/[#&]s=([^&]+)/);
  if (hash) { try { hashObj = sanitize(decode(hash[1])); } catch (_) {} }
  if (!hashObj) {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) storageObj = sanitize(decode(s)); } catch (_) {}
  }

  const chosen = hashObj || storageObj;
  state = chosen ? mergeKnown(base, chosen) : base;

  // Provenance: a non-empty host coming from the hash is untrusted (shared link).
  if (hashObj && hashObj.host) _hostSource = 'hash';
  else if (storageObj && storageObj.host) _hostSource = 'storage';
  else if (state.host && seedClean.host) _hostSource = 'seed';
  else _hostSource = 'default';

  return state;
}

/** Merge that preserves the shape of nested objects so old links don't drop new fields. */
function mergeKnown(base, loaded) {
  const out = { ...base, ...loaded };
  out.auth = { ...base.auth, ...(loaded.auth || {}) };
  out.styles = { variables: {}, rules: {}, cssUrl: '', strings: {}, stringIDs: {}, exposeIds: false, ...(loaded.styles || {}) };
  out.flags = { ...(loaded.flags || {}) };
  out.exportOpts = { ...base.exportOpts, ...(loaded.exportOpts || {}) };
  out.dateBtn = { ...base.dateBtn, ...(loaded.dateBtn || {}) };
  out.personalLb = { ...base.personalLb, ...(loaded.personalLb || {}) };
  return out;
}

/** Reset everything to defaults (optionally keeping the connection). */
export function resetState({ keepConnection = true } = {}) {
  const fresh = defaultState();
  if (keepConnection) {
    fresh.host = state.host;
    fresh.authType = state.authType;
    // Stay on the current embed/menu — Reset clears applied options, it is not
    // a navigation action, so it must not snap the view back to SearchEmbed.
    fresh.section = state.section;
    fresh.worksheetId = state.worksheetId;
    fresh.liveboardId = state.liveboardId;
    fresh.vizId = state.vizId;
    fresh.answerId = state.answerId;
    fresh.auth = { ...fresh.auth, ...state.auth };
  }
  state = fresh;
  notify();
  schedulePersist();
  return state;
}
