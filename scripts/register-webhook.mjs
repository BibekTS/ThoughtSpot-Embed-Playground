/**
 * scripts/register-webhook.mjs — register the demo webhook on your ThoughtSpot instance.
 *
 * The Webhook Inbox (bottom panel → 🔔 Webhooks) shows deliveries that ThoughtSpot POSTs to the
 * local receiver (server.js → POST /api/webhook). For ThoughtSpot cloud to reach your laptop you
 * expose the receiver with a tunnel (e.g. `ngrok http 3000`) and register that public URL here.
 *
 * Usage:
 *   node scripts/register-webhook.mjs --url=https://<your-ngrok>.ngrok-free.app/api/webhook
 *   node scripts/register-webhook.mjs --url=... --event=LIVEBOARD_SCHEDULE --name="Playground demo"
 *   node scripts/register-webhook.mjs --url=... --dry-run           # print the request body, send nothing
 *
 * Auth (need a bearer token that can create webhooks — an admin):
 *   • pass  --token=<bearer>  or set  TS_ADMIN_TOKEN, OR
 *   • let this script mint one from TS_SECRET_KEY for  --user / TS_DEFAULT_USERNAME  (that user must
 *     have privileges to create webhooks).
 *
 * Signature: if TS_WEBHOOK_SECRET is set, the webhook is registered with HMAC_SHA256 signing so the
 * receiver can verify each delivery. Keep the SAME secret in the server's .env.
 *
 * This never prints the secret or the token.
 */

import 'dotenv/config';
import { ok, bad, warn, cliArgs, fetchT, isTimeout, resolveToken } from './lib/cli.mjs';

const HOST = (process.env.THOUGHTSPOT_HOST || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.TS_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.TS_WEBHOOK_SECRET || '';
const SIG_HEADER = process.env.TS_WEBHOOK_SIG_HEADER || 'X-TS-Signature';

// ── args ──────────────────────────────────────────────────────────────────────────────────────
const args = cliArgs();
const URL_TARGET = args.url || '';
const EVENT = args.event || 'LIVEBOARD_SCHEDULE';
const NAME = args.name || 'Embed Playground demo';
const USER = args.user || process.env.TS_DEFAULT_USERNAME || '';
const DRY = !!args['dry-run'];

console.log('\nRegister ThoughtSpot webhook\n');

if (!HOST) { bad('THOUGHTSPOT_HOST is not set in .env.'); process.exit(1); }
if (!URL_TARGET) {
  bad('Missing --url. Pass your public receiver URL, e.g. --url=https://<ngrok>.ngrok-free.app/api/webhook');
  process.exit(1);
}
try { const u = new URL(URL_TARGET); if (!/^https?:$/.test(u.protocol)) throw 0; } catch {
  bad(`--url is not a valid http(s) URL: "${URL_TARGET}"`); process.exit(1);
}
if (!/^https:\/\//i.test(URL_TARGET)) warn('Receiver URL is not https — ThoughtSpot cloud usually requires a public https endpoint (ngrok gives you one).');
ok(`Host        : ${HOST}`);
ok(`Receiver    : ${URL_TARGET}`);
ok(`Event       : ${EVENT}`);
ok(`Signing     : ${WEBHOOK_SECRET ? `HMAC_SHA256 via ${SIG_HEADER}` : 'none (set TS_WEBHOOK_SECRET to enable verification)'}`);

// ── build the create body (shape per docs: webhooks/create) ─────────────────────────────────────
const body = { name: NAME, description: 'Embed Playground demo receiver', url: URL_TARGET, events: [EVENT] };
if (WEBHOOK_SECRET) {
  // Per webhooks/create schema: type enum is HMAC_SHA256; algorithm enum is SHA256 (NOT HMAC_SHA256).
  body.signature_verification = { type: 'HMAC_SHA256', header: SIG_HEADER, algorithm: 'SHA256', secret: WEBHOOK_SECRET };
}

if (DRY) {
  const redacted = JSON.parse(JSON.stringify(body));
  if (redacted.signature_verification) redacted.signature_verification.secret = '***redacted***';
  console.log('\n--dry-run — would POST /api/rest/2.0/webhooks/create:\n');
  console.log(JSON.stringify(redacted, null, 2));
  console.log('');
  process.exit(0);
}

try {
  const token = await resolveToken({
    host: HOST, secretKey: SECRET_KEY, user: USER, userHint: 'admin',
    explicit: args.token || process.env.TS_ADMIN_TOKEN || '',
  });

  const resp = await fetchT(`${HOST}/api/rest/2.0/webhooks/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }

  if (!resp.ok) {
    bad(`webhooks/create failed (HTTP ${resp.status}).`);
    console.log(`     upstream: ${(text || '').slice(0, 500)}`);
    if (resp.status === 401 || resp.status === 403) console.log('     → the token cannot create webhooks. Use an admin token (--token=...).');
    if (/not found|unsupported|404/i.test(text) || resp.status === 404) console.log('     → this cluster/version may not expose the webhooks API yet. Check your ThoughtSpot version.');
    process.exit(1);
  }

  const id = json?.id || json?.identifier || json?.webhook_identifier || '(id not in response)';
  ok(`Webhook created: ${id}`);
  console.log('\nNext:');
  console.log('  1. Make sure the server has TS_ALLOW_WEBHOOK_SINK=true (and the SAME TS_WEBHOOK_SECRET) and is running.');
  console.log('  2. Open the app → bottom panel → 🔔 Webhooks tab (it starts polling the receiver).');
  console.log(`  3. Trigger the event: schedule the Liveboard (${EVENT}) or set a KPI Monitor alert that fires.`);
  console.log('     A delivery will appear in the inbox within a few seconds.\n');
  process.exit(0);
} catch (e) {
  bad(`Errored — ${isTimeout(e) ? 'timed out' : e.message}`);
  process.exit(1);
}
