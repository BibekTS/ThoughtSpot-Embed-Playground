/**
 * scripts/simulate-webhook.mjs — replay representative scheduled-Liveboard webhook deliveries into
 * the local receiver, so you can demo the recipient-batching behavior WITHOUT a live ThoughtSpot
 * schedule or an ngrok tunnel (Tier 2 of docs/webhook-inbox-demo.md).
 *
 * IMPORTANT: this data is SYNTHETIC. It reproduces the SHAPE of the batching (external batched into
 * one webhook, each internal user in its own, a group expanded into per-user webhooks, and an
 * RLS-blocked user that gets NO webhook). It does NOT exercise real RLS — only a live schedule does.
 *
 * It POSTs to the same endpoint ThoughtSpot would (server.js → POST /api/webhook). The sink must be
 * enabled (TS_ALLOW_WEBHOOK_SINK=true). If TS_WEBHOOK_SECRET is set, each delivery is HMAC-signed the
 * way ThoughtSpot signs, so the inbox shows ✓ verified.
 *
 * Usage:
 *   node scripts/simulate-webhook.mjs                       # POST the 4-scenario demo set
 *   node scripts/simulate-webhook.mjs --base=http://127.0.0.1:3000
 *   node scripts/simulate-webhook.mjs --recipients=1200     # stress the batched-external card (point #3)
 *   node scripts/simulate-webhook.mjs --dry-run             # print the payloads, send nothing
 *
 * Run `npm start` with TS_ALLOW_WEBHOOK_SINK=true first, then open the 🔔 Webhooks tab to watch them land.
 */

import 'dotenv/config';
import crypto from 'node:crypto';

const WEBHOOK_SECRET = process.env.TS_WEBHOOK_SECRET || '';
const SIG_HEADER = process.env.TS_WEBHOOK_SIG_HEADER || 'X-TS-Signature';

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

// ── args ────────────────────────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const BASE = String(args.base || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TARGET = args.url ? String(args.url) : `${BASE}/api/webhook`;
const DRY = !!args['dry-run'];
const STRESS = Math.max(0, parseInt(args.recipients, 10) || 0);   // optional external-recipient count
const MULTIPART = !!args.multipart;   // rehearse the REAL wire format: multipart + a rendered PDF attachment

// ── the recipient sets (mirror docs/webhook-inbox-demo.md + the customer's setup) ─────────────────
const T2 = 'u-wmoy-test-2', T3 = 'u-wmoy-test-3';
const GA = 'u-group-user-a', GB = 'u-group-user-b', GRP = 'g-wmoy-test-2-group';
const ext = (email, name) => ({ type: 'EXTERNAL_EMAIL', email, name });
const usr = (id, name) => ({ type: 'USER', id, name, email: `${name}@example.com` });

// Directly-named schedule users: wmoy_test_2 AND wmoy_test_3 (the group is added via groupIds).
// wmoy_test_3 is RLS-blocked → it never produces a delivery, so the inbox summary flags it.
const SCHEDULE_USER_IDS = [T2, T3];

// Shape matches the official LIVEBOARD_SCHEDULE payload (developers.thoughtspot.com/docs/webhooks-lb-payload).
// The instance host only decorates the synthetic payload's URLs — it is never called. Read it from
// the environment with NO default so no real instance hostname is baked into the repo.
const HOST = (process.env.THOUGHTSPOT_HOST || '').trim().replace(/\/+$/, '');
if (!HOST) {
  console.error('THOUGHTSPOT_HOST is required (e.g. THOUGHTSPOT_HOST=https://my-instance.thoughtspot.cloud node scripts/simulate-webhook.mjs)');
  process.exit(1);
}
const LB = 'lb-webhooks-testing';
function makeBody(recipients, note) {
  return {
    // eventId varies per POST so the receiver stores each as a distinct delivery.
    eventId: `sim-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    eventType: 'LIVEBOARD_SCHEDULE',
    schemaVersion: '1.0',
    source: { applicationName: 'ThoughtSpot', applicationUrl: HOST, orgId: '0' },
    actor: { actorType: 'SYSTEM' },
    metadataObject: { objectType: 'LIVEBOARD', id: LB, name: 'Webhooks Testing', url: `${HOST}/#/pinboard/${LB}` },
    data: {
      note,
      scheduleDetails: {
        scheduleId: 'sch-webhooks-testing', name: 'Webhooks Testing — daily',
        creationTime: new Date().toISOString(), description: 'Daily sales performance report',
        authorId: 'u-schedule-owner', userIds: SCHEDULE_USER_IDS, groupIds: [GRP],
        fileFormat: 'pdf', status: 'SUCCESS', emailIds: [],
      },
      recipients,
      channelType: 'webhook', communicationType: 'LiveboardSchedules',
    },
  };
}

const externalRecipients = STRESS > 0
  ? Array.from({ length: STRESS }, (_, i) => ext(`bulk-${i + 1}@example.com`, `Bulk recipient ${i + 1}`))
  : [ext('partner-a@example.com', 'Partner A'), ext('partner-b@example.com', 'Partner B')];

const scenarios = [
  { label: `external batch (${externalRecipients.length} recipients → 1 webhook)`,
    body: makeBody(externalRecipients, 'External recipients share the sender render → one batched webhook.') },
  { label: 'internal wmoy_test_2 (1 webhook)',
    body: makeBody([usr(T2, 'wmoy_test_2')], "Rendered in wmoy_test_2's own RLS context (sees only PRODUCT_CATEGORY != 'music player').") },
  { label: 'group member A (1 webhook)',
    body: makeBody([usr(GA, 'group_user_a')], 'A group of N expands into N per-user webhooks, not one batched webhook.') },
  { label: 'group member B (1 webhook)',
    body: makeBody([usr(GB, 'group_user_b')], 'A group of N expands into N per-user webhooks, not one batched webhook.') },
];

// A minimal but valid single-page PDF so the attachment opens in a browser (rehearsal only — the
// REAL report comes from ThoughtSpot). Byte offsets are ASCII, so char length == byte length.
function tinyPdf(text) {
  const esc = String(text).replace(/[()\\]/g, (c) => '\\' + c);
  const stream = `BT /F1 14 Tf 24 60 Td (${esc}) Tj ET`;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 380 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { pdf += `${String(off).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

function buildMultipart(boundary, meta, file) {
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="payload"${CRLF}Content-Type: application/json${CRLF}${CRLF}` +
    JSON.stringify(meta) + CRLF +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.filename}"${CRLF}Content-Type: ${file.contentType}${CRLF}${CRLF}`,
    'utf8',
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
  return Buffer.concat([head, file.data, tail]);
}

console.log(`\nSimulate ThoughtSpot scheduled-Liveboard webhooks (SYNTHETIC — no real RLS)${MULTIPART ? ' — multipart + PDF' : ''}\n`);
ok(`Receiver : ${TARGET}`);
ok(`Delivery : ${MULTIPART ? 'multipart/form-data with a rendered PDF attachment (mirrors the real wire format)' : 'application/json (metadata only — add --multipart to attach a report)'}`);
ok(`Signing  : ${WEBHOOK_SECRET ? `HMAC_SHA256 via ${SIG_HEADER}` : 'none (set TS_WEBHOOK_SECRET to get ✓ verified cards)'}`);
console.log(`  ! wmoy_test_3 is RLS-blocked (sees no data) → ThoughtSpot sends NO webhook for it, so this`);
console.log(`    script sends none either. It IS in scheduleDetails.userIds, so the inbox summary will`);
console.log(`    show "1 scheduled user received NO webhook". That absence is the whole point of #4.\n`);

if (DRY) {
  scenarios.forEach((s) => {
    console.log(`--dry-run — ${s.label}:`);
    console.log(JSON.stringify(s.body, null, 2));
    console.log('');
  });
  process.exit(0);
}

const fetchT = (url, opts = {}, ms = 15000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
};

async function post(scenario) {
  // Sign over the EXACT bytes we send — the server verifies against the raw body, so re-serializing
  // differently would break verification.
  let raw, contentType;
  if (MULTIPART) {
    const boundary = `----playgroundBoundary${scenario.body.eventId}`;
    const who = (scenario.body.data.recipients || []).map((r) => r.name || r.email).join(', ');
    const pdf = tinyPdf(`Webhooks Testing — copy for: ${who}`);
    raw = buildMultipart(boundary, scenario.body, { filename: 'Webhooks Testing.pdf', contentType: 'application/pdf', data: pdf });
    contentType = `multipart/form-data; boundary=${boundary}`;
  } else {
    raw = Buffer.from(JSON.stringify(scenario.body));
    contentType = 'application/json';
  }
  const headers = { 'Content-Type': contentType, Accept: 'application/json' };
  if (WEBHOOK_SECRET) {
    headers[SIG_HEADER] = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  }
  const res = await fetchT(TARGET, { method: 'POST', headers, body: raw });
  const text = await res.text().catch(() => '');
  if (res.status === 403) {
    bad(`${scenario.label} → 403 (sink disabled).`);
    console.log('     → restart the server with TS_ALLOW_WEBHOOK_SINK=true (e.g. `TS_ALLOW_WEBHOOK_SINK=true npm start`).');
    return false;
  }
  if (!res.ok) { bad(`${scenario.label} → HTTP ${res.status}: ${(text || '').slice(0, 200)}`); return false; }
  let verified = null, files = 0;
  try { const j = JSON.parse(text); verified = j?.verified; files = j?.files || 0; } catch { /* ignore */ }
  ok(`${scenario.label}${verified === true ? ' — ✓ verified' : verified === false ? ' — ⚠ unverified' : ''}${files ? ` · ${files} file` : ''}`);
  return true;
}

try {
  let sent = 0;
  for (const s of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const good = await post(s);
    if (!good && s === scenarios[0]) process.exit(1);   // first 403/failure → stop early
    if (good) sent++;
  }
  console.log(`\n  ${sent}/${scenarios.length} deliveries sent. Open the app → 🔔 Webhooks tab to see the batching summary.`);
  console.log('  (Hit Clear between runs — the receiver keeps only the last 50 deliveries.)\n');
  process.exit(0);
} catch (e) {
  if (e.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(e.message))) {
    bad(`Could not reach ${TARGET} — is the server running? Try \`TS_ALLOW_WEBHOOK_SINK=true npm start\`.`);
  } else {
    bad(`Errored — ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  }
  process.exit(1);
}
