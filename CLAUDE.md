# CLAUDE.md — Project constitution & agent onboarding

Every agent (CEO session or worker) auto-loads this file. It is the shared, durable knowledge
that makes stateless agents work as one organization. Read it before touching anything.

## What this is

A **tool-first ThoughtSpot Visual Embed SDK playground**: connect → pick an embed → tweak options
→ copy runnable SDK code. Every setup is a shareable link. Vanilla HTML/CSS/ES modules, **no build
step, no framework**. An Express server (`server.js`) mints trusted-auth tokens and proxies a few
REST calls. Repo: `BibekTS/ThoughtSpot-Embed-Playground` on GitHub; `gh` is authenticated.

## Run & verify

| Command | Purpose |
|---|---|
| `npm start` | Server + frontend on http://localhost:3000 (also powers Trusted Auth) |
| `npm run dev` | Same, auto-restart |
| `npm test` | **The security gate.** Boots the server, asserts security guards + static restrictions |
| `npm run boot-check` | **The frontend gate.** Boots the server, loads the app in headless Chrome, fails on any JS error |
| `npm run doctor` | Verify Trusted Auth end-to-end (mints a real test token) |
| `npm run setup` | Create `.env` from template |
| `npm run vendor-sdk` | Self-host the pinned SDK into `vendor/` |

**The verification bar for ANY code change (all three, every time):**
1. **ESM parse** — each `js/*.js` is a browser ES module; the package is not `"type":"module"`, so
   `node --check *.js` mis-parses them as CommonJS. Syntax-check by copying to `.mjs` first (CI's
   `esm-parse` job does exactly this).
2. **Smoke test** — `npm test` must stay green (all checks — never weaken an assertion to pass, and
   don't hardcode the count anywhere: it grows).
3. **Headless boot** — `npm run boot-check` (scripts/boot-check.mjs). Asserts the tool shell mounts
   with **zero** JS console/page errors and no non-favicon 4xx. The only allowed console 404 is the
   pre-existing `/favicon.ico` on the restricted static server.

CI (`.github/workflows/ci.yml`) runs the same three plus a `guard` job (protected paths, below).

## Architecture (files)

- `js/state.js` — ONE `state` object → URL hash (`#s=`, base64url) + localStorage + share link.
  Everything decoded from a link runs through `sanitize()` (whitelist keys, coerce types, cap
  lengths, strip `__proto__/constructor/prototype`, `validHost()`). **Secrets are never serialized.**
- `js/discovery.js` — REST discovery (org, worksheets, liveboards, vizzes, answers, column values).
- `js/embed.js` — SDK wrapper `initSDK()` + `doRender()`. SDK pinned at `visual-embed-sdk@1.49.0`.
- `js/auth.js` — trusted-auth token-claims playground + live inspector.
- `js/invoice-pdf.js` — Callback-action handler: viz rows → paginated client-side PDF.
- `js/spotter-mcp.js` — the Spotter Chat (MCP) rail section: streams `/api/spotter-mcp/chat` (SSE).
- `js/app.js` — the controller (~6.4k lines): connection, rail, render, the single contextual
  inspector, SDK-code generator, event log. **This monolith is a standing refactor target.**
- `server.js` — token service + filter proxy + webhook sink + static host. **Fail-closed** (see rules).
- `lib/multipart.js` — dependency-free multipart/form-data parser for webhook deliveries (CommonJS).
- `lib/spotter-mcp/` — the MCP relay (ESM: `router.mjs`, `mcp-client.mjs`, `customize.mjs` + their
  `*.test.mjs`, run by `npm run test:spotter-mcp`). ESM-only, so server.js dynamic-`import()`s it.
- `scripts/` — `smoke-test.mjs` (security gate), `boot-check.mjs` (frontend gate), `doctor.mjs`,
  `setup.mjs`, `vendor-sdk.mjs`.

## Critical rules (violate these and you break the app)

- Always `embed.destroy()` before re-render.
- **Standalone saved Answer** = `SearchEmbed({ answerId, hideSearchBar:true })`, NOT
  `LiveboardEmbed`+vizId. A saved answer cannot be embedded as an individual viz.
- **Date runtime-filter epochs must be NUMBERS (not strings) and UTC** (not local midnight).
  Coerce at trigger time — state stores strings.
- **`HostEvent.UpdateRuntimeFilters` APPENDS**, it does not replace. Route through
  `pushRuntimeFilters()`; to clear a column, resend it with `values:[]`. Runtime filters ≠ visible
  Liveboard filters (`HostEvent.UpdateFilters`), and they are **not a security boundary**.
- All state changes go through `state.js` (`setState`/sanitize). New state keys need a default,
  a sanitize branch (with caps + proto-guard), and a `mergeKnown` line, or shared links break.
- All TS/shared-link-derived strings into the DOM use `textContent`, never `innerHTML` (XSS).
- **Server is fail-closed:** JIT (`auto_create`) refused unless `TS_ALLOW_JIT=true`; browser
  `group_identifiers` refused unless allowlisted; `/api/filter-values` forwards the caller's bearer
  and never mints; static serving is restricted to frontend assets. `npm test` asserts all of this.
- **An empty username allowlist refuses ALL mints** (403) — it is not "no restriction". The
  allowlist also applies when `auto_create` is set: `TS_ALLOW_JIT` governs CREATION only.
- `window.TS_CONFIG` is a plain `window` property set in `config.js` (`window.TS_CONFIG = {…}`) —
  an object literal, not a `const`, so a later script can replace or extend it.

## How the organization works (see BACKLOG.md for the queue)

**Three standing goals, in this order of precedence:**
1. **Improve the app** — the S/R backlog items: stability, features, refactoring.
2. **Keep it current** — the W items: track ThoughtSpot SDK/doc drift via ts-watch.
3. **Improve the organization itself** — the M items: sharpen the skills, playbooks, and gates.
   When a cycle exposes a process failure (a gate that missed something, an ambiguous rule, a
   duplicated effort), file an M item in `BACKLOG.md` — the org must get better at getting better.

**The CEO is the interactive driving session ONLY, and it orchestrates — it dispatches the
departments and does not do department work itself.** Agents with no data dependency run **in
parallel**: Review Board lenses, discovery hunters, Review Board ∥ QA on the same diff, and
worktree-isolated implementers for independent items. The weekly ts-watch cloud routine is NOT a
CEO: it runs the `/ts-watch` playbook, opens one PR, and stops — it never runs `/ceo-improve-cycle`
and **never merges anything**. Departments = the named agents in `.claude/agents/` (fall back to
built-ins only if unavailable, e.g. a fresh clone): Research (`researcher`; fallback `Explore`),
Engineering (`architect` + worktree-isolated `implementer`s; fallbacks `Plan`/`general-purpose`),
Review Board (`reviewer` per lens + `/code-review`, `/security-review`), Discovery (`bug-hunter`
per lens; fallback `reviewer`), QA (`qa-verifier` running `npm test` + `npm run boot-check` + CI),
Operations (`/schedule`, `/loop`, `gh` merge). The cycle is codified in `/ceo-improve-cycle`
(incl. the `discover` / `discover fix` bug-hunt modes + per-cycle micro-retro).

**Shared memory.** `docs/org-memory/` is the org's third durable store: rules live here in the
constitution, tasks in `BACKLOG.md`, discovered **facts** in `docs/org-memory/codebase.md` and the
retro log in `docs/org-memory/retros.md`. Every agent reads the memory before working and reports
memory-worthy facts back; the cycle persists them at the Records step, in the same PR as the work
that earned them. Facts that harden into rules get promoted into this file via a guard-protected PR.

**Every change is a branch + PR** with a verification-evidence section. **Merging `main` deploys
to PRODUCTION via Vercel — treat every merge as a release.** A PR auto-merges only when ALL hold:
required CI checks green (`smoke`, `esm-parse`, `guard`) ∧ code review found no confirmed
correctness bug ∧ the `guard` check passed without needing the `human-approved` label.

**Protected paths — mechanical enforcement.** The CI `guard` job fails any PR touching
`server.js`, `js/state.js` (the sanitize/security layer), `scripts/smoke-test.mjs`, `.env*`,
`.github/workflows/*`, or `CLAUDE.md` unless a human has added the **`human-approved`** label.
Hard rules for every agent: **never add that label yourself, never use `gh pr merge --admin`,
never weaken the guard job** — a red `guard` means "stop and hand this to the human".

**`BACKLOG.md` is NOT guard-protected** (every cycle must update it), but with a bright line:
a cycle may only change the **Status column**, append **outcome notes**, and **append new rows**.
Changing Priority values, editing acceptance criteria, or deleting rows is reprioritization —
that is the human CEO's lever and requires their review.
