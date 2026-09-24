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
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 34917; // unlikely to collide with a dev server on 3000/5500
const BASE = `http://127.0.0.1:${PORT}`;

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

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/auth/config`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

const server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErr = '';
server.stderr.on('data', d => { serverErr += d.toString(); });

try {
  const ready = await waitForReady();
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
  {
    // searchdata (drill-through detail rows) is allowlisted for the relay but, like every other
    // relayed path, must carry the caller's OWN token — so RLS is enforced upstream, not bypassed.
    const r = await postJson('/api/ts-rest', { path: '/api/rest/2.0/searchdata', method: 'POST', body: { query_string: '[x]' } });
    check('ts-rest searchdata without a token → 401', r.status === 401, `status ${r.status}`);
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
} finally {
  server.kill('SIGTERM');
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) { console.error(`FAILED: ${failed.map(f => f.name).join('; ')}`); process.exit(1); }
console.log('Smoke test passed.');
process.exit(0);
