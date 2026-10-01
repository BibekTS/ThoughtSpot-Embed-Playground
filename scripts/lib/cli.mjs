/**
 * scripts/lib/cli.mjs — the small helpers the ops scripts (doctor, register-webhook,
 * schedule-liveboard, simulate-webhook) used to copy-paste.
 *
 * It reads no environment at import time: each script keeps `import 'dotenv/config'` as its first
 * import and passes the values it resolved into these helpers.
 */

import { parseArgs } from 'node:util';

export const ok = (m) => console.log(`  ✓ ${m}`);
export const bad = (m) => console.log(`  ✗ ${m}`);
export const warn = (m) => console.log(`  ! ${m}`);

// `--k=v` → 'v', bare `--k` → true, last repeat wins — the same as the old hand-rolled regex parser.
// No options are declared and strict is off, so unknown flags are tolerated and `--k v` stays
// `k: true` (the value is NOT consumed — the scripts document the `--k=v` spelling).
export const cliArgs = () => parseArgs({ args: process.argv.slice(2), strict: false, allowPositionals: true }).values;

// fetch with a timeout. A timed-out request rejects with a 'TimeoutError' (AbortSignal.timeout),
// not the 'AbortError' a manual AbortController produced — use isTimeout() rather than e.name.
export const fetchT = (url, opts = {}, ms = 15000) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
export const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

// Resolve a bearer token: an explicit one (--token / TS_ADMIN_TOKEN), else mint a 300s token from
// the trusted-auth secret for `user`. Exits the process with a ✗ line when neither is possible.
export async function resolveToken({ host, secretKey, user, explicit, userHint, ms }) {
  if (explicit) { ok('Using provided bearer token'); return explicit; }
  if (!secretKey) { bad('No --token / TS_ADMIN_TOKEN, and TS_SECRET_KEY is unset — cannot obtain a token.'); process.exit(1); }
  if (!user) { bad(`Minting a token needs a user — pass --user=<${userHint}> or set TS_DEFAULT_USERNAME.`); process.exit(1); }
  const resp = await fetchT(`${host}/api/rest/2.0/auth/token/full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: user, secret_key: secretKey, validity_time_in_sec: 300 }),
  }, ms);
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok || !json?.token) {
    bad(`Could not mint a token for "${user}" (HTTP ${resp.status}). Pass an admin --token instead.`);
    console.log(`     upstream: ${(text || '').slice(0, 300)}`);
    process.exit(1);
  }
  ok(`Minted a short-lived token for "${user}"`);
  return json.token;
}
