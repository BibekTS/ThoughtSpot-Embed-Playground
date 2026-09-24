# ThoughtSpot Embed Playground

A small, shareable tool for testing the **ThoughtSpot Visual Embed SDK**. Point it at any instance,
pick an embed type, tweak the options, and copy the runnable SDK code. No build step, no framework.

> Connect → pick an embed → tweak → copy the code. Every setup is a shareable link.

---

## Quick start

Needs **Node 18+** and a ThoughtSpot instance you can log into.

```bash
npm install
npm start
```

Open **http://localhost:3000**, paste your instance URL in the top bar, click **Connect**. No `.env`,
no keys — this uses **browser-session auth**, so keep a tab logged into ThoughtSpot in the same
browser.

> **One-time CORS step:** add `http://localhost:3000` to your instance's CORS allowlist
> (**Develop → Customizations → Security Settings → CORS**) so the object pickers can load. The
> embed itself renders without it.

Then pick an embed from the left rail, choose a data object in the inspector, tweak options, and
copy from the **SDK Code** tab at the bottom.

Everything you configure is encoded into the URL hash and saved to `localStorage` — **Share** copies
a link that reproduces your setup. Secrets are never serialized, and links are sanitized on load.

---

## Embed types

| Rail item | SDK class | Needs |
|---|---|---|
| Search Data | `SearchEmbed` | Worksheet/Model |
| Spotter AI | `SpotterEmbed` | Worksheet/Model |
| Spotter Chat (MCP) | Custom chat UI over the Spotter 3 MCP server — no iframe, no SDK ([docs](docs/spotter-mcp-chat.md)) | **the local server** (greyed out on a static host) |
| Liveboard | `LiveboardEmbed` | Liveboard |
| Custom Liveboard | `LiveboardEmbed` + website-native filter bar | Liveboard |
| AI Highlights | `LiveboardEmbed` + `HostEvent.AIHighlights` | Liveboard |
| Single Viz | `LiveboardEmbed` (+`vizId`) | Liveboard + Viz, or a standalone Answer |
| Drill-through | `LiveboardEmbed` + a host-rendered detail grid over `searchdata` | Liveboard (+ a detail Model) |
| Full App | `AppEmbed` | — |
| AI Insights (REST) | Spotter REST, no iframe | Worksheet/Model |

The **inspector** is contextual to the active embed: Data object · Display options · Modify actions ·
Runtime filters · Runtime parameters · Custom actions · Host events · Custom styles.

The **bottom panel** has four tabs: Event Log · SDK Code · SDK Lifecycle · APIs Used.

---

## Drill-through demo

Summary → detail, entirely host-side, over two Models of the same data: an aggregated one behind the
summary Liveboard and an event-grain one for the rows. Configure it all in the **Drill-through**
inspector panel — no GUIDs are hardcoded, so it runs on any cluster.

Two independent moves:

1. **Point click → filtered detail Liveboard.** `EmbedEvent.VizPointClick` gives the clicked point's
   attributes. Those merge with the host's own filters and with whatever the user set *inside* the
   iframe (`HostEvent.GetFilters`, which returns a promise directly), and the detail Liveboard renders
   with them as runtime filters. Clicked attributes win on any column that appears in both.
2. **"View detail" → your own paged grid.** A `CONTEXTMENU`/`VIZ` custom action scoped with
   `dataModelIds.modelColumnNames: ['<modelGuid>::<column>']` appears on **one measure column only**.
   It fetches event-grain rows with `POST /api/rest/2.0/searchdata`, pages them with `record_offset`
   (which is how you get past the 1,000-row response cap), and renders them outside the iframe — with
   per-row `{Column}` deep links into whatever system owns the record.

A badge reconciles the measure the user clicked against `available_data_row_count` and turns amber
when they disagree — i.e. when the summary and detail models are not counting the same grain.

**A 15-minute demo, in six steps:** pick the summary Liveboard → click a funnel stage and watch the
detail Liveboard open already filtered → right-click the measure on a bar and pick "View detail" →
read the individual rows → "Load more" past the first page → point at the badge and show the KPI and
the row count agreeing. The SDK Code tab carries the runnable version of all of it.

> Requires SDK 1.43.0+ / cluster 10.14.0.cl+ for the column scoping (this repo pins 1.49.0).
> Runtime filters are **not** a security boundary — they are visible and editable in the URL. The
> detail rows are safe because `searchdata` runs under the viewer's own token, so RLS applies.

---

## Custom actions

Custom actions add buttons to an embed's menus. Pick a type per action:

| Type | What fires | What the host does |
|---|---|---|
| **Callback** | `EmbedEvent.CustomAction` with the row payload | Runs your own code — no navigation |
| **URL** | Opens a URL with the selected row data appended | Hands off to another app with context |
| **Write-back** | `POST /api/writeback` (dev-proxy stub) | Round-trips a value to a system of record |
| **Drill-down** | Re-renders at a detail Liveboard | Navigates to a focused board |

Four worked integrations ship wired up, each with a write-up in [`docs/`](docs/):
[Download PDF](docs/callback-action.md) · [Customize Export](docs/customize-export.md) ·
[Webhook Inbox](docs/webhook-inbox-demo.md) · [Spotter Chat (MCP)](docs/spotter-mcp-chat.md).

---

## Trusted Auth (optional)

For testing trusted-auth tokens, groups, JIT, and RLS claims:

```bash
# 1. In ThoughtSpot (admin): Develop → Customizations → Security Settings → Trusted authentication
#    → enable it and copy the secret key.
npm run setup     # 2. creates .env — set THOUGHTSPOT_HOST, TS_SECRET_KEY, TS_DEFAULT_USERNAME
npm run doctor    # 3. verify: mints a real test token and reports the exact upstream error if not
npm start         # 4. restart — .env is read at boot
```

Switch the top-bar auth selector to **Trusted token** → **Token claims…**. The Node server holds the
`secret_key` and mints short-lived tokens — **the secret never reaches the browser**. The inspector
shows the redacted request, the decoded JWT, an expiry countdown, and every `getAuthToken` call.

Two token types, selectable per mint:

- **full** → `auth/token/full` — identity & JIT (`username`, `auto_create`, `org_id`),
  `group_identifiers[]` for group-keyed RLS, and `user_parameters` *(deprecated in TS 10.4.0.cl+)*.
- **custom** → `auth/token/custom` — `variable_values[]` (the modern ABAC path; referenced in RLS
  rules via `ts_var(name)`), optional `objects[]` scoping, and a **required** `persist_option`
  (the playground sends `REPLACE`, so entitlements can't accumulate across mints).

> **Runtime filters are not a security boundary** — they become editable URL params. For per-user
> data, enforce it server-side with RLS/ABAC (a `custom` token + `variable_values`).

### `.env` settings

| Key | What it is | Default |
|---|---|---|
| `THOUGHTSPOT_HOST` | Full instance URL | — |
| `TS_SECRET_KEY` | Trusted-auth secret. **Never commit.** | — |
| `TS_DEFAULT_USERNAME` | User minted for when the UI field is blank | `tsadmin` |
| `TS_USERNAME_ALLOWLIST` | Comma-separated usernames the server may mint for | = default user |
| `TS_DEFAULT_ORG_ID` | Optional Org id | — |
| `PORT` | Server + static port | `3000` |
| `TS_ALLOW_JIT` | Allow `auto_create` (JIT) | `false` |
| `TS_GROUP_ALLOWLIST` | Groups the browser may request. Empty = none; `*` = any | empty |
| `TS_ALLOW_DEV_PROXY` | Enable the `/api/writeback` stub sink | `false` |

To exercise the full claims playground, set `TS_ALLOW_JIT=true` and `TS_GROUP_ALLOWLIST=*`.

---

## Commands

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run on `http://localhost:3000` (dev = auto-restart) |
| `npm run setup` | Create `.env` from the template |
| `npm run doctor` | Verify Trusted Auth end-to-end (mints a test token) |
| `npm test` | **Security gate** — asserts the server guards + static restrictions |
| `npm run boot-check` | **Frontend gate** — headless boot, fails on any JS error |
| `npm run vendor-sdk` | Self-host the pinned SDK into `vendor/` |
| `npm run register-webhook` / `schedule-liveboard` / `simulate-webhook` | Webhook Inbox demo ([docs](docs/webhook-inbox-demo.md)) |

---

## Security model

`TS_SECRET_KEY` lives only on the server, and the guards are **fail-closed**:

- A username **allowlist** blocks impersonating arbitrary existing users.
- **JIT (`auto_create`) is refused** unless `TS_ALLOW_JIT=true` — it would side-step the allowlist.
- **`group_identifiers` are refused** unless allowlisted — the browser could otherwise mint into a
  privileged group.
- **`/api/filter-values` forwards the caller's own token** and never mints one.
- **Static serving** is restricted to frontend assets (never source, `.env`, docs, or bundles).
- **Shared links** are sanitized (unknown keys dropped, types coerced, prototype pollution blocked),
  and a hash-supplied host requires an explicit Connect click.

`npm test` asserts these stay closed. A real deployment must still derive the username from a
verified server-side session (SSO/cookie), never from the request body.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status says **CORS blocked** | Add `http://localhost:3000` to the instance's CORS allowlist. Only the REST pickers need it. |
| **Log in to ThoughtSpot first** | Browser-session auth needs an active login — sign in to your instance, then *retry*. |
| Token mint returns **503** | `TS_SECRET_KEY` isn't set. `npm run setup`, fill `.env`, then `npm run doctor`. |
| Trusted Auth won't mint | `npm run doctor` pinpoints a bad secret, unknown user, or unreachable host. |
| Minting **403s** for your user | Set `TS_DEFAULT_USERNAME` to your username, leave `TS_USERNAME_ALLOWLIST` blank. |
| JIT / group minting **403** | Fail-closed by design — set `TS_ALLOW_JIT=true` and/or `TS_GROUP_ALLOWLIST=…`. |
| Edited `.env`, nothing changed | `.env` is read at boot — restart. |
| `file://` doesn't work | Serve it — `npm start`. |
| **Spotter Chat** / **Trusted token** greyed out | No Node server behind this origin. Both need `/api/*` — run `npm start` on `http://localhost:3000`. |

---

## Layout

```
index.html        Tool shell (top bar · rail · stage · inspector)
config.js         Optional seed defaults
css/styles.css    Design system + tool layout
js/
  state.js        Single state object → URL hash + localStorage (sanitized on load)
  discovery.js    REST discovery: org, worksheets, liveboards, vizzes, answers
  embed.js        Visual Embed SDK wrapper: initSDK() + doRender()
  auth.js         Trusted-auth token-claims playground + live inspector
  invoice-pdf.js  Callback-action handler: viz rows → client-side PDF
  app.js          Controller: connection, rail, render, inspector, SDK code, log
server.js         Token service + filter proxy + static host. Fail-closed.
scripts/          setup · smoke-test (npm test) · boot-check · doctor · vendor-sdk
docs/             Deep-dive guides for the shipped integrations
```

---

## Maintenance

This repo is maintained by an organization of AI agents running a continuous-improvement loop.
Rules live in [`CLAUDE.md`](CLAUDE.md), the work queue in [`BACKLOG.md`](BACKLOG.md), and verified
findings in [`docs/org-memory/`](docs/org-memory/). Every change ships as a branch + PR with CI
gates (`smoke`, `esm-parse`, `guard`); protected paths require a human `human-approved` label.
