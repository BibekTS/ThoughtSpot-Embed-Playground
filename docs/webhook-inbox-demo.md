# Webhook Inbox — see what each recipient actually gets

Schedule a real Liveboard, trigger it, and watch one webhook arrive **per recipient** — then open each
recipient's report to see exactly what their row-level security produced. This is the concrete answer to
the customer's questions about webhook recipient batching.

The four things they saw, and why:

| What they saw | Why |
|---|---|
| External recipients batched into **one** webhook | External people have no ThoughtSpot login, so the report is built **once** with the schedule owner's access and shared. |
| Each internal user gets **their own** webhook | ThoughtSpot re-runs the Liveboard **as that user**, so their row-level security applies → a personal copy each. |
| A group becomes **per-user** webhooks | A group is just a list of users; each is built individually. |
| An RLS-blocked user gets **no** webhook | If their row-level security leaves them no data, nothing is built, so nothing is sent. |

---

## What happens when a schedule fires (plain version)

1. **You trigger it** — click **Send now** on the schedule (or wait for its time).
2. ThoughtSpot **builds the recipient list** — groups are expanded into individual users; ThoughtSpot users are separated from plain email addresses.
3. It **renders the report once per distinct view:**
   - one per **internal user**, run *as that user* (their row-level security) → a personal PDF/CSV;
   - one for **all external emails**, built with the schedule owner's access;
   - **nothing** for a user whose row-level security yields no data.
4. It **sends one webhook per rendered report** to your endpoint. Each POST is `multipart/form-data`: a small JSON metadata part (who it's for, schedule name, format) **plus the rendered report as a file attachment**.
5. This receiver parses that, stores the file, and the 🔔 **Webhooks** tab shows one card per delivery — recipient chips, a "built as whom" line, and a **download link for the actual report**.

```
Send now ─▶ ThoughtSpot renders per view ─▶ one multipart webhook per report ─▶ POST /api/webhook
                                                                                     │ parse JSON + file
                                                                                     ▼
                          🔔 Webhooks tab  ◀── poll every 4s ── in-memory buffer (metadata + file bytes)
                          summary + per-recipient cards + 📄 download
```

---

## Live walkthrough (the real thing)

**Prerequisites** (you have these): a public tunnel (ngrok), the webhook feature enabled on your instance
(it's beta — enabled by ThoughtSpot Support), an admin token, and the **Webhooks Testing** Liveboard with
`wmoy_test_2` / `wmoy_test_3` + groups + the RLS rule
`ts_groups = 'wmoy_test_2_group' and PRODUCT_CATEGORY != 'music player'`.

1. **Arm the receiver** (pick a shared secret so deliveries verify):
   ```bash
   TS_ALLOW_WEBHOOK_SINK=true TS_WEBHOOK_SECRET=<secret> npm start
   ```
2. **Expose it** so ThoughtSpot Cloud can reach it:
   ```bash
   ngrok http 3000
   ```
   > ⚠️ **The tunnel exposes the WHOLE server, including `POST /api/auth/token`** — the trusted-auth
   > mint endpoint. Anyone with the ngrok URL could otherwise ask it for a token.
   >
   > The mitigation is the **Host allowlist**: every route except `/api/webhook` refuses a Host
   > header that is not loopback, so the tunnel reaches the receiver and nothing else. The inbox
   > read/clear endpoints (`/api/webhook/events`, `/api/webhook/file/*`) are loopback-only too.
   >
   > Only set `TS_PUBLIC_HOST=<your-ngrok-host>` if you genuinely need the tunnel to serve the app —
   > and then the mint endpoint is reachable again, so put real auth in front of it first. Keep the
   > tunnel short-lived, and always set `TS_WEBHOOK_SECRET` so unverified deliveries aren't retained.
3. **Register the webhook** (use the same secret):
   ```bash
   npm run register-webhook -- --url=https://<ngrok>/api/webhook
   ```
4. **Schedule the Liveboard** for the recipient mix (or do this in the ThoughtSpot UI):
   ```bash
   npm run schedule-liveboard -- --liveboard="Webhooks Testing" \
     --users=wmoy_test_2,wmoy_test_3 \
     --groups=wmoy_test_2_group \
     --emails=partner-a@example.com,partner-b@example.com
   ```
   Name `wmoy_test_3` **directly** on the schedule (not only via a group) so the "no webhook" case is unambiguous.
5. **Trigger it:** in ThoughtSpot, open the Liveboard → **Schedules** → the schedule → **Send now**.
6. **Watch the 🔔 Webhooks tab.** Within a few seconds you'll see:
   - **one card for the two external emails** (2 chips, one report) — *built with the schedule owner's access*;
   - **one card each for `wmoy_test_2` and each group member** — *built with their own RLS*;
   - **no card for `wmoy_test_3`**, and the summary strip counts *"1 scheduled user received NO webhook"*;
   - a **📄 download link** on each card — open `wmoy_test_2`'s report and confirm it shows only
     `PRODUCT_CATEGORY != 'music player'`. That's exactly what that user received.

**Is #4 expected or a bug?** Check whether `wmoy_test_3` gets the scheduled **email**:
- email also fails → the RLS block is working as designed; no webhook is expected;
- email arrives but no webhook → likely a webhook-specific defect worth a support ticket.

**Env vars** (set on `npm start`; kept here rather than in the guard-protected `.env.example`):

| Var | Purpose |
|---|---|
| `TS_ALLOW_WEBHOOK_SINK` | `true` arms `POST /api/webhook` (default off → 403, fail-closed). |
| `TS_WEBHOOK_SECRET` | Shared HMAC secret; set the **same** value on the server and on register-webhook to get ✓ verified. |
| `TS_WEBHOOK_SIG_HEADER` | Signature header name (default `x-ts-signature`). |
| `TS_WEBHOOK_MAX_MB` | Max delivery size (default 30). |

---

## Rehearse it locally first (optional)

Before going live you can drive the exact same receiver + UI with a local replay — same code path,
including a real multipart delivery with an attached PDF you can open:

```bash
TS_ALLOW_WEBHOOK_SINK=true TS_WEBHOOK_SECRET=demo npm start
# then, in another terminal:
TS_WEBHOOK_SECRET=demo npm run simulate-webhook -- --multipart
```

This posts the four scenarios (2 external batched, `wmoy_test_2`, two group members; none for `wmoy_test_3`)
as signed multipart deliveries with a sample PDF each. Add `--recipients=1200` to see the large-audience case.
Data is synthetic — it shows the *shape* and the plumbing, not real RLS.

You can also compose deliveries interactively: on the 🔔 Webhooks tab click **＋ Compose delivery**, edit the
recipient mix (external emails, users, groups, RLS-blocked), and **Send** — it exports the currently-selected
Liveboard and fires one webhook per the batching rules. Each card has an **ⓘ** to inspect the raw payload.

---

## Notes

- Triggering is **Send now** (UI) or the schedule cadence — ThoughtSpot has no REST "run now".
- Real deliveries are `multipart/form-data`; the receiver extracts the JSON metadata **and** the report file
  (`GET /api/webhook/file/:id/:fileId`). It keeps only the **last 50** deliveries in memory — hit **Clear** between runs.
- Attachments are also bounded by **total bytes**, not just delivery count: `TS_WEBHOOK_MAX_BYTES`
  (default 100 MB) evicts oldest-first, and `TS_WEBHOOK_MAX_FILES` (default 10) caps files per delivery.
  When `TS_WEBHOOK_SECRET` is set, an unverified delivery's bytes are never retained at all.
- Payloads are untrusted: every payload string enters the DOM via `textContent`; attachment downloads set a
  sanitized `Content-Disposition` filename. They are served as `attachment` (never `inline`) with
  `X-Content-Type-Options: nosniff` and an allowlisted Content-Type — a sender-supplied `text/html`
  part would otherwise be stored XSS on the same origin that mints trusted-auth tokens.
