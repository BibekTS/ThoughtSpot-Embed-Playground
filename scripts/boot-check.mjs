/**
 * scripts/boot-check.mjs — boots the real server and loads the app in headless Chrome.
 *
 * The third gate of the verification bar (see CLAUDE.md): smoke-test proves the server's
 * security contract; this proves the FRONTEND actually boots — all ES modules import, the
 * tool shell mounts, and the console stays clean. A syntax error anywhere in js/*.js fails
 * here even though the smoke test (which only asserts the file is served) stays green.
 *
 * Run with `npm run boot-check`. Pass criteria:
 *   ✓ page loads (HTTP 200) and the tool shell mounts (#embed-list / .rail-group / #inspector)
 *   ✓ zero JS console/page errors
 *   ✓ NO 4xx/5xx responses at all — there is no exemption. index.html ships
 *     <link rel="icon" href="data:,">, so the implicit /favicon.ico request is never made.
 *   ✓ XSS probe (BACKLOG S1): an <img onerror> payload in a #s=-hash group name renders as
 *     inert text in the auth chips and the Event Log — it must never execute
 *   ✓ URL-action scheme probe (BACKLOG S13): a `javascript:` urlTemplate from a #s= hash must be
 *     refused at window.open, while a plain https template still opens with placeholders resolved
 *   ✓ Drill-through probe (BACKLOG S22): the column-scoped action reaches the generated code as
 *     '<modelGuid>::<column>', a clicked point scopes the searchdata query, Load more advances
 *     record_offset, the KPI/row-count badge reconciles, and a javascript: link template is refused
 *   ✓ Drill-through snippet probe (BACKLOG S46): the generated snippet's date helpers carry the
 *     LIVE CFB_DATE_NAME_RE (read from js/app.js) and the whole snippet parses as an ES module
 *   ✓ Custom-styles paste probe (BACKLOG S37): a pasted rules object is PARSED, never evaluated —
 *     an embedded expression must not run, while a plain rules object still adds its rule
 *   ✓ Connect-race probe (BACKLOG S33): a slow connect to host A that resolves after a connect to
 *     host B must not overwrite B's status pill, overlay or discovered objects
 *   ✓ Pre-confirm auth probe (BACKLOG S10): a #s= hash naming a trusted-auth mode must mint NO
 *     token and contact the named host ZERO times before the user clicks Confirm
 *
 * Chrome resolution: $CHROME_PATH, then the standard macOS / Linux install locations
 * (GitHub's ubuntu runners ship google-chrome). Requires devDependency puppeteer-core.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 34921; // distinct from smoke-test's 34917 and dev's 3000/5500
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.error('boot-check: no Chrome binary found — set CHROME_PATH.');
  process.exit(1);
}

// Whole-run watchdog: a hung CDN fetch or navigation must not stall CI indefinitely.
const WATCHDOG_MS = 180_000; // raised from 120s when the S33/S37 probes landed (S33 alone holds 6s)
const watchdog = setTimeout(() => {
  console.error(`boot-check: watchdog timeout (${WATCHDOG_MS / 1000}s) — treating as failure.`);
  process.exit(1);
}, WATCHDOG_MS);

// Clean env like smoke-test: the frontend boot must not depend on the developer's .env.
const env = { ...process.env, PORT: String(PORT), THOUGHTSPOT_HOST: '', TS_SECRET_KEY: '' };
const server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/auth/config`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

// XSS regression probe (BACKLOG S1): an <img onerror> payload smuggled into state.auth.groups
// via the #s= share hash must render as INERT TEXT in both sinks it can reach — the auth
// modal's group chips (chipsEditor) and the Event Log (mintToken interpolates the group list
// into logEvent's message). A regression to innerHTML in either sink executes the payload and
// sets window.__xss. Runs on its own page so the vuln-case GET /x 404 can't pollute the shell
// contract; the assertion is the window flag, NOT error capture — a successful inline onerror
// throws nothing and its resource-load console line is filtered anyway. Clicks are retried
// under waitForFunction (not fixed sleeps): the handlers bind only after the whole module
// graph executes, and a too-early click is a silent no-op that would flake the gate.
async function runXssProbe(browser) {
  const XSS = '<img src=x onerror="window.__xss=1">';
  const hash = Buffer.from(
    JSON.stringify({ authType: 'TrustedAuthTokenCookieless', auth: { groups: [XSS] } }), 'utf8'
  ).toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = []; // diagnostics only — tells "app crashed" apart from "sink regressed"
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    // 30s cap (not the main goto's 60s): assets are already in the browser cache from the
    // primary page, and two full 60s budgets would eat the 120s whole-run watchdog.
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    const retryUntil = (fn) =>
      probe.waitForFunction(fn, { polling: 500, timeout: 20_000 }).then(() => true, () => false);
    // Positive controls: the payload must actually REACH each sink as text, otherwise a UI
    // change (renamed button, modal not opening) would turn this probe into a silent no-op.
    const inChip = await retryUntil(() => {
      const hit = [...document.querySelectorAll('.chip')].some((c) => c.textContent.includes('<img src=x'));
      if (!hit) document.getElementById('auth-config-btn')?.click();
      return hit;
    });
    const inLog = await retryUntil(() => {
      const hit = (document.getElementById('log-list')?.textContent || '').includes('<img src=x');
      if (!hit) document.querySelector('.auth-actions button')?.click(); // "Mint token (inspect)"
      return hit;
    });
    await sleep(600); // a would-be onerror task needs a beat to fire before we read the flag
    const executed = await probe.evaluate(() => window.__xss === 1);
    return { executed, inChip, inLog, probeErrors };
  } finally {
    await probe.close();
  }
}

// Confirm-host / persistence probe (BACKLOG S2): a host arriving via the attacker-controllable
// #s= share hash must (1) require an explicit Connect click — shown as the "confirm-host" overlay,
// never auto-connected — and (2) be kept OUT of localStorage while unconfirmed, so a later PLAIN
// visit (no hash) can't silently auto-connect to it. The guard lives at state.js `holdHostPersist`
// (schedulePersist blanks the held host from localStorage) + app.js `pendingHostConfirm`.
//
// Two legs, both on the SAME browser (localStorage is shared per-origin across pages):
//   Leg 1 — seed localStorage with a PRESEED entry (the user's own pre-link state), then open
//           `#s={host:EVIL, worksheetId:MARKER}`. Assert the confirm overlay names EVIL (positive
//           control: the hash reached the app), a persist cycle actually RAN (the URL hash got
//           re-encoded by schedulePersist — the positive control that makes the storage assertion
//           meaningful), localStorage still holds exactly PRESEED with NO host and NO MARKER, the
//           status pill never reached connecting/connected, and NO request went to EVIL.
//   Leg 2 — open the bare URL (no hash). It inherits Leg 1's localStorage. Assert it reads that
//           storage (PRESEED present → propagation confirmed) with host still '' and the link's
//           MARKER absent, shows the "not-connected" overlay (NOT confirm-host), never connects,
//           and never contacts EVIL.
// S10 widened this: the hold covers the WHOLE unconfirmed payload, not just `host` — an
// unconfirmed link must leave the user's stored state byte-identical. A regression that persists
// any part of the hash payload, or auto-connects to it, flips one of these to fail.
async function runHostConfirmProbe(browser) {
  const EVIL = 'https://evil.s2probe.example';
  const MARKER = 'ws_s2probe_marker';   // carried by the LINK — must never reach localStorage
  const PRESEED = 'ws_s2probe_preseed'; // the user's own pre-link state — must survive untouched
  const KEY = 'tsp_state_v1';
  const b64url = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const SEEDED = b64url({ worksheetId: PRESEED });
  const hash = Buffer.from(JSON.stringify({ host: EVIL, worksheetId: MARKER }), 'utf8').toString('base64url');
  const touchedEvil = (r) => r.url().includes('evil.s2probe.example');
  // Mirror state.js decode(): base64url → UTF-8 bytes → JSON. Returns null if storage is absent.
  const readStored = (k) => {
    const s = localStorage.getItem(k);
    if (!s) return null;
    try {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '='));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return { host: 'DECODE_ERROR' }; }
  };

  // ── Leg 1: hash-sourced host → confirm overlay, blanked in storage, no contact ──
  const p1 = await browser.newPage();
  const evilUrls1 = [];
  p1.on('request', (r) => { if (touchedEvil(r)) evilUrls1.push(r.url()); });
  let confirmShown, p1Stored, p1Status, p1StoredRaw, p1HashReencoded;
  try {
    // Seed the user's own pre-link state BEFORE any app module runs.
    await p1.evaluateOnNewDocument((k, v) => { try { localStorage.setItem(k, v); } catch (_) {} }, KEY, SEEDED);
    await p1.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // Positive control: the hash host must surface as a pending confirmation naming EVIL.
    confirmShown = await p1.waitForFunction((evil) => {
      const active = document.querySelector('.st-confirm-host.active');
      const name = document.getElementById('confirm-host-name')?.textContent || '';
      return !!active && name.includes(evil);
    }, { polling: 300, timeout: 20_000 }, EVIL).then(() => true, () => false);
    await sleep(1200); // let the 250ms debounced persist fire AND app.js's 400ms restore land
    p1Stored = await p1.evaluate(readStored, KEY);
    p1StoredRaw = await p1.evaluate((k) => localStorage.getItem(k), KEY);
    // Positive control for the storage assertion: schedulePersist() rewrites the URL hash and
    // localStorage in the SAME tick, so a hash that no longer equals the one we navigated with
    // proves a persist cycle really ran — i.e. the untouched storage below is the hold working,
    // not the app simply never persisting.
    p1HashReencoded = await p1.evaluate((h) => location.hash !== `#s=${h}`, hash);
    p1Status = await p1.evaluate(() => document.getElementById('conn-status')?.dataset.state || '');
  } finally {
    await p1.close();
  }
  // ── Leg 2: plain revisit (no hash) inherits Leg 1's storage → not-connected, no auto-connect ──
  const p2 = await browser.newPage();
  const evilUrls2 = [];
  p2.on('request', (r) => { if (touchedEvil(r)) evilUrls2.push(r.url()); });
  let notConnected, confirmAbsent, p2Stored, p2Status;
  try {
    await p2.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30_000 });
    notConnected = await p2.waitForFunction(
      () => !!document.querySelector('.st-not-connected.active'),
      { polling: 300, timeout: 20_000 },
    ).then(() => true, () => false);
    confirmAbsent = await p2.evaluate(() => !document.querySelector('.st-confirm-host.active'));
    p2Stored = await p2.evaluate(readStored, KEY);
    p2Status = await p2.evaluate(() => document.getElementById('conn-status')?.dataset.state || '');
  } finally {
    await p2.close();
  }

  // connect() is the ONLY driver of the #conn-status pill off 'idle' (app.js: setStatus
  // 'connecting'→'ok'/'error'); if it never ran, the pill is untouched. That is the authoritative
  // "did NOT auto-connect" signal — more robust than counting packets, since the SDK's own init()
  // preauth warm-up (below) contacts the host regardless of whether the app connected.
  const CONNECT_STATES = ['connecting', 'ok', 'error'];
  return {
    // ── Gated (S2 acceptance criteria) ──
    // Leg 1 — hash host: confirm overlay, host blanked in storage, no auto-connect
    confirmShown,
    p1PersistRan: p1HashReencoded === true,                  // positive control — a persist happened
    p1HostBlanked: (p1Stored?.host ?? '') === '',
    p1StorageUntouched: p1StoredRaw === SEEDED,              // S10 — the WHOLE payload is held
    p1LinkStateNotPersisted: p1Stored?.worksheetId !== MARKER,
    p1ConnectSkipped: !CONNECT_STATES.includes(p1Status),
    // Leg 2 — plain revisit: not-connected, host still blank, no auto-connect
    notConnected,
    confirmAbsent,
    p2StoragePropagated: p2Stored?.worksheetId === PRESEED,  // proves Leg 2 read Leg 1's storage
    p2HostBlanked: (p2Stored?.host ?? '') === '',
    p2LinkStateAbsent: p2Stored?.worksheetId !== MARKER,
    p2ConnectSkipped: !CONNECT_STATES.includes(p2Status),
    // Gated since S10: the SDK's init() used to fire preauth warm-up GETs at the unconfirmed host
    // (/prism/preauth/info, /callosum/v1/session/info) because applyConfig() called initSDK()
    // before the Confirm click. applyConfig() now short-circuits while pendingHostConfirm, so an
    // unconfirmed host must receive NOTHING.
    hostContactUrls: [...evilUrls1, ...evilUrls2],
  };
}

// Standalone-Answer picker probe (BACKLOG S3): the Single-Viz section must offer a standalone
// saved-Answer picker, and an `answerId` in state must drive the SearchEmbed code path (a saved
// answer cannot be embedded as a liveboard viz — see embed.js/generateCode). This is a host-free
// feature probe: the #s= hash carries {section:'viz', answerId:GUID} with NO host, so nothing
// contacts ThoughtSpot (no confirm overlay, no iframe) — we assert the UI landed and the generated
// SDK snippet reflects the answer path. Runs on its own page like the XSS/host-confirm probes.
async function runAnswerPickerProbe(browser) {
  const ANS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // dummy GUID; host omitted -> no confirm, no host contact
  const hash = Buffer.from(JSON.stringify({ section: 'viz', answerId: ANS }), 'utf8').toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    const retryUntil = (fn) => probe.waitForFunction(fn, { polling: 500, timeout: 20_000 }).then(() => true, () => false);
    // Positive control: the inspector must render the standalone-Answer picker (its 'Answer' label).
    const pickerRendered = await retryUntil(() =>
      [...document.querySelectorAll('#insp-body .fld-lbl')].some((l) => l.textContent.trim() === 'Answer'));
    // The generated SDK code must take the SearchEmbed({answerId, hideSearchBar}) path for this state.
    // Click the SDK Code tab if the pane hasn't been refreshed yet (refreshCode runs on tab switch).
    const codeOk = await retryUntil(() => {
      const txt = document.getElementById('code-view')?.textContent || '';
      const hit = txt.includes('SearchEmbed') && txt.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') && txt.includes('hideSearchBar: true');
      if (!hit) document.querySelector('.bp-tab[data-tab="code"]')?.click();
      return hit;
    });
    return { pickerRendered, codeOk, noErrors: probeErrors.length === 0, probeErrors };
  } finally {
    await probe.close();
  }
}

// Answer auto-load pre-confirm probe (BACKLOG S3, fix #2): the standalone-Answer auto-load in
// sectionObject() fires a CREDENTIALED discovery POST (discoverAnswers → POST /metadata/search).
// That POST must NEVER hit a host that arrived via the attacker-controllable #s= share hash before
// the user has explicitly clicked Connect — otherwise a shared link would silently drive the
// visitor's session against an attacker-named host. The guard is app.js's `connected &&` prefix on
// both auto-load conditions in sectionObject (js/app.js, the `needs === 'viz'` branch).
//
// Navigate to `#s={section:'viz', host:EVIL, liveboardId:LB}`. The app boots into
// pendingHostConfirm (host set, NOT connected) and renders the Single-Viz inspector — so BOTH
// auto-load conditions are genuinely evaluated pre-connect:
//   • the standalone-Answer load (`connected && answerList === undefined`) → POST /metadata/search
//   • the viz load (`connected && s.liveboardId && vizCache[...] === undefined`, fenced by the S10
//     review) → POST /metadata/search (visualization headers) via Discovery.discoverViz
// The `liveboardId` is what gives the second leg teeth: without it loadViz() returns early and the
// assertion passes whether or not the fence exists. Both discovery calls send
// `credentials:'include'` (discovery.js), so an unfenced one ships the visitor's cookies to an
// attacker-named host with zero clicks.
// Assert the confirm overlay is up (positive control: we are in the pre-confirm state where the
// guards matter) AND that NO discovery POST — and in fact no request at all — reached the
// unconfirmed host. Runs on its own page.
async function runAnswerPreconfirmProbe(browser) {
  const HOST = 'https://evil.s3probe.example';
  const LB = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // survives sanitize; makes loadViz() reachable
  const hash = Buffer.from(
    JSON.stringify({ section: 'viz', host: HOST, liveboardId: LB }), 'utf8'
  ).toString('base64url');
  const probe = await browser.newPage();
  // Attached BEFORE goto so a boot-time fetch is caught. `discoveryHits` names the app's own
  // credentialed REST calls (both /metadata/ paths); `allHits` catches anything else that slips out.
  const discoveryHits = [];
  const allHits = [];
  probe.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(HOST)) return;
    allHits.push(`${r.method()} ${u}`);
    if (u.includes('/metadata/')) discoveryHits.push(`${r.method()} ${u}`);
  });
  let confirmShown;
  try {
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // Positive control: the hash host must surface as a pending confirmation naming EVIL — proves we
    // are in the pre-confirm state where the auto-load guard is the thing under test.
    confirmShown = await probe.waitForFunction((host) => {
      const active = document.querySelector('.st-confirm-host.active');
      const name = document.getElementById('confirm-host-name')?.textContent || '';
      return !!active && name.includes(host);
    }, { polling: 300, timeout: 20_000 }, HOST).then(() => true, () => false);
    await sleep(800); // let any (guarded-away) auto-load fetch initiate before we read the tally
    return {
      confirmShown,
      noDiscoveryContact: discoveryHits.length === 0,
      noAnyContact: allHits.length === 0,
      discoveryHits,
      allHits,
    };
  } finally {
    await probe.close();
  }
}

// URL-action scheme probe (BACKLOG S13): a custom action's `urlTemplate` arrives from the
// attacker-controllable #s= share hash and state.js sanitizes it by LENGTH ONLY — so a
// `javascript:` (or data:/vbscript:/blob:) template would reach window.open() and execute
// (`noopener` severs window.opener but does not stop script). The guard is app.js's `safeNavUrl()`
// applied to the FINAL substituted url inside window.__onCustomAction — that sink is the trust
// boundary (the editor-form check is defence in depth and is bypassed entirely by a shared link).
//
// Host-free probe: the hash carries only {customActions:[…]} so nothing contacts ThoughtSpot.
// window.open is stubbed before any app code runs, recording every call into window.__opened.
//   Negative: dispatch the `javascript:` action → nothing hostile opened, window.__pwned unset.
//   Positive control (mandatory): dispatch a plain https action with a {{placeholder}} → it MUST
//     open the substituted, encodeURIComponent'd URL. Without it, a broken registry rebuild or a
//     no-op dispatcher would make the negative assertion vacuously true.
// Drill-through probe (S22): the demo section's two host-side moves must hold end to end.
// searchdata is stubbed in-page so this runs with no ThoughtSpot instance — what's under test is
// OUR wiring, not TS: the column-scoped action reaches the generated code as
// '<modelGuid>::<column>', the clicked point scopes the detail query, record_offset actually
// advances on "Load more", the KPI/row-count badge reconciles (and shouts when it doesn't), and a
// javascript: link template is refused at the anchor rather than rendered.
/**
 * GENERATOR-WIDE: every SDK identifier the generated snippet USES must appear in the import line
 * that same snippet emits. Gate this per rail section, not per feature — the drill-through import
 * gating was wrong for months precisely because the check only ever looked at one section's body,
 * and a missing name is a ReferenceError on the first paste.
 */
const SDK_ID_RE = /\b(init|AuthType|EmbedEvent|HostEvent|RuntimeFilterOp|CustomActionsPosition|CustomActionTarget|Action|Page|LiveboardEmbed|SearchEmbed|AppEmbed|SpotterEmbed|SageEmbed)\b/g;

function importGapsIn(code) {
  // [^}] keeps the match inside ONE import statement: with [\s\S] a snippet that imports another
  // package first (spotter-chat's MCP client) matched from that earlier `import {` to the SDK's.
  const m = /import \{([^}]*)\} from '@thoughtspot\/visual-embed-sdk';/.exec(code);
  if (!m) return null;                       // ai-insights emits no SDK import
  const imported = new Set(m[1].split(',').map((x) => x.trim()).filter(Boolean));
  const body = code.slice(m.index + m[0].length)
    .replace(/^\s*\/\/.*$/gm, '')            // whole-line comments
    .replace(/\s\/\/\s.*$/gm, '');           // trailing comments ("https://" has no space before //)
  const used = new Set(body.match(SDK_ID_RE) || []);
  return [...used].filter((u) => !imported.has(u));
}

/**
 * The only rail section that legitimately emits no Visual Embed SDK import: it is a host-side
 * REST flow, not an embed. Every OTHER section must emit one, so the coverage count cannot drift
 * downwards unnoticed.
 */
// spotter-chat left this set in S45: its browser half now MUST import init + startAutoMCPFrameRenderer
// (a raw iframe_url renders blank), so a regression back to "no SDK import" fails here.
const NON_SDK_SECTIONS = new Set(['ai-insights']);

async function runCodeGenImportProbe(browser) {
  // Drill-through demo defaults: enabled + summaryModelId + measureColumn, no other actions or
  // filters — the setup a reader lands on from the inspector, and the one that emitted
  // CustomActionsPosition/CustomActionTarget without importing them.
  const drill = {
    enabled: true, summaryModelId: 'model-a', measureColumn: 'Total Sales Amount',
    detailModelId: 'model-b', detailColumns: ['Order Id', 'Order Date'],
  };
  const hash = Buffer.from(JSON.stringify({ section: 'liveboard', liveboardId: 'lb-summary', drill }), 'utf8').toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    await sleep(900);
    const snippets = await probe.evaluate(async () => {
      const out = [];
      const ids = [...document.querySelectorAll('#embed-list li.embed-item')].map((li) => li.dataset.id);
      const grab = async (label) => {
        document.querySelector('[data-tab="code"]')?.click();
        await new Promise((r) => setTimeout(r, 250));
        out.push({ id: label, code: document.getElementById('code-view')?.textContent || '' });
      };
      for (const id of ids) {
        document.querySelector(`#embed-list li[data-id="${id}"]`)?.click();
        await new Promise((r) => setTimeout(r, 150));
        await grab(id);
      }
      // …and the drill-through setup that ALSO emits the point-click leg (HostEvent/RuntimeFilterOp).
      const st = await import('./js/state.js');
      st.setState({ section: 'drillthrough', drill: { ...st.getState().drill, drillLiveboardId: 'lb-detail', drillVizId: 'viz-CHART', trigger: 'action' } });
      await new Promise((r) => setTimeout(r, 150));
      await grab('drillthrough+pointdrill');
      return { ids, out };
    });
    const gaps = [];
    const skipped = [];
    let checked = 0;
    snippets.out.forEach(({ id, code }) => {
      const missing = importGapsIn(code);
      // A snippet with no SDK import line is SKIPPED by the gap check, so counting only the checked
      // ones lets a code-view regression in any section quietly shrink the coverage and stay green.
      // Everything except the two known non-SDK sections must therefore emit an SDK import.
      if (missing === null) { skipped.push(id); return; }
      checked++;
      if (missing.length) gaps.push(`${id}: ${missing.join(', ')}`);
    });
    const unexpectedSkips = skipped.filter((id) => !NON_SDK_SECTIONS.has(id));
    return { sections: snippets.ids.length, checked, gaps, skipped, unexpectedSkips, probeErrors };
  } finally {
    await probe.close();
  }
}

async function runDrillthroughProbe(browser) {
  const drill = {
    enabled: true, summaryModelId: 'model-a', measureColumn: 'Meeting count', actionLabel: 'View meetings',
    detailModelId: 'model-b', detailColumns: ['Meeting Id', 'User Name', 'Booked at'], scopeColumn: 'Stage',
    drillLiveboardId: 'lb-detail', linkTemplate: 'https://example.invalid/m/{Meeting Id}', pageSize: 2,
    // The paging/link legs below assert against the docked grid; the modal leg flips this at the end.
    presentation: 'panel', recordNoun: 'meetings', periodLabel: 'This Year',
  };
  const hash = Buffer.from(JSON.stringify({ section: 'drillthrough', liveboardId: 'lb-summary', drill }), 'utf8').toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    await sleep(900);

    const railOk = await probe.evaluate(() =>
      [...document.querySelectorAll('#embed-list li')].some((li) => li.textContent.includes('Drill-through')));
    const panelOk = await probe.evaluate(() =>
      [...document.querySelectorAll('.acc')].some((a) => a.textContent.includes('Drill-through')));

    const code = await probe.evaluate(async () => {
      document.querySelector('[data-tab="code"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      return document.getElementById('code-view')?.textContent || document.getElementById('bottom')?.textContent || '';
    });
    const codeOk = code.includes("modelColumnNames: ['model-a::Meeting count']")
      && !/metadataIds/.test(code)   // nothing pinned yet, so no vizIds clause
      && code.includes('CustomActionsPosition.CONTEXTMENU') && code.includes('CustomActionTarget.VIZ')
      && code.includes('EmbedEvent.VizPointClick') && code.includes('HostEvent.GetFilters')
      && code.includes('record_offset: offset');

    // S46: the snippet's date helpers are emitted from the live functions, so the regex the snippet
    // tests column names with must be byte-identical to the app's — read straight from the source,
    // never re-typed here (a re-typed copy is exactly the drift this guards). And the pasted snippet
    // must still parse as an ES module (`node --check` parses only; the SDK import is not resolved).
    const liveRe = /^const CFB_DATE_NAME_RE = (\/.+\/[a-z]*);$/m.exec(readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8'))?.[1];
    const snipDir = mkdtempSync(path.join(os.tmpdir(), 'dt-snippet-'));
    let snippetParses = false;
    try {
      writeFileSync(path.join(snipDir, 'snippet.mjs'), code);
      snippetParses = spawnSync(process.execPath, ['--check', path.join(snipDir, 'snippet.mjs')]).status === 0;
    } finally {
      rmSync(snipDir, { recursive: true, force: true });
    }
    const snippetOk = !!liveRe && code.includes(`const tsDateName = (c) => ${liveRe}.test(c);`)
      && /const tsEpochSec = function dtEpochSec\(/.test(code) && snippetParses;

    // Drive the REAL dispatcher; only the network is faked.
    const run = await probe.evaluate(async () => {
      const cols = ['Meeting Id', 'User Name', 'Booked at'];
      // The fixture emulates the REAL cluster: available_data_row_count comes back equal to the
      // rows in THIS page, never the grand total (verified on 26.8.0.cl, contrary to the REST
      // schema's "Total available data row count"). Page 1 is therefore indistinguishable from a
      // result of exactly 2 rows except by asking for page 2 — so a full page must keep "Load more"
      // alive and must NOT let the badge claim a reconciliation it cannot know yet.
      const pages = [
        { column_names: cols, data_rows: [['m1', 'Lakshman', '2026-01-02'], ['m2', 'Lakshman', '2026-01-03']], available_data_row_count: 2, returned_data_row_count: 2 },
        { column_names: cols, data_rows: [['m3', 'Lakshman', '2026-01-04']], available_data_row_count: 1, returned_data_row_count: 1 },
      ];
      let call = 0; const bodies = [];
      const real = window.fetch;
      window.fetch = async (url, opts) => {
        if (String(url).includes('searchdata')) {
          bodies.push(JSON.parse(opts.body));
          return new Response(JSON.stringify({ contents: [pages[Math.min(call++, 1)]] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return real(url, opts);
      };
      const click = (measure) => window.__onCustomAction({
        id: '__dt_view_detail',
        data: { clickedPoint: {
          selectedAttributes: [{ column: { name: 'Stage' }, value: 'Prospecting' }, { column: { name: 'User Name' }, value: 'Lakshman' }],
          selectedMeasures: [{ column: { name: 'Meeting count' }, value: measure }],
        } },
      });
      await click(3);
      await new Promise((r) => setTimeout(r, 300));
      const p1 = document.getElementById('dt-panel');
      const first = {
        rows: p1?.querySelectorAll('.dt-table tbody tr').length,
        more: !!p1?.querySelector('.dt-more'),
        badge: p1?.querySelector('.dt-badge')?.textContent,
        mismatch: !!p1?.querySelector('.dt-badge--mismatch'),
      };
      p1?.querySelector('.dt-more')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const p2 = document.getElementById('dt-panel');
      const after = {
        rows: p2?.querySelectorAll('.dt-table tbody tr').length, more: !!p2?.querySelector('.dt-more'),
        href: p2?.querySelector('.dt-link')?.getAttribute('href'),
        badge: p2?.querySelector('.dt-badge')?.textContent, mismatch: !!p2?.querySelector('.dt-badge--mismatch'),
      };
      // A KPI that disagrees with the row count must be flagged, not quietly shown.
      await click(99);
      await new Promise((r) => setTimeout(r, 300));
      const mismatchShown = !!document.querySelector('.dt-badge--mismatch');
      // A javascript: link template must never become a live anchor.
      const st = await import('./js/state.js');
      st.setState({ drill: { ...st.getState().drill, linkTemplate: 'javascript:window.__dtPwned=1//{Meeting Id}' } });
      await click(3);
      await new Promise((r) => setTimeout(r, 300));
      const p3 = document.getElementById('dt-panel');
      const guard = { anchors: p3?.querySelectorAll('.dt-link').length, blocked: p3?.querySelectorAll('.dt-link-bad').length, pwned: window.__dtPwned === 1 };

      // Modal presentation: the record-list surface. Same `dt` state, different painter.
      call = 0; // rewind the stub so this leg sees a FULL first page, not the tail of the last one
      st.setState({ drill: { ...st.getState().drill, presentation: 'modal', linkTemplate: 'https://example.invalid/m/{Meeting Id}' } });
      await click(3);
      await new Promise((r) => setTimeout(r, 300));
      const mp = document.getElementById('dt-modal-panel');
      const modal = {
        mounted: !!mp,
        panelGone: !document.getElementById('dt-panel'),
        title: mp?.querySelector('.modal-title')?.textContent,
        period: mp?.querySelector('.modal-sub')?.textContent,
        summary: mp?.querySelector('.dt-summary')?.textContent,
        records: mp?.querySelectorAll('.dt-rec').length,
        chevrons: mp?.querySelectorAll('.dt-rec-chev').length,
        href: mp?.querySelector('a.dt-rec')?.getAttribute('href'),
        more: !!mp?.querySelector('.dt-more'),
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 120));
      modal.closedByEsc = !document.getElementById('dt-modal');
      // TABLE right-click payload, copied from a real 26.8.0.cl response (see docs/org-memory):
      // contextMenuPoints is an OBJECT, selectedAttributes is EMPTY, and the row's attributes are
      // in deselectedAttributes. Reading only selectedAttributes yields no scope at all, and the
      // detail query silently returns the whole model — which is what shipped before this fixture.
      st.setState({ drill: { ...st.getState().drill, presentation: 'modal', scopeColumn: 'Employee Name', measureColumn: 'Total Sales Amount' } });
      document.getElementById('dt-modal')?.remove();
      call = 0;
      const tableQueryIdx = bodies.length; // keep the paging legs' bodies intact
      await window.__onCustomAction({
        id: '__dt_view_detail',
        data: {
          vizId: 'viz-TABLE',
          contextMenuPoints: {
            clickedPoint: {
              selectedAttributes: [],
              deselectedAttributes: [
                { column: { name: 'Employee Name' }, value: 'Lynn Tsoflias' },
                { column: { name: 'Territory' }, value: 'Pacific' },
              ],
              // The user right-clicked the Total Sales Amount cell: ThoughtSpot reports the clicked
              // cell in selected*, the rest of the row in deselected* (verified live on 26.8.0.cl).
              selectedMeasures: [{ column: { name: 'Total Sales Amount' }, value: '134280.9824' }],
              deselectedMeasures: [
                { column: { name: 'Total Sales Amount Quota' }, value: '{Null}' },
                { column: { name: 'Quota %' }, value: '{Null}' },
              ],
            },
            selectedPoints: [],
          },
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      const tp = document.getElementById('dt-modal-panel');
      const tableClick = {
        query: bodies[tableQueryIdx]?.query_string,
        title: tp?.querySelector('.modal-title')?.textContent,
        summary: tp?.querySelector('.dt-summary')?.textContent,
      };
      // The action shows on EVERY cell of the viz (no per-cell scoping exists), so a right-click on
      // a cell that isn't the configured measure — here "Employee Name", captured live: the name in
      // selectedAttributes, every measure in deselectedMeasures — must be refused, not drilled.
      document.getElementById('dt-modal')?.remove();
      const refuseIdx = bodies.length;
      await window.__onCustomAction({
        id: '__dt_view_detail',
        data: {
          vizId: 'viz-TABLE',
          contextMenuPoints: {
            clickedPoint: {
              selectedAttributes: [{ column: { name: 'Employee Name' }, value: 'Jae Pak' }],
              deselectedAttributes: [{ column: { name: 'Territory' }, value: 'Europe' }],
              selectedMeasures: [],
              deselectedMeasures: [
                { column: { name: 'Total Sales Amount Quota' }, value: '{Null}' },
                { column: { name: 'Total Sales Amount' }, value: '280800' },
                { column: { name: 'Quota %' }, value: '{Null}' },
              ],
            },
            selectedPoints: [],
          },
        },
      });
      await new Promise((r) => setTimeout(r, 300));
      tableClick.refused = !document.getElementById('dt-modal') && bodies.length === refuseIdx;

      // Presets: save the current setup, wipe the slice, reapply, confirm it came back. Also that a
      // hand-edited localStorage entry cannot introduce keys the drill slice does not already have.
      st.setState({ drill: { ...st.getState().drill, measureColumn: 'Meeting count', recordNoun: 'meetings' } });
      const presets = {};
      document.querySelector('.dpre-add')?.click();
      await new Promise((r) => setTimeout(r, 200));
      const nameInput = document.querySelector('.dpre-input');
      if (nameInput) {
        nameInput.value = 'probe setup';
        document.querySelector('.dpre-add--cta')?.click();
        await new Promise((r) => setTimeout(r, 250));
      }
      presets.stored = !!(JSON.parse(localStorage.getItem('tsp_drill_presets_v1') || '{}')['probe setup']);
      const raw = JSON.parse(localStorage.getItem('tsp_drill_presets_v1') || '{}');
      if (raw['probe setup']) {
        raw['probe setup'].drill.bogusKey = 'nope';                 // a key the slice does not have
        raw['probe setup'].drill['__proto__'] = { polluted: 1 };    // and a polluting one
        localStorage.setItem('tsp_drill_presets_v1', JSON.stringify(raw));
      }
      st.setState({ drill: { ...st.getState().drill, measureColumn: '', recordNoun: 'rows' } });
      const keysBefore = Object.keys(st.getState().drill).length;
      [...document.querySelectorAll('.dpre-go')].find((b) => b.textContent === 'probe setup')?.click();
      await new Promise((r) => setTimeout(r, 300));
      const back = st.getState().drill;
      presets.restored = back.measureColumn === 'Meeting count' && back.recordNoun === 'meetings';
      presets.noNewKeys = Object.keys(back).length === keysBefore && !('bogusKey' in back);
      presets.noPollution = ({}).polluted === undefined;
      // Pinning: naming visualizations must add metadataIds.vizIds to the declaration, and
      // clearing it must take the clause back out. This is the contract the app controls; whether
      // ThoughtSpot then hides the item on other vizzes is a live-UI behaviour, not asserted here.
      const pinning = {};
      st.setState({ drill: { ...st.getState().drill, actionVizIds: ['viz-ONLY-THIS'] } });
      await new Promise((r) => setTimeout(r, 300));
      const withPin = document.getElementById('code-view')?.textContent || '';
      pinning.added = /metadataIds: \{ vizIds: \['viz-ONLY-THIS'\] \}/.test(withPin);
      st.setState({ drill: { ...st.getState().drill, actionVizIds: [] } });
      await new Promise((r) => setTimeout(r, 300));
      pinning.removed = !/metadataIds/.test(document.getElementById('code-view')?.textContent || '');

      presets.folded = [...document.querySelectorAll('.insp-sub')].length >= 3
        && [...document.querySelectorAll('.insp-sub')].every((x) => !x.open);

      // Drill scoping: VizPointClick fires for EVERY viz on the board, so a click from a viz other
      // than the configured one must not drill away. Only the negative case is asserted here — the
      // positive case re-renders a real embed, which this stubbed page has no business doing.
      st.setState({ drill: { ...st.getState().drill, trigger: 'action', drillLiveboardId: 'lb-detail', drillVizId: 'viz-CHART' } });
      document.getElementById('dt-modal')?.remove();
      await window.__onVizPointClick({ data: { vizId: 'viz-TABLE', clickedPoint: { selectedAttributes: [{ column: { name: 'Stage' }, value: 'Prospecting' }] } } });
      await new Promise((r) => setTimeout(r, 200));
      const scoping = { otherVizDrilled: !!document.getElementById('drill-bar') };

      // S31 — a Month(...) bucket covers a RANGE of days. Emitting only the bucket's start lists
      // the 1st of the month while the KPI covers the whole month, and the badge then flags a
      // mismatch that is not real. `scopeColumn` is the UNSTRIPPED name on purpose: the user types
      // 'Order Date', the click reports 'Month(Order Date)', and those must still match.
      call = 0;
      document.getElementById('dt-modal')?.remove();
      st.setState({ drill: { ...st.getState().drill, presentation: 'modal', scopeColumn: 'Order Date', measureColumn: 'Total Sales Amount', trigger: 'action' } });
      const monthIdx = bodies.length;
      await window.__onCustomAction({
        id: '__dt_view_detail',
        data: { clickedPoint: {
          selectedAttributes: [],
          deselectedAttributes: [
            { column: { name: 'Month(Order Date)' }, value: '1733011200' },
            { column: { name: 'Territory' }, value: 'Pacific' },
          ],
          selectedMeasures: [{ column: { name: 'Total Sales Amount' }, value: '10' }],
        } },
      });
      await new Promise((r) => setTimeout(r, 300));
      const monthQuery = bodies[monthIdx]?.query_string;

      // S32 — two overlapping clicks: A is SLOW, B is FAST. A's rows must never land in B's panel.
      const raceCols = ['Meeting Id', 'User Name', 'Booked at'];
      window.fetch = async (url, opts) => {
        if (String(url).includes('searchdata')) {
          const body = JSON.parse(opts.body); bodies.push(body);
          const isA = /a-scope/.test(body.query_string);
          await new Promise((r) => setTimeout(r, isA ? 500 : 20));
          const rows = isA ? [['a1', 'A', '2026-01-01'], ['a2', 'A', '2026-01-02']]
            : [['b1', 'B', '2026-02-01'], ['b2', 'B', '2026-02-02']];
          return new Response(JSON.stringify({ contents: [{ column_names: raceCols, data_rows: rows, available_data_row_count: 2, returned_data_row_count: 2 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return real(url, opts);
      };
      document.getElementById('dt-modal')?.remove();
      st.setState({ drill: { ...st.getState().drill, presentation: 'panel', scopeColumn: 'Stage' } });
      const clickScope = (v) => window.__onCustomAction({
        id: '__dt_view_detail',
        data: { clickedPoint: {
          selectedAttributes: [{ column: { name: 'Stage' }, value: v }],
          selectedMeasures: [{ column: { name: 'Total Sales Amount' }, value: '5' }],
        } },
      });
      const pA = clickScope('a-scope');
      await new Promise((r) => setTimeout(r, 60));
      const pB = clickScope('b-scope');
      await Promise.all([pA, pB]);
      await new Promise((r) => setTimeout(r, 800));   // long enough for A's slow page to land
      const rp = document.getElementById('dt-panel');
      const race = {
        rows: rp?.querySelectorAll('.dt-table tbody tr').length,
        firstCell: rp?.querySelector('.dt-table tbody tr td')?.textContent,
        moreButtons: rp?.querySelectorAll('.dt-more').length,
      };

      // S30 — a point-click drill must carry NUMERIC epochs on the UNDERLYING column. The drill
      // re-renders a real embed; that is contained inside this async dispatcher, so any failure
      // there surfaces as a rejected promise here rather than a page error.
      document.getElementById('dt-panel')?.remove();
      st.setState({ drill: { ...st.getState().drill, trigger: 'action', drillLiveboardId: 'lb-detail', drillVizId: '', scopeColumn: '' } });
      window.__TS_PLAYGROUND_PROBE = true;   // opt in to the carried-filter diagnostic
      window.__lastDrillFilters = null;
      // Park the embed container so the drill's doRender cannot create a live iframe against the
      // (deliberately absent) host. The SDK then fails fast INSIDE the async dispatcher, which is
      // a rejected promise this probe catches — not a page error.
      const cont = document.getElementById('ts-embed-container');
      if (cont) cont.id = 'ts-embed-container-parked';
      try {
        await window.__onVizPointClick({ data: { vizId: 'viz-TABLE', clickedPoint: {
          selectedAttributes: [],
          deselectedAttributes: [
            { column: { name: 'Employee Name' }, value: 'Lynn Tsoflias' },
            { column: { name: 'Day(Order Date)' }, value: '1769644800' },
          ],
          selectedMeasures: [{ column: { name: 'Total Sales Amount' }, value: '134280.9824' }],
        } } });
      } catch (_) { /* only the carried filters matter here, not the detail board's render */ }
      if (cont) cont.id = 'ts-embed-container';
      await new Promise((r) => setTimeout(r, 250));
      const carried = {
        filters: (window.__lastDrillFilters || []).map((f) => ({
          columnName: f.columnName, values: f.values, types: f.values.map((v) => typeof v),
        })),
        bar: document.querySelector('#drill-bar .drill-filters')?.textContent || '',
      };
      return { pinning, presets, bodies, first, after, mismatchShown, guard, modal, scoping, tableClick, monthQuery, race, carried };
    });

    const scopedQuery = run.bodies[0]?.query_string === "[Meeting Id] [User Name] [Booked at] [Stage] = 'Prospecting'";
    // The load-bearing assertion: after a FULL page, "Load more" must still be offered. A
    // row-count comparison against available_data_row_count would have hidden it here.
    const pagingOk = run.bodies[0]?.record_offset === 0 && run.bodies[0]?.record_size === 2
      && run.bodies[1]?.record_offset === 2
      && run.first.rows === 2 && run.first.more && run.after.rows === 3 && !run.after.more;
    // Mid-paging the total is unknown, so the badge reads "2+" and must NOT flag a mismatch;
    // once a short page proves the end, it reconciles 3 against 3.
    const badgeOk = /2\+ meetings/.test(run.first.badge || '') && !run.first.mismatch
      && /Meeting count: 3 · 3 meetings/.test(run.after.badge || '') && !run.after.mismatch && run.mismatchShown;
    const linkOk = run.after.href === 'https://example.invalid/m/m1'
      && run.guard.anchors === 0 && run.guard.blocked > 0 && !run.guard.pwned;
    const m = run.modal;
    const modalOk = m.mounted && m.panelGone && m.closedByEsc
      && m.title === 'Meeting count' && m.period === 'This Year'
      && /meetings/.test(m.summary || '') && /Meeting count: 3/.test(m.summary || '')
      && m.records === 2 && m.chevrons === 2 && m.href === 'https://example.invalid/m/m1' && m.more;
    const t = run.tableClick;
    const tableClickOk = t.query === "[Meeting Id] [User Name] [Booked at] [Employee Name] = 'Lynn Tsoflias'"
      && t.title === 'Total Sales Amount' && /134,280\.9824/.test(t.summary || '')
      && /Employee Name: Lynn Tsoflias/.test(t.summary || '')
      && t.refused === true;
    const pr = run.presets || {};
    const presetOk = pr.stored && pr.restored && pr.noNewKeys && pr.noPollution && pr.folded;
    const pinOk = !!(run.pinning && run.pinning.added && run.pinning.removed);
    const drillScopeOk = run.scoping.otherVizDrilled === false;
    // 1733011200 = 2024-12-01 UTC. The whole month, in the same token syntax the day clause uses.
    const monthRangeOk = run.monthQuery
      === "[Meeting Id] [User Name] [Booked at] [Order Date] >= '12/01/2024' [Order Date] <= '12/31/2024'";
    const raceOk = run.race.rows === 2 && run.race.firstCell === 'b1' && run.race.moreButtons === 1;
    const c = run.carried.filters;
    const dateCarried = c.find((f) => f.columnName === 'Order Date');
    const carriedOk = c.length === 2
      && !c.some((f) => /[()]/.test(f.columnName))                       // no Day(...) wrapper survives
      && !!dateCarried && dateCarried.values.length === 1
      && dateCarried.values[0] === 1769644800 && dateCarried.types[0] === 'number'
      && /Order Date: 2026-01-29/.test(run.carried.bar);
    return { railOk, panelOk, codeOk, snippetOk, scopedQuery, pagingOk, badgeOk, linkOk, modalOk, tableClickOk,
      presetOk, pinOk, drillScopeOk, monthRangeOk, raceOk, carriedOk, monthQuery: run.monthQuery, carried: run.carried, probeErrors };
  } finally {
    await probe.close();
  }
}

/**
 * A shared link's `flags` are NOT key-whitelisted by state.js sanitize, so a link can carry
 * `flags.<section>.liveboardId`. doRender spreads the explicit ids AFTER ...flags, so the render
 * uses the picked board — and the generated snippet must agree, or the user copies code aimed at a
 * different object than the tool just showed them.
 */
async function runFlagOverrideProbe(browser) {
  const hash = Buffer.from(JSON.stringify({
    section: 'liveboard', liveboardId: 'GOOD-LB',
    // Only liveboardId is planted: `vizId` is NOT spread after ...flags for the 'liveboard' case,
    // so a flags vizId legitimately reaches the real embed there and the snippet must keep matching
    // it. The claim under test is narrower — a flag cannot re-point the PICKED object.
    flags: { liveboard: { liveboardId: 'ATTACKER-LB', fullHeight: true } },
  }), 'utf8').toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    await sleep(900);
    const r = await probe.evaluate(async () => {
      const st = await import('./js/state.js');
      // Layer 1 (S39): sanitize() allowlists flag keys, so the link's liveboardId must be gone.
      const strippedByLink = st.getState().flags?.liveboard?.liveboardId === undefined;
      // Layer 2 (S29): plant the hostile flag past sanitize (setState does not sanitize) so the
      // render/code-gen assertions below are not vacuous.
      st.setState({ flags: { liveboard: { liveboardId: 'ATTACKER-LB', fullHeight: true } } });
      await new Promise((r2) => setTimeout(r2, 400));
      document.querySelector('[data-tab="code"]')?.click();
      await new Promise((r2) => setTimeout(r2, 400));
      return {
        strippedByLink,
        // POSITIVE CONTROL: the hostile flag must actually be in state, or every assertion below
        // passes vacuously.
        flagSurvived: st.getState().flags?.liveboard?.liveboardId === 'ATTACKER-LB',
        benignFlagSurvived: st.getState().flags?.liveboard?.fullHeight === true,
        renderedId: window.TS_CONFIG?.liveboardId,
        code: document.getElementById('code-view')?.textContent || '',
      };
    });
    return {
      strippedByLink: r.strippedByLink,
      flagSurvived: r.flagSurvived,
      benignFlagSurvived: r.benignFlagSurvived,
      renderUsesPicked: r.renderedId === 'GOOD-LB',
      // The snippet must name the picked board, must not mention the attacker's at all, and must
      // still carry the benign flag (proof the filter is narrow, not a blanket flag drop).
      codeUsesPicked: /liveboardId: 'GOOD-LB'/.test(r.code),
      codeFreeOfAttacker: !/ATTACKER/.test(r.code),
      codeKeepsBenignFlag: /fullHeight: true/.test(r.code),
      probeErrors,
    };
  } finally {
    await probe.close();
  }
}

async function runUrlActionSchemeProbe(browser) {
  const EVIL = 'javascript:window.__pwned=1';
  const GOOD = 'https://example.invalid/x?id={{Customer ID}}';
  const actions = [
    { id: 'evil', label: 'Evil', pos: 'PRIMARY', target: 'VISUALIZATION', type: 'url', urlTemplate: EVIL },
    { id: 'good', label: 'Good', pos: 'PRIMARY', target: 'VISUALIZATION', type: 'url', urlTemplate: GOOD },
  ];
  const hash = Buffer.from(JSON.stringify({ customActions: actions }), 'utf8').toString('base64url');
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    // Stub window.open BEFORE the app's modules run, so no real popup/navigation can occur.
    await probe.evaluateOnNewDocument(() => {
      window.__opened = [];
      window.open = (u) => { window.__opened.push(String(u)); return null; };
    });
    await probe.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // The dispatcher is installed as the module graph executes — retry until it exists.
    const dispatcherReady = await probe
      .waitForFunction(() => typeof window.__onCustomAction === 'function', { polling: 300, timeout: 20_000 })
      .then(() => true, () => false);
    // Bail out cleanly if the dispatcher never appeared: firing into a missing
    // `window.__onCustomAction` throws, the exception escapes this probe, and the outer finally
    // tears the browser down before the gate can print `BOOT CHECK: FAIL`. Returning the result
    // object with the remaining assertions false makes that a reported failure, not a stack trace.
    if (!dispatcherReady) {
      return { dispatcherReady: false, pwned: false, hostileOpened: [], goodOpened: false, opened: [], probeErrors };
    }
    const fire = (id) => probe.evaluate(async (actionId) => {
      await window.__onCustomAction({
        id: actionId,
        data: { clickedPoint: { selectedAttributes: [{ column: { name: 'Customer ID' }, value: '42' }] } },
      });
    }, id);
    await fire('evil');
    await sleep(400); // let any async work the dispatcher kicked off settle before we sample
    // BELT AND BRACES, NOT A REGRESSION DETECTOR: `pwned` is vacuous by construction — window.open
    // is stubbed with a recorder above, so no navigation can ever occur and `__pwned` can never be
    // set whether or not the guard exists. It is kept only to catch some other, unforeseen path
    // that manages to execute the payload. The load-bearing, mutation-proven assertion is
    // `hostileOpened.length === 0` below: no non-http(s) URL reached window.open.
    const pwned = await probe.evaluate(() => window.__pwned !== undefined);
    const hostileOpened = await probe.evaluate(
      () => (window.__opened || []).filter((u) => !/^https?:\/\//i.test(u)));
    await fire('good');
    await sleep(200);
    const opened = await probe.evaluate(() => window.__opened || []);
    return {
      dispatcherReady,
      pwned,
      hostileOpened,
      goodOpened: opened.includes('https://example.invalid/x?id=42'),
      opened,
      probeErrors,
    };
  } finally {
    await probe.close();
  }
}

// Connect race probe (BACKLOG S33): connect() awaits two discovery round-trips and then writes
// module globals (connected, the status pill, the overlay, `discovered`). Without an in-flight
// fence, a SLOW probe of a mistyped host that resolves AFTER a good connection overwrites the live
// session — the pill flips to that host's result and the pickers fill with the wrong instance's
// objects. The guard is app.js's `connectSeq` ticket + the captured-host check after every await.
//
// The two "clusters" must be DISTINCT ORIGINS: connect() normalizes every host to its origin (in
// lockstep with state.js's sanitize), so path-distinguished hosts on the gate's own server would
// collapse into one. A real cross-origin stub via request interception would need a CORS preflight
// that interception does not reliably surface (discovery sends `Content-Type: application/json`),
// so the probe stubs `window.fetch` itself for the two fake origins, before any app script runs.
// Host A's session call is held for 2.5s; host B's answers immediately. We connect A, then B, then
// wait past A's delay and assert nothing of A's ever lands.
//   Positive control (mandatory): B's own result must actually arrive — otherwise "A did not win"
//   would be vacuously true on a page where connect() is broken outright.
async function runConnectRaceProbe(browser) {
  const HOST_A = 'https://s33a.invalid';
  const HOST_B = 'https://s33b.invalid';
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.evaluateOnNewDocument((A, B) => {
      const SESSION = '/api/rest/2.0/auth/session/user';
      const SEARCH = '/api/rest/2.0/metadata/search';
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const u = typeof input === 'string' ? input : input?.url || String(input);
        if (u.startsWith(A + SESSION)) {
          await new Promise((r) => setTimeout(r, 2500)); // the hung probe of the mistyped host
          return json({ display_name: 'USER_A', current_org: { name: 'ORG_A' } });
        }
        if (u.startsWith(B + SESSION)) return json({ display_name: 'USER_B', current_org: { name: 'ORG_B' } });
        if (u.startsWith(A + SEARCH)) {
          return json([{ metadata_type: 'LOGICAL_TABLE', metadata_id: 'ws-a', metadata_name: 'WS_A' }]);
        }
        if (u.startsWith(B + SEARCH)) {
          return json([{ metadata_type: 'LOGICAL_TABLE', metadata_id: 'ws-b', metadata_name: 'WS_B' }]);
        }
        if (u.startsWith(A) || u.startsWith(B)) return new Response('', { status: 404 });
        return realFetch(input, init);
      };
    }, HOST_A, HOST_B);

    await probe.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30_000 });
    const connectTo = (h) => probe.evaluate((host) => {
      document.getElementById('host-input').value = host;
      document.getElementById('connect-btn').click();
    }, h);
    await connectTo(HOST_A);
    await sleep(300);      // A is now parked inside its first await
    await connectTo(HOST_B); // …and the user retypes the correct host
    const statusText = () => probe.evaluate(
      () => document.querySelector('#conn-status .tb-status-txt')?.textContent || '');
    // Positive control: B's connect must complete on its own merits.
    const bConnected = await probe.waitForFunction(
      () => (document.querySelector('#conn-status .tb-status-txt')?.textContent || '').includes('USER_B'),
      { polling: 200, timeout: 20_000 },
    ).then(() => true, () => false);
    await sleep(3500); // well past A's 2.5s hold — A's late response lands in here, or nowhere

    const finalStatus = await statusText();
    const overlay = await probe.evaluate(() => {
      const on = [...document.querySelectorAll('#state-overlay .active')];
      return on.map((e) => e.className).join(' ');
    });
    // Read the worksheet picker's options — this is `discovered.worksheets` rendered.
    const worksheets = await probe.evaluate(() => {
      const btn = [...document.querySelectorAll('#insp-body .fld')]
        .find((f) => f.querySelector('.fld-lbl')?.textContent.trim() === 'Worksheet / Model')
        ?.querySelector('.sel-btn');
      if (!btn || btn.disabled) return null;
      btn.click(); // the list renders lazily on open
      return [...document.querySelectorAll('.sel-item')].map((i) => i.textContent);
    });
    return {
      bConnected,
      statusIsB: finalStatus.includes('USER_B') && !finalStatus.includes('USER_A'),
      finalStatus,
      overlayOk: !/st-not-connected|st-error/.test(overlay),
      overlay,
      objectsAreB: Array.isArray(worksheets) && worksheets.includes('WS_B') && !worksheets.includes('WS_A'),
      worksheets,
      probeErrors,
    };
  } finally {
    await probe.close();
  }
}

// Custom-styles paste probe (BACKLOG S37): the "→ Add" box used to run `new Function` on whatever
// was pasted — arbitrary JS in the page's origin, with no CSP behind it. parseRulesObject is now a
// non-executing tokenizer (js/app.js jsObjectLiteralToJson) that converts the tolerant JS-literal
// grammar to JSON. The probe pastes an expression that WOULD set a flag if evaluated.
//   Negative: `rules_UNSTABLE: { '.a': (window.__pwned = 1, {}) }` → __pwned unset AND no rule added.
//   Positive control (mandatory): `rules_UNSTABLE: { '.a': { display: 'none' } }` → exactly one rule
//     lands, so a broken button or a collapsed accordion can't make the negative leg vacuous.
// Runs LAST: it writes state, and the persistence probes above must not inherit it.
async function runStylePasteProbe(browser) {
  const HOSTILE = "rules_UNSTABLE: { '.a': (window.__pwned = 1, {}) }";
  const GOOD = "rules_UNSTABLE: { '.a': { display: 'none' } }";
  const probe = await browser.newPage();
  const probeErrors = [];
  probe.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  try {
    await probe.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // Open the "CSS rules (rules_UNSTABLE)" accordion — the paste box lives inside it.
    const boxReady = await probe.waitForFunction(() => {
      const ta = [...document.querySelectorAll('#insp-body textarea')]
        .find((t) => (t.placeholder || '').includes('rules_UNSTABLE'));
      if (ta) return true;
      [...document.querySelectorAll('#insp-body .acc-head')]
        .find((h) => h.textContent.includes('CSS rules'))?.click();
      return false;
    }, { polling: 400, timeout: 20_000 }).then(() => true, () => false);
    if (!boxReady) {
      return { boxReady: false, pwned: false, hostileRejected: false, ruleCount: -1, goodAccepted: false, probeErrors };
    }
    const paste = (text) => probe.evaluate((t) => {
      const ta = [...document.querySelectorAll('#insp-body textarea')]
        .find((x) => (x.placeholder || '').includes('rules_UNSTABLE'));
      ta.value = t;
      // The "→ Add" button is the paste box's sibling.
      [...ta.parentElement.querySelectorAll('button')].find((b) => b.textContent.includes('Add'))?.click();
    }, text);
    await paste(HOSTILE);
    await sleep(500);
    const pwned = await probe.evaluate(() => window.__pwned !== undefined);
    const afterHostile = await probe.evaluate(
      () => [...document.querySelectorAll('#insp-body .sty-row')].length);
    const toasted = await probe.evaluate(
      () => [...document.querySelectorAll('#toast-container .toast')].some((t) => /Could not parse/i.test(t.textContent)));

    await paste(GOOD);
    await sleep(500);
    const rows = await probe.evaluate(() => [...document.querySelectorAll('#insp-body .sty-row')].length);
    const goodAccepted = await probe.evaluate(() => [...document.querySelectorAll('#insp-body .sty-row input.inp-sm')]
      .some((i) => i.value === '.a'));
    return {
      boxReady,
      pwned,
      hostileRejected: afterHostile === 0 && toasted,
      hostileRows: afterHostile,
      hostileToast: toasted,
      ruleCount: rows,
      goodAccepted,
      probeErrors,
    };
  } finally {
    await probe.close();
  }
}

// Pre-confirm credential-exfiltration probe (BACKLOG S10, P1). A `#s=` link can name any host AND
// any auth mode. SDK 1.49.0's init() authenticates IMMEDIATELY — no embed render, no click: under
// TrustedAuthTokenCookieless it calls getAuthToken (POST /api/auth/token on the VICTIM'S OWN token
// server, which mints a real token for the default user) and then GETs
// `${host}/callosum/v1/session/isactive` with `Authorization: Bearer <token>`; under
// TrustedAuthToken it mints and POSTs `${host}/callosum/v1/session/login/token`. So any path that
// reaches initSDK() with an unconfirmed host hands the attacker a live token. The guard is
// app.js's applyConfig() short-circuit while `pendingHostConfirm`.
//
// The gate server runs with TS_SECRET_KEY='' and would 503 the mint, which would make every
// assertion here pass vacuously — so the probe STUBS POST /api/auth/token with a fake token via
// request interception. Requests to the evil host are stubbed too (it must not resolve).
//   Negative (hard failures): before Confirm — including across an #auth-select change — ZERO
//     requests to the host and ZERO mint POSTs.
//   Positive control (mandatory): clicking Confirm MUST produce a mint POST and at least one
//     request to the host. Without it, a broken boot would make the negatives vacuous. The exact
//     SDK path (isactive / login/token) is reported as a diagnostic rather than gated — it is an
//     SDK-internal detail that a version bump may rename, and the gate should fail on a security
//     regression, not on an SDK refactor.
async function runPreauthExfilProbe(browser, authType, expectPath, testAuthChange = false) {
  const HOST = 'https://evil.invalid';
  const hash = Buffer.from(
    JSON.stringify({ host: HOST, authType, auth: { validitySeconds: 3600 } }), 'utf8'
  ).toString('base64url');
  const page = await browser.newPage();
  const probeErrors = [];
  page.on('pageerror', (e) => probeErrors.push('PAGEERROR: ' + e.message));
  const hostHits = [];   // every request aimed at the attacker-named host
  const mintHits = [];   // every POST at our own token endpoint
  try {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      const method = r.method();
      if (url.startsWith(HOST)) hostHits.push(`${method} ${url}`);
      const isMint = method === 'POST' && url.includes('/api/auth/token');
      if (isMint) mintHits.push(url);
      if (r.isInterceptResolutionHandled?.()) return;
      // Stub the mint so the probe can't pass just because the gate server has no secret.
      if (isMint) {
        r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'FAKE-TOKEN' }) })
          .catch(() => {});
        return;
      }
      // evil.invalid does not resolve — answer it ourselves so the SDK proceeds deterministically.
      if (url.startsWith(HOST)) {
        r.respond({ status: 200, contentType: 'application/json', body: '{}' }).catch(() => {});
        return;
      }
      r.continue().catch(() => {});
    });

    await page.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // Positive control for the pre-confirm state: the overlay must be up naming the host.
    const confirmShown = await page.waitForFunction((h) => {
      const active = document.querySelector('.st-confirm-host.active');
      return !!active && (document.getElementById('confirm-host-name')?.textContent || '').includes(h);
    }, { polling: 300, timeout: 20_000 }, HOST).then(() => true, () => false);
    await sleep(800); // let any (guarded-away) init()/mint initiate before we tally

    const preHostHits = [...hostHits];
    const preMintHits = [...mintHits];

    // Second pre-confirm route: changing the auth type re-runs applyConfig() (and opens the
    // trusted-auth modal) — it must not mint either. Only exercised on the cookieless run: the
    // #auth-select element offers no TrustedAuthToken option, so firing it on that run would
    // rewrite state.authType and silently turn the post-Confirm positive control into a second
    // cookieless test.
    let authChangeFired = false;
    if (testAuthChange) {
      authChangeFired = await page.evaluate(() => {
        const sel = document.getElementById('auth-select');
        if (!sel) return false;
        sel.value = 'TrustedAuthTokenCookieless';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      });
      await sleep(800);
    }
    const afterSelectHostHits = hostHits.length;
    const afterSelectMintHits = mintHits.length;

    // Positive control: Confirm must actually set the whole chain in motion.
    const confirmClicked = await page.evaluate(() => {
      const btn = document.getElementById('confirm-host-go');
      if (!btn) return false;
      btn.click();
      return true;
    });
    // 6s, not 20s: the mint is immediate when it happens at all, and this budget is spent TWICE
    // per run across TWO runs on top of a 20s waitForFunction — against a 120s whole-run watchdog
    // that process.exit(1)s WITHOUT printing `BOOT CHECK: FAIL`. A real regression must surface as
    // a named failure, not as a watchdog timeout.
    const waitUntil = async (fn, ms = 6_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (fn()) return true; await sleep(200); }
      return false;
    };
    const mintedAfterConfirm = await waitUntil(() => mintHits.length > 0);
    const contactedAfterConfirm = await waitUntil(() => hostHits.length > 0);
    await sleep(600); // let the post-token SDK call land so the diagnostic path is observable

    return {
      authType,
      confirmShown,
      confirmClicked,
      preConfirmHostHits: preHostHits,
      preConfirmMintHits: preMintHits,
      authChangeTested: testAuthChange,
      authChangeFired,
      noMintOnAuthChange: afterSelectMintHits === 0,
      noHostContactOnAuthChange: afterSelectHostHits === 0,
      mintedAfterConfirm,
      contactedAfterConfirm,
      expectPath,
      expectedPathSeen: hostHits.some((u) => u.includes(expectPath)),
      postConfirmHostHits: [...hostHits],
      probeErrors,
    };
  } finally {
    await page.close();
  }
}

let ok = false;
let browser;
try {
  if (!(await waitForReady())) {
    console.error('boot-check: server did not become ready.\n' + serverErr);
    process.exit(1);
  }

  const errors = [];       // JS console errors (resource-load failures judged via responses)
  const badResponses = []; // any 4xx/5xx — no exemptions

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return;
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(1500); // let the ES modules run

  const shellMounted = await page.$('#embed-list, .rail-group, #inspector') !== null;

  console.log(`HTTP status: ${resp.status()}`);
  console.log(`tool shell mounted: ${shellMounted}`);
  console.log(`JS console/page errors: ${errors.length}`);
  errors.forEach((e) => console.log('  -', e));
  console.log(`bad responses: ${badResponses.length}`);
  badResponses.forEach((e) => console.log('  -', e));

  const xss = await runXssProbe(browser);
  console.log(`XSS probe — payload executed: ${xss.executed}`);
  console.log(`XSS probe — rendered inert in auth group chips: ${xss.inChip}`);
  console.log(`XSS probe — rendered inert in event log: ${xss.inLog}`);
  xss.probeErrors.forEach((e) => console.log('  - probe page:', e));

  const host = await runHostConfirmProbe(browser);
  console.log(`Host-confirm probe (S2) — hash host shows confirm overlay: ${host.confirmShown}`);
  console.log(`Host-confirm probe (S2) — a persist cycle ran (positive control): ${host.p1PersistRan}`);
  console.log(`Host-confirm probe (S2) — hash host blanked in localStorage: ${host.p1HostBlanked}`);
  console.log(`Host-confirm probe (S2/S10) — pre-link localStorage left byte-identical: ${host.p1StorageUntouched}`);
  console.log(`Host-confirm probe (S2/S10) — link state not persisted: ${host.p1LinkStateNotPersisted}`);
  console.log(`Host-confirm probe (S2) — hash host not auto-connected: ${host.p1ConnectSkipped}`);
  console.log(`Host-confirm probe (S2) — plain revisit inherits storage (pre-link marker): ${host.p2StoragePropagated}`);
  console.log(`Host-confirm probe (S2) — plain revisit host still blank: ${host.p2HostBlanked}`);
  console.log(`Host-confirm probe (S2/S10) — plain revisit carries no link state: ${host.p2LinkStateAbsent}`);
  console.log(`Host-confirm probe (S2) — plain revisit shows not-connected: ${host.notConnected}`);
  console.log(`Host-confirm probe (S2) — plain revisit hides confirm overlay: ${host.confirmAbsent}`);
  console.log(`Host-confirm probe (S2) — plain revisit does not auto-connect: ${host.p2ConnectSkipped}`);
  console.log(`Host-confirm probe (S10) — zero requests to the unconfirmed host: ${host.hostContactUrls.length === 0}`);
  host.hostContactUrls.forEach((u) => console.log('  - contacted unconfirmed host:', u));
  const hostOk = host.confirmShown && host.p1PersistRan && host.p1HostBlanked && host.p1StorageUntouched
    && host.p1LinkStateNotPersisted && host.p1ConnectSkipped
    && host.notConnected && host.confirmAbsent && host.p2StoragePropagated && host.p2HostBlanked
    && host.p2LinkStateAbsent && host.p2ConnectSkipped && host.hostContactUrls.length === 0;

  const answer = await runAnswerPickerProbe(browser);
  console.log(`Answer-picker probe (S3) — standalone-Answer picker renders: ${answer.pickerRendered}`);
  console.log(`Answer-picker probe (S3) — answerId drives SearchEmbed code path: ${answer.codeOk}`);
  console.log(`Answer-picker probe (S3) — no page errors: ${answer.noErrors}`);
  answer.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const answerOk = answer.pickerRendered && answer.codeOk && answer.noErrors;

  const s3pre = await runAnswerPreconfirmProbe(browser);
  console.log(`Answer pre-confirm probe (S3) — confirm overlay shown (pre-connect state): ${s3pre.confirmShown}`);
  console.log(`Answer pre-confirm probe (S3) — no discovery POST to unconfirmed host: ${s3pre.noDiscoveryContact}`);
  s3pre.discoveryHits.forEach((u) => console.log('  - discovery POST at unconfirmed host:', u));
  console.log(`Answer pre-confirm probe (S3/S10) — no request of ANY kind to unconfirmed host: ${s3pre.noAnyContact}`);
  s3pre.allHits.forEach((u) => console.log('  - request at unconfirmed host:', u));

  const urlAct = await runUrlActionSchemeProbe(browser);
  console.log(`URL-action scheme probe (S13) — dispatcher installed: ${urlAct.dispatcherReady}`);
  // Belt-and-braces only — vacuous by construction (window.open is stubbed in the probe, so the
  // payload can never navigate). NOT a regression detector; the load-bearing assertion is the
  // "no non-http(s) URL reached window.open" line below, which is mutation-proven.
  console.log(`URL-action scheme probe (S13) — javascript: template did NOT execute: ${!urlAct.pwned}`);
  console.log(`URL-action scheme probe (S13) — no non-http(s) URL reached window.open: ${urlAct.hostileOpened.length === 0}`);
  urlAct.hostileOpened.forEach((u) => console.log('  - hostile window.open:', u));
  console.log(`URL-action scheme probe (S13) — plain https template still opens substituted URL: ${urlAct.goodOpened}`);
  urlAct.opened.forEach((u) => console.log('  - window.open:', u));
  urlAct.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const urlActOk = urlAct.dispatcherReady && !urlAct.pwned && urlAct.hostileOpened.length === 0
    && urlAct.goodOpened && urlAct.probeErrors.length === 0;

  const flagOv = await runFlagOverrideProbe(browser);
  console.log('');
  console.log(`Flag-override probe (S39) — sanitize strips a link's flags.<section>.liveboardId: ${flagOv.strippedByLink}`);
  console.log(`Flag-override probe (S29) — hostile flag planted past sanitize (positive control): ${flagOv.flagSurvived}`);
  console.log(`Flag-override probe (S29) — render uses the PICKED liveboardId: ${flagOv.renderUsesPicked}`);
  console.log(`Flag-override probe (S29) — generated snippet uses the PICKED liveboardId: ${flagOv.codeUsesPicked}`);
  console.log(`Flag-override probe (S29) — generated snippet never mentions the flag's id: ${flagOv.codeFreeOfAttacker}`);
  console.log(`Flag-override probe (S29) — a BENIGN flag is still emitted (filter is narrow): ${flagOv.codeKeepsBenignFlag}`);
  flagOv.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const flagOvOk = flagOv.strippedByLink && flagOv.flagSurvived && flagOv.benignFlagSurvived && flagOv.renderUsesPicked
    && flagOv.codeUsesPicked && flagOv.codeFreeOfAttacker && flagOv.codeKeepsBenignFlag
    && flagOv.probeErrors.length === 0;

  const dtp = await runDrillthroughProbe(browser);
  console.log('');
  console.log(`Drill-through probe (S22) — rail item + inspector panel render: ${dtp.railOk && dtp.panelOk}`);
  console.log(`Drill-through probe (S22) — code-gen emits '<modelGuid>::<column>' scoping + both handlers: ${dtp.codeOk}`);
  console.log(`Drill-through probe (S46) — snippet date helpers carry the live CFB_DATE_NAME_RE and the snippet parses: ${dtp.snippetOk}`);
  console.log(`Drill-through probe (S22) — clicked point scopes the searchdata query: ${dtp.scopedQuery}`);
  console.log(`Drill-through probe (S22) — a FULL page keeps Load more alive; offset advances and appends: ${dtp.pagingOk}`);
  console.log(`Drill-through probe (S22) — badge stays neutral ("N+") until the count is known, then reconciles: ${dtp.badgeOk}`);
  console.log(`Drill-through probe (S22) — {Column} link resolves; javascript: template refused: ${dtp.linkOk}`);
  console.log(`Drill-through probe (S22) — modal record list: title/period/summary, rows+chevrons, Esc closes: ${dtp.modalOk}`);
  console.log(`Drill-through probe (S22) — TABLE right-click (deselectedAttributes) scopes the query + badge; non-measure cell refused: ${dtp.tableClickOk}`);
  console.log(`Drill-through probe (S22) — a click from a DIFFERENT viz does not drill away: ${dtp.drillScopeOk}`);
  console.log(`Drill-through probe (S42) — preset saves, reapplies, folds, admits no foreign keys: ${dtp.presetOk}`);
  console.log(`Drill-through probe (S43) — naming visualizations adds and removes metadataIds.vizIds: ${dtp.pinOk}`);
  console.log(`Drill-through probe (S31) — a Month(...) click queries the WHOLE month, not just the 1st: ${dtp.monthRangeOk}`);
  console.log(`  query: ${dtp.monthQuery}`);
  console.log(`Drill-through probe (S32) — a slow first click's rows never land in the second click's panel: ${dtp.raceOk}`);
  console.log(`Drill-through probe (S30) — the drill carries NUMERIC epochs on the unwrapped column: ${dtp.carriedOk}`);
  console.log(`  carried: ${JSON.stringify(dtp.carried?.filters ?? [])}`);
  dtp.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const dtOk = dtp.railOk && dtp.panelOk && dtp.codeOk && dtp.snippetOk && dtp.scopedQuery && dtp.pagingOk
    && dtp.badgeOk && dtp.linkOk && dtp.modalOk && dtp.tableClickOk && dtp.drillScopeOk
    && dtp.monthRangeOk && dtp.raceOk && dtp.carriedOk && dtp.presetOk && dtp.pinOk
    && dtp.probeErrors.length === 0;

  const gen = await runCodeGenImportProbe(browser);
  console.log('');
  console.log(`Code-gen import probe (S29) — sections walked: ${gen.sections} (snippets with an SDK import: ${gen.checked})`);
  console.log(`Code-gen import probe (S29) — every SDK identifier used is also imported: ${gen.gaps.length === 0}`);
  gen.gaps.forEach((g) => console.log('  - missing import:', g));
  console.log(`Code-gen import probe (S29) — every embed section still emits SDK code: ${gen.unexpectedSkips.length === 0}`);
  gen.unexpectedSkips.forEach((id) => console.log('  - section emitted no SDK import:', id));
  gen.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const genOk = gen.checked > 0 && gen.gaps.length === 0 && gen.unexpectedSkips.length === 0
    && gen.probeErrors.length === 0;

  // S10 — one run per trusted auth mode; each is a distinct SDK authentication path.
  const exfilResults = [];
  for (const [authType, expectPath, testAuthChange] of [
    ['TrustedAuthTokenCookieless', '/callosum/v1/session/isactive', true],
    ['TrustedAuthToken', '/callosum/v1/session/login/token', false],
  ]) {
    exfilResults.push(await runPreauthExfilProbe(browser, authType, expectPath, testAuthChange));
  }
  let exfilOk = true;
  for (const r of exfilResults) {
    const tag = `Pre-confirm auth probe (S10, ${r.authType})`;
    console.log(`${tag} — confirm overlay shown (pre-confirm state): ${r.confirmShown}`);
    console.log(`${tag} — zero requests to the named host before Confirm: ${r.preConfirmHostHits.length === 0}`);
    r.preConfirmHostHits.forEach((u) => console.log('  - pre-confirm host request:', u));
    console.log(`${tag} — zero token mints before Confirm: ${r.preConfirmMintHits.length === 0}`);
    r.preConfirmMintHits.forEach((u) => console.log('  - pre-confirm mint:', u));
    console.log(`${tag} — #auth-select change exercised: ${r.authChangeTested && r.authChangeFired}`);
    console.log(`${tag} — #auth-select change while unconfirmed mints nothing: ${r.noMintOnAuthChange}`);
    console.log(`${tag} — #auth-select change while unconfirmed contacts nothing: ${r.noHostContactOnAuthChange}`);
    console.log(`${tag} — positive control: Confirm clicked: ${r.confirmClicked}`);
    console.log(`${tag} — positive control: token minted after Confirm: ${r.mintedAfterConfirm}`);
    console.log(`${tag} — positive control: host contacted after Confirm: ${r.contactedAfterConfirm}`);
    console.log(`${tag} — [diagnostic, not gated] expected SDK path ${r.expectPath} seen: ${r.expectedPathSeen}`);
    r.postConfirmHostHits.forEach((u) => console.log('  - post-confirm host request:', u));
    r.probeErrors.forEach((e) => console.log('  - probe page:', e));
    exfilOk = exfilOk && r.confirmShown && r.preConfirmHostHits.length === 0
      && r.preConfirmMintHits.length === 0 && r.noMintOnAuthChange && r.noHostContactOnAuthChange
      && (!r.authChangeTested || r.authChangeFired)
      && r.confirmClicked && r.mintedAfterConfirm && r.contactedAfterConfirm
      && r.probeErrors.length === 0;
  }


  // Ordered LAST of the state-writing probes: the paste probe persists styles, and the connect
  // probe persists a host — neither must be inherited by the persistence assertions above.
  const paste = await runStylePasteProbe(browser);
  console.log(`Style-paste probe (S37) — paste box reachable: ${paste.boxReady}`);
  console.log(`Style-paste probe (S37) — pasted expression did NOT execute: ${!paste.pwned}`);
  console.log(`Style-paste probe (S37) — hostile paste rejected (0 rules + parse error): ${paste.hostileRejected} (rows=${paste.hostileRows}, toast=${paste.hostileToast})`);
  console.log(`Style-paste probe (S37) — plain rules object still adds its rule: ${paste.goodAccepted} (rows=${paste.ruleCount})`);
  paste.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const pasteOk = paste.boxReady && !paste.pwned && paste.hostileRejected && paste.goodAccepted && paste.ruleCount === 1;

  const race = await runConnectRaceProbe(browser);
  console.log(`Connect-race probe (S33) — host B connected (positive control): ${race.bConnected}`);
  console.log(`Connect-race probe (S33) — final status is host B's: ${race.statusIsB} (“${race.finalStatus}”)`);
  console.log(`Connect-race probe (S33) — overlay not reset to not-connected/error: ${race.overlayOk} (${race.overlay || 'none'})`);
  console.log(`Connect-race probe (S33) — discovered objects are host B's: ${race.objectsAreB} (${JSON.stringify(race.worksheets)})`);
  race.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const raceOk = race.bConnected && race.statusIsB && race.overlayOk && race.objectsAreB;

  ok = resp.status() === 200 && shellMounted && errors.length === 0 && badResponses.length === 0
    && !xss.executed && xss.inChip && xss.inLog && hostOk && answerOk
    && s3pre.confirmShown && s3pre.noDiscoveryContact && s3pre.noAnyContact
    && urlActOk && dtOk && genOk && flagOvOk && exfilOk && pasteOk && raceOk;
  console.log(ok ? '\nBOOT CHECK: PASS' : '\nBOOT CHECK: FAIL');
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  clearTimeout(watchdog);
}
process.exit(ok ? 0 : 1);
