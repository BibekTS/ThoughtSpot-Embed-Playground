/**
 * scripts/smoke-test.mjs — boots the real server and asserts the security-relevant behaviour.
 *
 * No browser, no ThoughtSpot instance needed: every check here is about THIS server's contract —
 * the gates that the README and code comments promise. Run with `npm test`.
 *
 *   ✓ /api/auth/config serves non-sensitive bootstrap (never the secret)
 *   ✓ source / docs are NOT statically served (only the frontend assets are)
 *   ✓ the frontend assets ARE served
 *   ✓ JIT (auto_create) is refused unless TS_ALLOW_JIT=true
 *   ✓ minting into a non-allowlisted group is refused
 *   ✓ the filter-values proxy refuses callers with no bearer token (never mints an admin one)
 *   ✓ the ts-rest relay rejects non-allowlisted paths and tokenless callers (never mints)
 *   ✓ the write-back stub is refused unless TS_ALLOW_DEV_PROXY=true
 *   ✓ the webhook receiver is refused unless TS_ALLOW_WEBHOOK_SINK=true
 *   ✓ the Spotter MCP relay refuses tokenless callers (it forwards yours, never mints)
 *   ✓ a non-allowlisted username is refused, with or without auto_create
 *   ✓ an EMPTY username allowlist fails CLOSED (refuses every mint)
 *   ✓ the rate limiter can't be walked past with a rotating X-Forwarded-For
 *   ✓ a foreign Host header is refused everywhere except the /api/webhook receiver
 *   ✓ the ts-rest relay refuses verbs other than GET/POST
 *   ✓ webhook attachments are served as a nosniff download, never as the sender's text/html
 *   ✓ retained webhook attachment bytes stay inside TS_WEBHOOK_MAX_BYTES
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 34917; // unlikely to collide with a dev server on 3000/5500
const BASE = `http://127.0.0.1:${PORT}`;
const PORT_EMPTY_ALLOWLIST = 34918; // server B — boots with no allowlist at all
const PORT_WEBHOOK = 34919;         // server C — boots with the webhook sink enabled

// Force a clean, fail-closed env regardless of the developer's .env (dotenv won't override these).
const env = {
  ...process.env,
  PORT: String(PORT),
  THOUGHTSPOT_HOST: 'https://smoke-test.invalid',
  TS_SECRET_KEY: '',            // unset — the guards under test return BEFORE any mint
  TS_USERNAME_ALLOWLIST: 'tsadmin',
  TS_ALLOW_JIT: '',             // fail-closed
  TS_GROUP_ALLOWLIST: '',       // fail-closed
  TS_ALLOW_DEV_PROXY: '',       // fail-closed
  TS_ALLOW_WEBHOOK_SINK: '',    // fail-closed
};

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

// 0) SDK pin single-source-of-truth: ts-sdk-version.json must equal the version in js/embed.js.
//    ts-watch bumps both together; divergence means a self-hosted vendor copy could mismatch the
//    runtime import. Pure file check — no server needed. Matches the unpkg URL or, when the import
//    was switched to the self-hosted /vendor/ path, the `// TS-SDK-VERSION: x.y.z` marker line.
//    Wrapped so a missing/malformed file reports a clean ✗ instead of crashing before the summary.
{
  try {
    const pin = JSON.parse(readFileSync(path.join(ROOT, 'ts-sdk-version.json'), 'utf8')).version;
    const embed = readFileSync(path.join(ROOT, 'js/embed.js'), 'utf8');
    const m = embed.match(/visual-embed-sdk@(\d+\.\d+\.\d+)/) || embed.match(/TS-SDK-VERSION:\s*(\d+\.\d+\.\d+)/);
    check('SDK pin consistent: ts-sdk-version.json === js/embed.js', !!m && m[1] === pin, `json=${pin} embed=${m ? m[1] : 'not found'}`);
  } catch (e) {
    check('SDK pin consistent: ts-sdk-version.json === js/embed.js', false, e.message);
  }
}

async function waitForReady(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/auth/config`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/**
 * A raw node:http request. `fetch` (undici) silently DROPS a caller-supplied Host header, so the
 * Host-allowlist checks below can't be written with it — they'd test nothing.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
function rawRequest({ port, method = 'GET', path: p = '/', headers = {}, body }) {
  const buf = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(buf ?? undefined);
  });
}

// Some guards are decided at BOOT from the environment (an empty allowlist, the webhook sink, the
// attachment byte budget), so they need their own server instance with its own env + port.
const spawned = [];
async function bootServer(port, overrides = {}) {
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT, env: { ...env, PORT: String(port), ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  proc.stderr.on('data', d => { err += d.toString(); });
  spawned.push(proc);
  const ready = await waitForReady(base);
  return { base, ready, err: () => err, kill: () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } } };
}

const server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', d => { serverErr += d.toString(); });
spawned.push(server);

try {
  const ready = await waitForReady(BASE);
  if (!ready) {
    console.error('Server did not become ready.\n' + serverErr);
    process.exit(1);
  }

  // 1) Bootstrap config — present, and the secret is never echoed.
  {
    const r = await fetch(`${BASE}/api/auth/config`);
    const j = await r.json();
    check('GET /api/auth/config → 200', r.status === 200, `status ${r.status}`);
    check('config exposes secretConfigured boolean', typeof j.secretConfigured === 'boolean');
    check('config never contains a secret key', !('secret_key' in j) && !('TS_SECRET_KEY' in j));
    check('JIT reported disabled by default', j.allowJit === false, `allowJit=${j.allowJit}`);
  }

  // 2) Static serving is restricted to the frontend — source/docs must NOT be reachable.
  for (const p of ['/server.js', '/package.json', '/INSTRUCTIONS.md', '/.env', '/misc/legacy/server.js']) {
    const r = await fetch(`${BASE}${p}`);
    check(`source/doc not served: ${p}`, r.status === 404, `status ${r.status}`);
  }

  // 3) Frontend assets ARE served.
  for (const p of ['/', '/index.html', '/js/app.js', '/css/styles.css', '/config.js']) {
    const r = await fetch(`${BASE}${p}`);
    check(`asset served: ${p}`, r.status === 200, `status ${r.status}`);
  }

  const postJson = (p, body, headers = {}) => fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  // 4) JIT bypass is closed by default.
  {
    const r = await postJson('/api/auth/token', { username: 'brand-new-user', autoCreate: true });
    check('JIT (auto_create) refused when disabled → 403', r.status === 403, `status ${r.status}`);
  }

  // 5) Group escalation is closed by default.
  {
    const r = await postJson('/api/auth/token', { username: 'tsadmin', groups: ['Administrator'] });
    check('non-allowlisted group refused → 403', r.status === 403, `status ${r.status}`);
  }

  // 5b) Custom (ABAC) token validation runs before any mint — no secret required.
  {
    const r = await postJson('/api/auth/token', { tokenType: 'custom', username: 'tsadmin', persistOption: 'BOGUS' });
    check('custom: invalid persist_option → 400', r.status === 400, `status ${r.status}`);
  }
  {
    const r = await postJson('/api/auth/token', {
      tokenType: 'custom', username: 'tsadmin', persistOption: 'NONE',
      variableValues: [{ name: 'region_var', values: ['NA'] }],
    });
    check('custom: NONE + variable_values rejected → 400', r.status === 400, `status ${r.status}`);
  }

  // 6) The filter-values proxy refuses tokenless callers (no admin minting).
  {
    const r = await postJson('/api/filter-values', { liveboardId: 'abc' });
    check('filter-values without a token → 401', r.status === 401, `status ${r.status}`);
  }

  // 6b) The /api/ts-rest relay (Personal liveboards) is allowlist-guarded and never mints.
  {
    // Non-allowlisted path is rejected before any token is even considered.
    const r = await postJson('/api/ts-rest', { path: '/api/rest/2.0/metadata/delete-all', method: 'POST', body: {} });
    check('ts-rest non-allowlisted path → 400', r.status === 400, `status ${r.status}`);
  }
  {
    // An allowlisted path still requires the CALLER'S own bearer token — the relay never mints one.
    const r = await postJson('/api/ts-rest', { path: '/api/rest/2.0/metadata/copyobject', method: 'POST', body: { identifier: 'abc' } });
    check('ts-rest allowlisted path without a token → 401', r.status === 401, `status ${r.status}`);
  }

  // 7) The write-back stub is opt-in.
  {
    const r = await postJson('/api/writeback', { hello: 'world' });
    check('write-back stub refused when disabled → 403', r.status === 403, `status ${r.status}`);
  }

  // 8) The webhook receiver is opt-in too — it must never accept data when the sink is disabled.
  {
    const r = await postJson('/api/webhook', { data: { notificationType: 'TEST' } });
    check('webhook sink refused when disabled → 403', r.status === 403, `status ${r.status}`);
  }

  // 9) The Spotter MCP relay forwards the CALLER'S bearer and never mints — so with no
  //    Authorization header it must refuse outright, exactly like /api/filter-values.
  {
    const r = await postJson('/api/spotter-mcp/chat', { question: 'hi' });
    check('spotter-mcp chat without a token → 401', r.status === 401, `status ${r.status}`);
    const h = await fetch(`${BASE}/api/spotter-mcp/health`);
    check('spotter-mcp health without a token → 401', h.status === 401, `status ${h.status}`);
  }

  // 10) The username allowlist actually excludes. TS_USERNAME_ALLOWLIST is 'tsadmin' here, so a
  //     different EXISTING username must be refused — and auto_create is not a way around it
  //     (TS_ALLOW_JIT governs CREATION; that path is exercised on server C below).
  {
    const r = await postJson('/api/auth/token', { username: 'someone-else' });
    check('non-allowlisted username → 403', r.status === 403, `status ${r.status}`);
  }

  // 11) The ts-rest relay only ever needs GET/POST — any other verb is the caller picking an
  //     upstream method we never intended to forward.
  {
    const r = await postJson('/api/ts-rest', { path: '/api/rest/2.0/metadata/delete', method: 'DELETE', body: {} });
    check('ts-rest non-GET/POST method → 400', r.status === 400, `status ${r.status}`);
  }

  // 12) Host allowlist — the server binds to loopback, but a tunnel or a DNS-rebinding page can
  //     still present a foreign Host. Everything but the webhook receiver must refuse it.
  {
    const r = await rawRequest({
      port: PORT, method: 'POST', path: '/api/auth/token',
      headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tsadmin' }),
    });
    check('foreign Host on /api/auth/token → 4xx', r.status >= 400 && r.status < 500, `status ${r.status}`);
    const c = await rawRequest({ port: PORT, path: '/api/auth/config', headers: { Host: 'evil.example.com' } });
    check('foreign Host on /api/auth/config → 4xx', c.status >= 400 && c.status < 500, `status ${c.status}`);
  }

  // 13) Rate limiter — `trust proxy` must NOT default to true, or a rotating X-Forwarded-For makes
  //     every request look like a new client and the limiter never fires. Run this LAST on this
  //     server: it deliberately exhausts the mint window.
  {
    const max = 60; // /api/auth/token window ceiling in server.js
    let seen429 = 0;
    for (let i = 0; i <= max + 10; i += 1) {
      const r = await fetch(`${BASE}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${(i >> 8) & 255}.${i & 255}` },
        body: JSON.stringify({ username: 'not-allowlisted' }),
      });
      if (r.status === 429) seen429 += 1;
    }
    check('rate limiter not bypassable via rotating X-Forwarded-For', seen429 > 0, `${seen429} × 429 in ${max + 11} requests`);
  }
} finally {
  server.kill('SIGTERM');
}

// ── Server B: both TS_USERNAME_ALLOWLIST and TS_DEFAULT_USERNAME blank ────────────────────────
// This used to fail OPEN — the guard was skipped when the set was empty, so ANY username minted.
{
  const b = await bootServer(PORT_EMPTY_ALLOWLIST, { TS_USERNAME_ALLOWLIST: '', TS_DEFAULT_USERNAME: '' });
  try {
    check('server boots with an empty allowlist', b.ready, b.ready ? '' : b.err());
    if (b.ready) {
      const r = await fetch(`${b.base}/api/auth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'anyone-at-all' }),
      });
      check('empty allowlist refuses every mint → 403', r.status === 403, `status ${r.status}`);
      const cfg = await (await fetch(`${b.base}/api/auth/config`)).json();
      check('config reports the empty allowlist', cfg.allowlistEmpty === true, `allowlistEmpty=${cfg.allowlistEmpty}`);
    }
  } finally { b.kill(); } // a throw here must not leave the child listening — the next run would EADDRINUSE
}

// ── Server C: webhook sink ON, tiny attachment budget ─────────────────────────────────────────
{
  const BUDGET = 64 * 1024; // bytes retained across ALL attachments
  const c = await bootServer(PORT_WEBHOOK, {
    TS_ALLOW_WEBHOOK_SINK: 'true',
    TS_ALLOW_JIT: 'true',
    TS_USERNAME_ALLOWLIST: 'tsadmin',
    TS_WEBHOOK_MAX_BYTES: String(BUDGET),
  });
  try {
  check('server boots with the webhook sink enabled', c.ready, c.ready ? '' : c.err());

  if (c.ready) {
    // JIT is ENABLED here — and it still must not mint for a user outside the allowlist.
    {
      const r = await fetch(`${c.base}/api/auth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'jit-stranger', autoCreate: true }),
      });
      check('auto_create does NOT bypass the allowlist (TS_ALLOW_JIT=true) → 403', r.status === 403, `status ${r.status}`);
    }

    /** POST one multipart delivery carrying a single attachment part. */
    const postAttachment = (contentType, filename, bodyBytes, host) => {
      const boundary = '----smokeboundary' + Math.random().toString(36).slice(2);
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="data"\r\n\r\n{"data":{"notificationType":"TEST"}}\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + `Content-Type: ${contentType}\r\n\r\n`, 'utf8');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      return rawRequest({
        port: PORT_WEBHOOK, method: 'POST', path: '/api/webhook',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...(host ? { Host: host } : {}) },
        body: Buffer.concat([head, Buffer.from(bodyBytes), tail]),
      });
    };

    // The receiver is the ONE route exempt from the Host allowlist — a tunnel presents its own Host.
    {
      const r = await postAttachment('text/html', 'evil.html', '<script>alert(document.domain)</script>', 'tunnel.example.com');
      check('/api/webhook accepts a foreign Host (tunnel) → 200', r.status === 200, `status ${r.status}`);
    }

    // S25: a text/html attachment must never come back as renderable HTML on this origin — this
    // origin also mints trusted-auth tokens, so that would be stored XSS against the mint endpoint.
    {
      const ev = await (await fetch(`${c.base}/api/webhook/events`)).json();
      const href = ev.events?.[0]?.files?.[0]?.href;
      check('webhook delivery recorded an attachment', !!href, href || 'no href');
      if (href) {
        const f = await fetch(`${c.base}${href}`);
        const ct = String(f.headers.get('content-type') || '');
        const cd = String(f.headers.get('content-disposition') || '');
        check('attachment not served as text/html', f.status === 200 && !/text\/html/i.test(ct), `content-type ${ct}`);
        check('attachment served as a download, not inline', /^attachment/i.test(cd), `content-disposition ${cd}`);
        check('attachment carries X-Content-Type-Options: nosniff',
          String(f.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
          `nosniff ${f.headers.get('x-content-type-options')}`);
      }
    }

    /** Sum the bytes still downloadable across every event in the inbox, plus how many files live. */
    const liveAttachments = async () => {
      const ev = await (await fetch(`${c.base}/api/webhook/events`)).json();
      let bytes = 0; let live = 0; const ids = new Set(); let dupes = 0;
      for (const e of ev.events || []) {
        if (ids.has(e.id)) dupes += 1; else ids.add(e.id);
        for (const f of e.files || []) {
          const r = await fetch(`${c.base}${f.href}`);
          if (r.status === 200) { bytes += (await r.arrayBuffer()).byteLength; live += 1; }
        }
      }
      return { bytes, live, dupes, events: (ev.events || []).length };
    };

    // S28: retained attachment bytes stay inside TS_WEBHOOK_MAX_BYTES, however many deliveries
    // arrive. Send enough to blow past the budget several times over, then add up what is STILL
    // downloadable — a count-only ring buffer would keep all of it.
    {
      const chunk = Buffer.alloc(24 * 1024, 0x41); // 24 KB each, 8 of them = 192 KB > 64 KB budget
      for (let i = 0; i < 8; i += 1) await postAttachment('application/pdf', `report-${i}.pdf`, chunk);
      const a = await liveAttachments();
      check('retained webhook attachment bytes stay within the budget',
        a.bytes > 0 && a.bytes <= BUDGET, `${a.bytes} bytes retained, budget ${BUDGET}`);
    }

    // S28 regression guard: SATURATE the 50-event ring. `recId` used to be
    // `whk-${Date.now()}-${webhookEvents.length}`, and `length` pins at the ring max once full — so
    // same-millisecond deliveries reused an id, the byte counter charged for both copies but was
    // credited back only once, and the drift eventually evicted EVERY attachment forever (every
    // download 404ing "it may have aged out" until restart). Retention must still work after the
    // ring has turned over several times, and ids must stay unique.
    {
      const chunk = Buffer.alloc(8 * 1024, 0x42);
      for (let i = 0; i < 120; i += 1) await postAttachment('application/pdf', `sat-${i}.pdf`, chunk);
      const a = await liveAttachments();
      check('event ids stay unique after the ring saturates', a.dupes === 0, `${a.dupes} duplicate id(s) in ${a.events} events`);
      check('attachments are still retained after the ring saturates', a.live > 0, `${a.live} live file(s), ${a.bytes} bytes`);
      check('retained bytes still within the budget after saturation',
        a.bytes > 0 && a.bytes <= BUDGET, `${a.bytes} bytes retained, budget ${BUDGET}`);
    }
  }
  } finally { c.kill(); } // never leave the child listening — a throw here would EADDRINUSE the next run
}

spawned.forEach(p => { try { p.kill('SIGTERM'); } catch { /* already gone */ } });

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) { console.error(`FAILED: ${failed.map(f => f.name).join('; ')}`); process.exit(1); }
console.log('Smoke test passed.');
process.exit(0);
