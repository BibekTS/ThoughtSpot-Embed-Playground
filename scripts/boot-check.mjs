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
 *   ✓ Pre-confirm auth probe (BACKLOG S10): a #s= hash naming a trusted-auth mode must mint NO
 *     token and contact the named host ZERO times before the user clicks Confirm
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
//     review) → POST /metadata/liveboard/data via Discovery.discoverViz
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

  ok = resp.status() === 200 && shellMounted && errors.length === 0 && badResponses.length === 0
    && !xss.executed && xss.inChip && xss.inLog && hostOk && answerOk
    && s3pre.confirmShown && s3pre.noDiscoveryContact && s3pre.noAnyContact
    && urlActOk && exfilOk;
  console.log(ok ? '\nBOOT CHECK: PASS' : '\nBOOT CHECK: FAIL');
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  server.kill('SIGTERM');
  clearTimeout(watchdog);
}
process.exit(ok ? 0 : 1);
