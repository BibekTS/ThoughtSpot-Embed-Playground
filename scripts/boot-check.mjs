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
 *   ✓ no non-favicon 4xx/5xx responses (the /favicon.ico 404 on the restricted static
 *     server is pre-existing and allowed)
 *   ✓ XSS probe (BACKLOG S1): an <img onerror> payload in a #s=-hash group name renders as
 *     inert text in the auth chips and the Event Log — it must never execute
 *   ✓ URL-action scheme probe (BACKLOG S13): a `javascript:` urlTemplate from a #s= hash must be
 *     refused at window.open, while a plain https template still opens with placeholders resolved
 *   ✓ Drill-through probe (BACKLOG S22): the column-scoped action reaches the generated code as
 *     '<modelGuid>::<column>', a clicked point scopes the searchdata query, Load more advances
 *     record_offset, the KPI/row-count badge reconciles, and a javascript: link template is refused
 *
 * Chrome resolution: $CHROME_PATH, then the standard macOS / Linux install locations
 * (GitHub's ubuntu runners ship google-chrome). Requires devDependency puppeteer-core.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
const watchdog = setTimeout(() => {
  console.error('boot-check: watchdog timeout (120s) — treating as failure.');
  process.exit(1);
}, 120_000);

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
//   Leg 1 — open `#s={host:EVIL, worksheetId:MARKER}`. Assert the confirm overlay names EVIL
//           (positive control: the hash reached the app), the debounced persist wrote state with
//           host BLANKED but the MARKER kept (proves a write happened, so the guard is meaningful),
//           the status pill never reached connecting/connected, and NO request went to EVIL.
//   Leg 2 — open the bare URL (no hash). It inherits Leg 1's localStorage. Assert it reads that
//           storage (MARKER present → propagation confirmed) with host still '', shows the
//           "not-connected" overlay (NOT confirm-host), never connects, and never contacts EVIL.
// A regression that persists the hash host, or auto-connects to it, flips one of these to fail.
async function runHostConfirmProbe(browser) {
  const EVIL = 'https://evil.s2probe.example';
  const MARKER = 'ws_s2probe_marker';
  const KEY = 'tsp_state_v1';
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
  let confirmShown, p1Stored, p1Status;
  try {
    await p1.goto(`${BASE}/#s=${hash}`, { waitUntil: 'networkidle2', timeout: 30_000 });
    // Positive control: the hash host must surface as a pending confirmation naming EVIL.
    confirmShown = await p1.waitForFunction((evil) => {
      const active = document.querySelector('.st-confirm-host.active');
      const name = document.getElementById('confirm-host-name')?.textContent || '';
      return !!active && name.includes(evil);
    }, { polling: 300, timeout: 20_000 }, EVIL).then(() => true, () => false);
    await sleep(600); // let the 250ms debounced persist fire
    p1Stored = await p1.evaluate(readStored, KEY);
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
    p1HostBlanked: (p1Stored?.host ?? '') === '',
    p1MarkerKept: p1Stored?.worksheetId === MARKER,          // proves a persist actually happened
    p1ConnectSkipped: !CONNECT_STATES.includes(p1Status),
    // Leg 2 — plain revisit: not-connected, host still blank, no auto-connect
    notConnected,
    confirmAbsent,
    p2StoragePropagated: p2Stored?.worksheetId === MARKER,   // proves Leg 2 read Leg 1's storage
    p2HostBlanked: (p2Stored?.host ?? '') === '',
    p2ConnectSkipped: !CONNECT_STATES.includes(p2Status),
    // ── Diagnostic (NOT gated) ── the SDK's init() fires preauth warm-up GETs at the unconfirmed
    // host (e.g. /prism/preauth/info, /callosum/v1/session/info). That is outside S2's scope
    // (persistence + auto-connect); it is tracked as its own follow-up backlog item.
    sdkPreauthUrls: [...evilUrls1, ...evilUrls2],
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
// the auto-load condition (sectionObject, ~app.js:1118).
//
// Navigate to `#s={section:'viz', host:EVIL}`. The app boots into pendingHostConfirm (host set,
// NOT connected) and renders the Single-Viz inspector — so the auto-load condition
// (`connected && answerList === undefined`) is genuinely evaluated pre-connect. Assert the confirm
// overlay is up (positive control: we are in the pre-confirm state where the guard matters) AND that
// the app fired NO discovery POST at the unconfirmed host. Match ONLY the discovery path
// (/metadata/search); the SDK's own preauth GETs (/prism/preauth/info, /callosum/v1/session/info) at
// an unconfirmed host are a SEPARATE, pre-existing, backlog-tracked issue (S10) and WILL still fire
// here — conflating them would false-fail this probe. Runs on its own page like the other probes.
async function runAnswerPreconfirmProbe(browser) {
  const HOST = 'https://evil.s3probe.example';
  const hash = Buffer.from(
    JSON.stringify({ section: 'viz', host: HOST }), 'utf8'
  ).toString('base64url');
  const probe = await browser.newPage();
  // Record ONLY the app's own discovery POST (discoverAnswers → /metadata/search) at the evil host,
  // NOT the SDK preauth GETs — see the note above. Attached BEFORE goto so a boot-time fetch is caught.
  const discoveryHits = [];
  probe.on('request', (r) => {
    const u = r.url();
    if (u.startsWith(HOST) && u.includes('/metadata/search')) discoveryHits.push(u);
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
    await sleep(600); // let any (guarded-away) auto-load fetch initiate before we read the tally
    return { confirmShown, noDiscoveryContact: discoveryHits.length === 0, discoveryHits };
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
      && code.includes('CustomActionsPosition.CONTEXTMENU') && code.includes('CustomActionTarget.VIZ')
      && code.includes('EmbedEvent.VizPointClick') && code.includes('HostEvent.GetFilters')
      && code.includes('record_offset: offset');

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
              // The user right-clicked the QUOTA cell, so that is what ThoughtSpot reports as
              // selected — modelColumnNames scopes the action to the VIZ, not to one column, so this
              // is reachable in the real UI. The configured measureColumn must still win, otherwise
              // the modal is titled after a '{Null}' quota (observed on a real screenshot).
              selectedMeasures: [{ column: { name: 'Total Sales Amount Quota' }, value: '{Null}' }],
              deselectedMeasures: [
                { column: { name: 'Total Sales Amount' }, value: '134280.9824' },
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

      // Drill scoping: VizPointClick fires for EVERY viz on the board, so a click from a viz other
      // than the configured one must not drill away. Only the negative case is asserted here — the
      // positive case re-renders a real embed, which this stubbed page has no business doing.
      st.setState({ drill: { ...st.getState().drill, trigger: 'action', drillLiveboardId: 'lb-detail', drillVizId: 'viz-CHART' } });
      document.getElementById('dt-modal')?.remove();
      await window.__onVizPointClick({ data: { vizId: 'viz-TABLE', clickedPoint: { selectedAttributes: [{ column: { name: 'Stage' }, value: 'Prospecting' }] } } });
      await new Promise((r) => setTimeout(r, 200));
      const scoping = { otherVizDrilled: !!document.getElementById('drill-bar') };
      return { bodies, first, after, mismatchShown, guard, modal, scoping, tableClick };
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
      && /Employee Name: Lynn Tsoflias/.test(t.summary || '');
    const drillScopeOk = run.scoping.otherVizDrilled === false;
    return { railOk, panelOk, codeOk, scopedQuery, pagingOk, badgeOk, linkOk, modalOk, tableClickOk, drillScopeOk, probeErrors };
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

let ok = false;
let browser;
try {
  if (!(await waitForReady())) {
    console.error('boot-check: server did not become ready.\n' + serverErr);
    process.exit(1);
  }

  const errors = [];       // JS console errors (resource-load failures judged via responses)
  const badResponses = []; // non-favicon 4xx/5xx

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
    if (r.status() >= 400 && !/favicon\.ico/i.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`);
  });

  const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(1500); // let the ES modules run

  const shellMounted = await page.$('#embed-list, .rail-group, #inspector') !== null;

  console.log(`HTTP status: ${resp.status()}`);
  console.log(`tool shell mounted: ${shellMounted}`);
  console.log(`JS console/page errors: ${errors.length}`);
  errors.forEach((e) => console.log('  -', e));
  console.log(`non-favicon bad responses: ${badResponses.length}`);
  badResponses.forEach((e) => console.log('  -', e));

  const xss = await runXssProbe(browser);
  console.log(`XSS probe — payload executed: ${xss.executed}`);
  console.log(`XSS probe — rendered inert in auth group chips: ${xss.inChip}`);
  console.log(`XSS probe — rendered inert in event log: ${xss.inLog}`);
  xss.probeErrors.forEach((e) => console.log('  - probe page:', e));

  const host = await runHostConfirmProbe(browser);
  console.log(`Host-confirm probe (S2) — hash host shows confirm overlay: ${host.confirmShown}`);
  console.log(`Host-confirm probe (S2) — hash host blanked in localStorage: ${host.p1HostBlanked}`);
  console.log(`Host-confirm probe (S2) — non-host state still persisted (marker): ${host.p1MarkerKept}`);
  console.log(`Host-confirm probe (S2) — hash host not auto-connected: ${host.p1ConnectSkipped}`);
  console.log(`Host-confirm probe (S2) — plain revisit inherits storage (marker): ${host.p2StoragePropagated}`);
  console.log(`Host-confirm probe (S2) — plain revisit host still blank: ${host.p2HostBlanked}`);
  console.log(`Host-confirm probe (S2) — plain revisit shows not-connected: ${host.notConnected}`);
  console.log(`Host-confirm probe (S2) — plain revisit hides confirm overlay: ${host.confirmAbsent}`);
  console.log(`Host-confirm probe (S2) — plain revisit does not auto-connect: ${host.p2ConnectSkipped}`);
  console.log(`Host-confirm probe (S2) — [diagnostic, not gated] SDK init() preauth GETs at unconfirmed host: ${host.sdkPreauthUrls.length}`);
  host.sdkPreauthUrls.forEach((u) => console.log('  -', u));
  const hostOk = host.confirmShown && host.p1HostBlanked && host.p1MarkerKept && host.p1ConnectSkipped
    && host.notConnected && host.confirmAbsent && host.p2StoragePropagated && host.p2HostBlanked
    && host.p2ConnectSkipped;

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

  const dtp = await runDrillthroughProbe(browser);
  console.log('');
  console.log(`Drill-through probe (S22) — rail item + inspector panel render: ${dtp.railOk && dtp.panelOk}`);
  console.log(`Drill-through probe (S22) — code-gen emits '<modelGuid>::<column>' scoping + both handlers: ${dtp.codeOk}`);
  console.log(`Drill-through probe (S22) — clicked point scopes the searchdata query: ${dtp.scopedQuery}`);
  console.log(`Drill-through probe (S22) — a FULL page keeps Load more alive; offset advances and appends: ${dtp.pagingOk}`);
  console.log(`Drill-through probe (S22) — badge stays neutral ("N+") until the count is known, then reconciles: ${dtp.badgeOk}`);
  console.log(`Drill-through probe (S22) — {Column} link resolves; javascript: template refused: ${dtp.linkOk}`);
  console.log(`Drill-through probe (S22) — modal record list: title/period/summary, rows+chevrons, Esc closes: ${dtp.modalOk}`);
  console.log(`Drill-through probe (S22) — TABLE right-click (deselectedAttributes) scopes the query + badge: ${dtp.tableClickOk}`);
  console.log(`Drill-through probe (S22) — a click from a DIFFERENT viz does not drill away: ${dtp.drillScopeOk}`);
  dtp.probeErrors.forEach((e) => console.log('  - probe page:', e));
  const dtOk = dtp.railOk && dtp.panelOk && dtp.codeOk && dtp.scopedQuery && dtp.pagingOk
    && dtp.badgeOk && dtp.linkOk && dtp.modalOk && dtp.tableClickOk && dtp.drillScopeOk && dtp.probeErrors.length === 0;

  ok = resp.status() === 200 && shellMounted && errors.length === 0 && badResponses.length === 0
    && !xss.executed && xss.inChip && xss.inLog && hostOk && answerOk
    && s3pre.confirmShown && s3pre.noDiscoveryContact && urlActOk && dtOk;
  console.log(ok ? '\nBOOT CHECK: PASS' : '\nBOOT CHECK: FAIL');
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  clearTimeout(watchdog);
}
process.exit(ok ? 0 : 1);
