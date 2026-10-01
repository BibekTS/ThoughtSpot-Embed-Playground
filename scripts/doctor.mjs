/**
 * scripts/doctor.mjs — verify the Trusted Auth setup BEFORE you open the browser (`npm run doctor`).
 *
 * Reads .env, checks the required values, confirms the instance is reachable, and then actually
 * mints a short-lived token for the default user — the same call the playground makes — so you get
 * a clear ✓/✗ with the real upstream error instead of debugging it through the UI later.
 *
 * It never prints the secret. Minting a token does not create users (auto_create is not sent).
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { ok, bad, warn, fetchT, isTimeout } from './lib/cli.mjs';

const HOST = (process.env.THOUGHTSPOT_HOST || '').replace(/\/+$/, '');
const SECRET = process.env.TS_SECRET_KEY || '';
const USER = process.env.TS_DEFAULT_USERNAME || '';
const ALLOW = (process.env.TS_USERNAME_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);

console.log('\nTrusted Auth doctor\n');

let fatal = false;

// 1) .env present
if (!existsSync('.env')) {
  bad('No .env found. Run `npm run setup`, then fill in THOUGHTSPOT_HOST and TS_SECRET_KEY.');
  process.exit(1);
}
ok('.env found');

// 2) Required values
if (!HOST) { bad('THOUGHTSPOT_HOST is not set.'); fatal = true; }
else {
  try { const u = new URL(HOST); if (!/^https?:$/.test(u.protocol)) throw 0; ok(`Host looks valid: ${HOST}`); }
  catch { bad(`THOUGHTSPOT_HOST is not a valid http(s) URL: "${HOST}"`); fatal = true; }
}
if (!SECRET) { bad('TS_SECRET_KEY is not set (ThoughtSpot → Develop → Customizations → Security Settings → Trusted authentication).'); fatal = true; }
else ok('TS_SECRET_KEY is set (hidden)');

if (!USER) warn('TS_DEFAULT_USERNAME is empty — the UI will need a username typed in every time.');
else if (USER === 'tsadmin') warn("TS_DEFAULT_USERNAME is still the placeholder 'tsadmin' — set it to your ThoughtSpot username.");
else ok(`Default username: ${USER}`);
if (ALLOW.length && USER && !ALLOW.includes(USER)) warn(`Default user "${USER}" is not in TS_USERNAME_ALLOWLIST (${ALLOW.join(', ')}) — minting for it will 403. Leave the allowlist blank to auto-allow the default user.`);

if (fatal) { console.log('\nFix the ✗ items above, then re-run `npm run doctor`.\n'); process.exit(1); }

// 3) Reachability
const DOCTOR_MS = 10000;

try {
  await fetchT(`${HOST}/api/rest/2.0/auth/session/user`, { method: 'GET' }, DOCTOR_MS);
  ok('Instance is reachable');
} catch (e) {
  bad(`Could not reach ${HOST} — ${isTimeout(e) ? 'timed out' : e.message}. Check the URL / your network.`);
  process.exit(1);
}

// 4) The real test: mint a short-lived token (the same call the playground makes).
const mintUser = USER || 'tsadmin';
try {
  const resp = await fetchT(`${HOST}/api/rest/2.0/auth/token/full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: mintUser, secret_key: SECRET, validity_time_in_sec: 60 }),
  }, DOCTOR_MS);
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (resp.ok && json?.token) {
    ok(`Minted a token for "${json.valid_for_username || mintUser}" (len ${json.token.length}). Trusted Auth is working ✓`);
    console.log('\nAll set. Run `npm start`, choose "Trusted token", and Mint & apply.\n');
    process.exit(0);
  }
  bad(`Token mint failed (HTTP ${resp.status}).`);
  const pick = json?.error?.message ?? json?.error ?? json?.debug ?? json ?? text;
  const detail = (typeof pick === 'string' ? pick : JSON.stringify(pick)) || '(no detail)';
  console.log(`     upstream: ${detail.slice(0, 400)}`);
  if (resp.status === 401 || resp.status === 403 || /secret|invalid|unauthor/i.test(detail))
    console.log('     → most often a wrong/disabled TS_SECRET_KEY. Re-copy it from Security Settings → Trusted authentication.');
  if (/user/i.test(detail) && /not.*(found|exist)/i.test(detail))
    console.log(`     → user "${mintUser}" may not exist. Set TS_DEFAULT_USERNAME to a real user.`);
  process.exit(1);
} catch (e) {
  bad(`Token mint errored — ${isTimeout(e) ? 'timed out' : e.message}`);
  process.exit(1);
}
