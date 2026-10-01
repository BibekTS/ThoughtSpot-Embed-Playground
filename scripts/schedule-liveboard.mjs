/**
 * scripts/schedule-liveboard.mjs — create a Liveboard schedule with a chosen recipient mix, so you
 * can trigger a REAL webhook delivery and see what each recipient gets in the 🔔 Webhooks inbox.
 *
 * This creates the schedule via POST /api/rest/2.0/schedules/create. ThoughtSpot has no REST
 * "run now", so after creating it, open the Liveboard's schedule in ThoughtSpot and click
 * **Send now** to fire it immediately (or wait for the cadence).
 *
 * Usage:
 *   node scripts/schedule-liveboard.mjs --liveboard="Webhooks Testing" \
 *       --users=wmoy_test_2,wmoy_test_3 --groups=wmoy_test_2_group --emails=partner-a@ex.com,partner-b@ex.com
 *   node scripts/schedule-liveboard.mjs --liveboard=<GUID> --users=wmoy_test_2 --dry-run
 *
 * Recipients:
 *   --emails=a@x.com,b@y.com     external recipients (share one sender-context copy → one webhook)
 *   --users=name-or-guid,...     internal users   (each gets their own RLS copy → one webhook each)
 *   --groups=name-or-guid,...    groups           (expanded to per-user webhooks)
 *   --user-type / --group-type   principal type overrides (defaults USER / USER_GROUP)
 *
 * Auth (needs edit access to the Liveboard + rights to schedule for others):
 *   • pass --token=<bearer> or set TS_ADMIN_TOKEN, OR
 *   • let this mint one from TS_SECRET_KEY for --user / TS_DEFAULT_USERNAME.
 */

import 'dotenv/config';
import { ok, bad, warn, cliArgs, fetchT, isTimeout, resolveToken } from './lib/cli.mjs';

const HOST = (process.env.THOUGHTSPOT_HOST || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.TS_SECRET_KEY || '';

const args = cliArgs();
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const LIVEBOARD = args.liveboard || '';
const EMAILS = list(args.emails);
const USERS = list(args.users);
const GROUPS = list(args.groups);
const USER_TYPE = args['user-type'] || 'USER';
const GROUP_TYPE = args['group-type'] || 'USER_GROUP';
const NAME = args.name || 'Webhook demo schedule';
const DESCRIPTION = args.description || 'Created by schedule-liveboard.mjs to demo webhook recipient batching.';
const FORMAT = String(args.format || 'PDF').toUpperCase();
const TIME_ZONE = args['time-zone'] || 'Etc/UTC';
const HOUR = String(args.hour ?? '8');
const MINUTE = String(args.minute ?? '0'); // ThoughtSpot requires multiples of 5
const USER = args.user || process.env.TS_DEFAULT_USERNAME || '';
const DRY = !!args['dry-run'];

console.log('\nCreate a ThoughtSpot Liveboard schedule\n');

if (!HOST) { bad('THOUGHTSPOT_HOST is not set in .env.'); process.exit(1); }
if (!LIVEBOARD) { bad('Missing --liveboard=<GUID or name>.'); process.exit(1); }
if (!EMAILS.length && !USERS.length && !GROUPS.length) {
  bad('No recipients. Pass at least one of --emails / --users / --groups.'); process.exit(1);
}
if (!['PDF', 'CSV', 'XLSX'].includes(FORMAT)) { bad(`--format must be PDF, CSV, or XLSX (got ${FORMAT}).`); process.exit(1); }
if (Number(MINUTE) % 5 !== 0) warn(`--minute=${MINUTE} is not a multiple of 5; ThoughtSpot may reject the cadence (Send now still works).`);

const principals = [
  ...USERS.map((identifier) => ({ identifier, type: USER_TYPE })),
  ...GROUPS.map((identifier) => ({ identifier, type: GROUP_TYPE })),
];

// Whole-Liveboard daily schedule; you'll trigger it immediately with Send now in the UI.
const body = {
  name: NAME,
  description: DESCRIPTION,
  metadata_type: 'LIVEBOARD',
  metadata_identifier: LIVEBOARD,
  file_format: FORMAT,
  time_zone: TIME_ZONE,
  frequency: {
    cron_expression: { second: '0', minute: MINUTE, hour: HOUR, day_of_month: '*', month: '*', day_of_week: '?' },
  },
  recipient_details: {
    ...(EMAILS.length ? { emails: EMAILS } : {}),
    ...(principals.length ? { principals } : {}),
  },
};
// PDF attachments render empty unless pdf_options are set (per the schedules/create docs).
if (FORMAT === 'PDF') {
  body.pdf_options = { complete_liveboard: true, include_cover_page: true, include_page_number: true };
}

ok(`Host       : ${HOST}`);
ok(`Liveboard  : ${LIVEBOARD}`);
ok(`Recipients : ${EMAILS.length} external · ${USERS.length} user(s) · ${GROUPS.length} group(s)`);
ok(`Format     : ${FORMAT}  ·  cadence ${HOUR}:${MINUTE.padStart(2, '0')} ${TIME_ZONE} (trigger now with Send now)`);

if (DRY) {
  console.log('\n--dry-run — would POST /api/rest/2.0/schedules/create:\n');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  process.exit(0);
}

const SCHEDULE_MS = 20000;

try {
  const token = await resolveToken({
    host: HOST, secretKey: SECRET_KEY, user: USER, userHint: 'name', ms: SCHEDULE_MS,
    explicit: args.token || process.env.TS_ADMIN_TOKEN || '',
  });
  const resp = await fetchT(`${HOST}/api/rest/2.0/schedules/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }, SCHEDULE_MS);
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }

  if (!resp.ok) {
    bad(`schedules/create failed (HTTP ${resp.status}).`);
    console.log(`     upstream: ${(text || '').slice(0, 500)}`);
    if (resp.status === 401 || resp.status === 403) console.log('     → the token lacks edit access to the Liveboard or the "schedule for others" privilege.');
    if (/principal|type/i.test(text)) console.log(`     → if it complains about principal type, try --user-type / --group-type (some clusters use different values).`);
    process.exit(1);
  }

  const id = json?.id || '(id not in response)';
  ok(`Schedule created: ${id}`);
  console.log('\nNext — trigger it and watch the webhooks:');
  console.log('  1. Make sure the receiver is running (TS_ALLOW_WEBHOOK_SINK=true) and the webhook is registered (npm run register-webhook).');
  console.log('  2. In ThoughtSpot, open the Liveboard → Schedules → this schedule → click "Send now".');
  console.log('  3. Open the app → 🔔 Webhooks tab. One webhook per rendered report will arrive; open each recipient\'s file to see exactly what they got.\n');
  process.exit(0);
} catch (e) {
  bad(`Errored — ${isTimeout(e) ? 'timed out' : e.message}`);
  process.exit(1);
}
