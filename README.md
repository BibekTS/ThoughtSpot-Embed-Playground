<div align="center">

# ThoughtSpot Embed Playground

**Connect → pick an embed → tweak → copy the code.**

A tool-first playground for the ThoughtSpot Visual Embed SDK. Every setup is a shareable link.<br>No build step, no framework.

[![SDK](https://img.shields.io/badge/visual--embed--sdk-1.49.0-1d4ed8)](ts-sdk-version.json) [![node](https://img.shields.io/badge/node-18%2B-1d4ed8)](package.json) [![build](https://img.shields.io/badge/build_step-none-1d4ed8)](index.html) [![license](https://img.shields.io/badge/license-MIT-1d4ed8)](LICENSE)

**[Live demo](https://vantage-sales-analytics.vercel.app/)** · **[TSE best-practices guide](https://vantage-sales-analytics.vercel.app/docs/tse-best-practices.html)** · **[SDK docs](https://developers.thoughtspot.com/docs/)**

</div>

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

Paste your instance URL in the top bar and click **Connect**. It uses browser-session auth, so keep a
tab logged into ThoughtSpot in the same browser. No `.env`, no keys.

> **One-time CORS step:** add `http://localhost:3000` under **Develop → Customizations → Security
> Settings → CORS** so the object pickers can load. The embed itself renders without it.

Pick an embed from the rail, choose a data object, tweak options, and copy from the **SDK Code** tab.
**Share** copies a link that reproduces the setup. Secrets are never serialized, and links are
sanitized on load.

## Why use it

- **Runnable code, not snippets.** The SDK Code tab tracks every option you set, ready to paste.
- **Contextual inspector.** Data object, display options, actions, runtime filters and parameters,
  custom actions, host events and custom styles, shown only where the active embed supports them.
- **See what the SDK does.** Event log, SDK lifecycle, and every REST call the setup depends on.
- **Real integrations, wired up.** Drill-through, callback actions, webhooks and Spotter over MCP.
- **Safe to share.** A fail-closed token server, and links sanitized on load.

## Embed types

| Rail item | SDK | Needs |
|---|---|---|
| Search Data | `SearchEmbed` | Model |
| Spotter AI | `SpotterEmbed` | Model |
| Spotter Chat (MCP) | Custom chat UI over the Spotter 3 MCP server ([docs](docs/spotter-mcp-chat.md)) | Model + the local server |
| Liveboard | `LiveboardEmbed` | Liveboard |
| Custom Liveboard | `LiveboardEmbed` + a host-native filter bar | Liveboard |
| AI Highlights | `LiveboardEmbed` + `HostEvent.AIHighlights` | Liveboard |
| Single Viz | `LiveboardEmbed` + `vizId`, or a standalone Answer | Liveboard + viz, or Answer |
| Drill-through | `LiveboardEmbed` + a host-rendered detail list over `searchdata` | Liveboard + detail Model |
| Full App | `AppEmbed` | — |
| AI Insights (REST) | Spotter REST, no iframe | Model |

## Integrations

| Integration | What it shows | Write-up |
|---|---|---|
| **Drill-through** | Point click → filtered detail Liveboard; "View detail" → event-grain rows rendered by the host | below |
| **Download PDF** | Callback action → viz rows → paginated client-side PDF | [callback-action.md](docs/callback-action.md) |
| **Customize Export** | Custom export flows from the embed | [customize-export.md](docs/customize-export.md) |
| **Webhook Inbox** | One webhook per recipient, with the rendered report attached | [webhook-inbox-demo.md](docs/webhook-inbox-demo.md) |
| **Spotter Chat (MCP)** | A chat UI over the Spotter MCP server, no iframe | [spotter-mcp-chat.md](docs/spotter-mcp-chat.md) |

Custom actions come in four types: **Callback** (runs host code), **URL** (opens a link with row
context), **Write-back** (`POST /api/writeback` stub) and **Drill-down** (re-renders a detail Liveboard).

<details>
<summary>Drill-through: how it works and what to watch for</summary>

Everything is configured in the **Drill-through** panel. No GUIDs are hardcoded, so it runs on any cluster.

1. **Point click → detail Liveboard.** `EmbedEvent.VizPointClick` attributes merge with host filters
   and in-iframe filters (`HostEvent.GetFilters`); the detail Liveboard renders with them as runtime
   filters.
2. **"View detail" → host record list.** A context-menu custom action scoped with
   `dataModelIds.modelColumnNames` fetches rows via `POST /api/rest/2.0/searchdata`, pages with
   `record_offset` past the 1,000-row cap, and renders them outside the iframe as a modal or a panel.
   **View payload** shows the raw `EmbedEvent.CustomAction` payload.

Gotchas:

- `modelColumnNames` scopes to a **visualization**, not a column: the action shows on every cell of
  that viz. Turn on **Only drill from one column** to refuse clicks on other cells.
- `available_data_row_count` equals the returned count on every page, so a **short page** is the only
  end-of-data signal.
- Runtime filters are not a security boundary. Detail rows are safe because `searchdata` runs under
  the viewer's own token, so RLS applies.

Requires SDK 1.43.0+ and cluster 10.14.0.cl+ for column scoping.

</details>

## Trusted auth (optional)

For testing trusted-auth tokens, groups, JIT and RLS claims:

```bash
npm run setup      # creates .env: set THOUGHTSPOT_HOST, TS_SECRET_KEY, TS_DEFAULT_USERNAME
npm run doctor     # mints a real test token, or reports the exact upstream error
npm start          # .env is read at boot
```

Enable trusted authentication in ThoughtSpot first (**Develop → Customizations → Security Settings**)
and copy the secret key. Then switch the top bar to **Trusted token → Token claims…**. The server
holds the secret and mints short-lived tokens; the secret never reaches the browser.

- **full** (`auth/token/full`): `username`, `auto_create`, `org_id`, `group_identifiers[]`.
- **custom** (`auth/token/custom`): `variable_values[]` for ABAC via `ts_var()`, optional
  `objects[]`, and `persist_option: REPLACE` so entitlements can't accumulate.

<details>
<summary><code>.env</code> settings</summary>

| Key | What it is | Default |
|---|---|---|
| `THOUGHTSPOT_HOST` | Full instance URL | — |
| `TS_SECRET_KEY` | Trusted-auth secret. **Never commit.** | — |
| `TS_DEFAULT_USERNAME` | User minted when the UI field is blank | `tsadmin` |
| `TS_USERNAME_ALLOWLIST` | Usernames the server may mint for | default user |
| `TS_DEFAULT_ORG_ID` | Optional Org id | — |
| `PORT` | Server + static port | `3000` |
| `TS_ALLOW_JIT` | Allow `auto_create` (JIT) | `false` |
| `TS_GROUP_ALLOWLIST` | Groups the browser may request. Empty = none; `*` = any | empty |
| `TS_ALLOW_DEV_PROXY` | Enable the `/api/writeback` stub | `false` |

For the full claims playground, set `TS_ALLOW_JIT=true` and `TS_GROUP_ALLOWLIST=*`.

</details>

## Security

The server is **fail-closed**, and `npm test` asserts every guard:

- An empty username allowlist refuses **all** mints.
- JIT (`auto_create`) is refused unless `TS_ALLOW_JIT=true`.
- `group_identifiers` are refused unless allowlisted.
- `/api/filter-values` forwards the caller's own token and never mints one.
- Static serving is limited to frontend assets: never source, `.env`, or bundles.
- Shared links are sanitized, and a host from a link needs an explicit Connect click.

A real deployment must derive the username from a verified server-side session, never the request body.

## Commands

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run on `http://localhost:3000` (dev auto-restarts) |
| `npm run setup` / `npm run doctor` | Create `.env` / verify trusted auth end-to-end |
| `npm test` | Security gate: server guards + static restrictions |
| `npm run boot-check` | Frontend gate: headless boot, fails on any JS error |
| `npm run test:spotter-mcp` | Unit tests for the Spotter MCP relay |
| `npm run vendor-sdk` | Self-host the pinned SDK into `vendor/` |
| `npm run register-webhook` / `schedule-liveboard` / `simulate-webhook` | Webhook Inbox demo |

<details>
<summary>Troubleshooting</summary>

| Symptom | Fix |
|---|---|
| **CORS blocked** | Add `http://localhost:3000` to the instance's CORS allowlist. |
| **Log in to ThoughtSpot first** | Sign in to your instance in the same browser, then retry. |
| Token mint returns **503** | `TS_SECRET_KEY` isn't set: `npm run setup`, fill `.env`, `npm run doctor`. |
| Minting **403s** for your user | Set `TS_DEFAULT_USERNAME`, leave `TS_USERNAME_ALLOWLIST` blank. |
| JIT / group minting **403** | Fail-closed by design: set `TS_ALLOW_JIT=true` and/or `TS_GROUP_ALLOWLIST`. |
| Edited `.env`, nothing changed | Restart; `.env` is read at boot. |
| `file://` doesn't work | Serve it with `npm start`. |
| **Spotter Chat** / **Trusted token** greyed out | They need the Node server's `/api/*`: run `npm start`. |

</details>

## Layout

```
index.html  config.js   Tool shell + optional seed defaults
css/                    Design system + tool layout
js/                     state · discovery · embed · auth · invoice-pdf · spotter-mcp · app (controller)
lib/                    multipart parser + Spotter MCP relay
server.js               Token service, filter proxy, webhook sink, static host
scripts/                setup · doctor · smoke-test · boot-check · vendor-sdk · webhook demo
docs/                   TSE best-practices guide + integration write-ups
```

## License

[MIT](LICENSE) © 2026 Bibek Shrestha. The ThoughtSpot Visual Embed SDK and other dependencies are
covered by their own licenses.
