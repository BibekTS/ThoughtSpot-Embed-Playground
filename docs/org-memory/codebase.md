# codebase.md — verified facts about the code

One bullet per fact: date · evidence (`file:line`) · which cycle/PR established it. Read this
before researching, reviewing, or hunting — do not re-derive or re-file what's here. Delete
entries when falsified; promote to `CLAUDE.md` when they harden into rules.

## XSS surface

- 2026-07-10 (S1, PR #12): the four untrusted-string sinks — `logEvent()` and `toast()` in
  `js/app.js`, `chipsEditor` and `appendLog` in `js/auth.js` — are verified `textContent`-safe.
  A headless XSS probe in `scripts/boot-check.mjs` (hash→chips and mint→event-log paths) guards
  them; both sinks were mutation-tested.
- 2026-07-10 (S1 research → filed as S9): `el(tag, cls, html)` (app.js:261, auth.js:72) passes its
  third arg through `innerHTML`. Two call sites feed it a variable that is today always a
  literal/enum but would become a sink if ever fed TS/user data: `accordion(title,…)` (app.js:931)
  and `el('span','act-name', a)` (app.js:1266). Never pass TS/link-derived strings as the third
  arg — omit it and set `textContent` after. All four file:line cites independently re-verified
  2026-07-10 (M7 review) — exact.

## Standalone Answers (S3)

- 2026-07-13 (S3, this PR): the `answerId` render/generate/state plumbing **predates** the picker
  work — state key (`state.js:38` default, `:252` sanitize cap-128, `mergeKnown` spread), the
  `SearchEmbed({answerId,hideSearchBar:true})` render path (`embed.js:272-286`, gives `answerId`
  precedence over `vizId`), the code generator (`app.js:4224,4295-4297`), and lifecycle/APIs
  answer-awareness were all already present. The "Standalone Answer unreachable" gap was ONLY (1) no
  picker UI in `sectionObject` and (2) a broken `discoverAnswers`. Picker adds no new state key.
- 2026-07-13 (S3): `discoverAnswers(host)` (`discovery.js:193-212`) now does an instance-wide
  `POST /metadata/search {metadata:[{type:'ANSWER'}], record_size:10000, sort_options:NAME/ASC}`,
  parsing the top-level array identically to `discoverObjects` (`.filter(metadata_type==='ANSWER')`
  → `{id:metadata_id, name:metadata_name||'Untitled'}`). The old 2-arg worksheet-`dependent_objects`
  traversal was **dead code** (declared `answerCache`, never called; `dependent_objects` is an opaque
  map not keyed by type → always `[]`). Sole caller is `loadAnswers()` (`app.js:1155`).
- 2026-07-13 (S3): the answer auto-load fires a **credentialed** `POST /metadata/search`; its
  host-confirm safety rests entirely on the `connected &&` prefix (`app.js:1116`). `connected===true`
  is a safe proxy for "host confirmed" because it is set only in `connect()` (`app.js:481`) AFTER
  `pendingHostConfirm=false` (`:452`), and there is no `hashchange`/`popstate` listener (`loadState`
  runs once, `:274`). Any future code that sets `connected` elsewhere, or adds a live hash re-read,
  re-opens the pre-confirm leak. Boot-check `runAnswerPreconfirmProbe` guards this — but only for the
  literal `/metadata/search` path; a discovery-endpoint refactor would need the probe widened.
- 2026-07-13 (S3): `refreshCode` writes generated SDK code via `pre.textContent` (`app.js:4536`),
  which is why `esc()` (`app.js:4221`, escapes only `\` and `'`, NOT HTML) is XSS-safe today. If the
  code view ever switches to `innerHTML` (e.g. syntax highlighting), every `esc()`'d hash-derived
  value (`answerId`/`worksheetId`/`liveboardId`) becomes a sink.

## Session caches / host switch (S3 review)

- 2026-07-13 (S3 review): `connect()` (`app.js:447`) must reset every **non-host-keyed** session
  cache or an in-session host switch serves the prior host's objects. `answerList`/`answersLoading`
  (`app.js:204-205`) are now reset there (`:491`). `loadAnswers()` is additionally **host-fenced**
  (captures `getState().host`, drops the write + preserves the loading flag if the host changed
  mid-flight) — because the reset alone re-opened a last-write-wins race (a stale in-flight fetch
  could overwrite the new host's result). `vizCache` (`app.js:202`) is the same class and is NOT yet
  reset — latent, low-reachability (GUID-keyed, mostly self-masking); filed as **S11**.

## Filters & rendering

- 2026-07-08 (commit f7d439f, PR #4): `pushRuntimeFilters()` + `appliedRuntimeCols` landed,
  claiming to supersede the S5 filter-clobbering finding (`cfbApply()`/`applyLiveFilters()`/
  `cfbBuild` wiping each other). **Not yet re-verified** — S5 is still open; verify before
  building on this claim.
- 2026-07-13 (discover, filed S14): CFB (custom-filter-bar) date columns emit STRING epoch runtime
  filters → silently dropped by TS. `buildParentRuntimeFilters().fromCfb` (app.js:3872) passes
  `cfbSelected` values untouched; only `fromActive` (app.js:3876) runs `dateAwareValues`. Values are
  stringified at load (`String(v)` app.js:3087) + DOM `cb.value` (app.js:3379); the code generator
  quotes them too (app.js:4487). Two-lens confirmed (correctness + data-integrity). Distinct from S5.
- 2026-07-13 (discover, filed S16): Inspector runtime date-RANGE upper bound uses start-of-day —
  `readValues` (app.js:1924) computes `isoToEpochSec(to)` (00:00:00 UTC) instead of
  `isoToEndOfDayEpochSec` as `applyDateFilterViaRuntime` (app.js:1657) does → `BW_INC` drops the final
  day's rows on DATE_TIME columns; day-granular DATE columns are unaffected.
- 2026-07-13 (discover, filed S15): `render()` (app.js:582) has FOUR exit paths but only
  `ai-insights` (app.js:606) and the main path (app.js:615) call `currentEmbed.destroy()`. The
  `!s.host` (app.js:593) and `needsMissing` (app.js:596-601) early returns LEAK the prior embed and
  leave `currentEmbed` non-null-but-stale → HostEvents route to the hidden wrong board via the
  `!currentEmbed` guards (app.js:662/3612/1641).
- 2026-07-13 (discover, filed S17): the 4s `fallback` overlay-hide timer is a per-render `const`
  (app.js:624; `enterDrill` app.js:3906) with no module handle; overlapping renders within 4s orphan
  the prior timer → spurious `setOverlay('hidden')` + "Embed handed off…" log against the live embed.
- 2026-07-13 (discover, AUDITED CLEAN): `embed.destroy()`-before-re-render holds on both live render
  SITES — `render()` destroys at app.js:615 before `doRender` (:634); `enterDrill()` destroys at
  app.js:3899 before `doRender` (:3908). (The BUG is the early-return exits that leave *no* new render
  — S15, above.) The Inspector **activeFilters** date path is correct: epoch strings in state coerced
  to NUMBERS via `dateAwareValues` (app.js:1618, `Number.isFinite` NaN guard) at trigger time, UTC via
  `Date.UTC` (`isoToEpochSec` app.js:1589). `pushRuntimeFilters` (app.js:661) honors
  UpdateRuntimeFilters-APPENDS — computes empty-`values` clears for applied-minus-desired columns and
  resets `appliedRuntimeCols` per render (:633). `onDone` fires on 5 SDK events but is idempotent
  (`pushRuntimeFilters` resends the full desired set; `cfbBuild` has `_cfbBuilding` dedupe) — no
  double-apply. Remaining filter defects are ONLY S14 (cfb string epochs) + S16 (range upper bound).

## Custom actions / navigation

- 2026-07-13 (discover, filed S13): `urlTemplate` is the ONE navigable hash-derived URL that skips
  the app's scheme guard. `state.js:262` sanitizes it with `str()` (length only), unlike `host`
  (state.js:246) and `cssUrl` (state.js:336) which use `validHost()` ("blocks javascript:/data:").
  A `#s=`-supplied `url` custom action with `urlTemplate:"javascript:…"` (no `{{}}` placeholder, so
  `.replace()` is a no-op) reaches `window.open(url,'_blank','noopener')` (app.js:3761-3763) and the
  `javascript:` scheme executes. `noopener` severs `window.opener` but does not stop script execution.
- 2026-07-22 (S13, FIXED — supersedes the line cites in the bullet above): the sink had drifted to
  `js/app.js` `window.__onCustomAction` and the `str()`-only sanitize to `state.js:264` — both cited
  numbers in the 2026-07-13 bullet were stale by ~1200 lines. **Line numbers in this file age fast;
  re-verify every cite before acting on it.** The hole is now closed at the SINK via `safeNavUrl()`
  (`new URL(String(u), location.href)` + `http:`/`https:` allowlist, returns `''` if refused), applied
  to the **post-substitution** URL. That ordering is load-bearing: guarding `reg.urlTemplate` instead
  would re-open the smuggle `java{{X}}script:alert(1)` (absent column → `''` → `javascript:`).
  `state.js` was deliberately NOT changed — `urlTemplate` is still length-only sanitized by design,
  which is what kept the PR off a guard-protected path.
- 2026-07-22 (S13, security lens, verified refused): mixed case, leading spaces/NUL, embedded
  tab/CR/LF (`java\tscript:`), `data:`/`vbscript:`/`blob:`/`view-source:`, and host-position
  substitution (`https://evil.com%2F.ok.com/` → throws → fail-closed). `window.open` exists exactly
  ONCE in the repo (the guarded URL-action sink); the `writeback` branch POSTs to a config-derived
  `${API_BASE}/api/writeback` and the `drill` branch only feeds a GUID to `enterDrill`, so neither
  navigates. `reg.webhook` is sanitized + registered but **never read** — dead field.
- 2026-07-22 (S13): `safeNavUrl` resolves relative templates against `location.href`, so scheme-less
  (`crm.example.com/x`), protocol-relative (`//host/x`), relative (`/lookup?id=`) and `#anchor`
  templates keep working **exactly as before** (the browser resolved them identically pre-fix). The
  guard is scheme-only, never a host allowlist. Consequence: `mailto:`/`tel:`/`slack://` actions are
  now refused (fail-closed, toast + log) — filed as **S18**. Returning the normalized `u.href` is
  destination-preserving for http(s) (default-port strip, IDN punycode, case, dot-segment collapse;
  query/fragment byte-preserved) and cannot double-encode, because `encodeURIComponent` substitution
  runs first.
- 2026-07-22 (S13, review): the editor-save check must validate the template's **literal leading
  scheme**, NOT the placeholder-stripped string. Stripping `https://{{Domain}}` yields `https://`,
  which `new URL` THROWS on → legitimate templates falsely rejected (same for `…/`, `…?q=1`, `…#f`);
  and `https://{{Host}}/x` strips to `https:///x` which parses as host `x`, i.e. it would validate a
  different URL than the one opened. The editor check is a nicety — shared links bypass the form
  entirely, so the SINK is the only trust boundary.
- 2026-07-22 (S13, tested — a plausible "fix" that is WRONG): the save-time scheme regex
  `[a-z][a-z0-9+.-]*` must KEEP the dot in its char class. It mirrors the WHATWG URL scheme grammar
  exactly, which is why it agrees with `safeNavUrl` on every input. Removing the dot to "stop
  misreading `crm.example.com:8080/x` as a scheme" is a false economy: `new URL` parses that scheme
  the same way (dots and all) and REFUSES it, so the form would accept a template the sink then
  blocks on every click — accept-then-block, strictly worse than rejecting at entry. `localhost:3000/x`
  is refused for the same reason and is unfixable lexically (`localhost:3000` and `tel:123` are the
  same `word:digits` shape). The remedy is user-facing: write `http://crm.example.com:8080/…`.
  Keep the two checks in lockstep — divergence is what creates accept-then-block.
- 2026-07-22 (S13, security lens, AUDITED CLEAN, low impact): `customActionRegistry[a.id]` uses
  link-derived ids that `state.js` does not proto-guard. `__proto__` re-points the registry's own
  prototype (not `Object.prototype`) and `toString`/`constructor` make `reg` truthy — but no
  dispatcher branch fires on either. No exploit today; would matter if the registry gained a
  `for…in` or a default-bearing lookup.
- 2026-07-13 (discover, AUDITED CLEAN, security lens): secrets/tokens are never serialized or
  persisted — the discovery bearer is in-memory only (discovery.js:9-12), the secret_key never
  reaches the browser, the token inspector redacts + uses `textContent`. Runtime filters are NOT
  relied on as a security boundary anywhere in the embed/filter path; entitlements go through
  server-side token claims in `js/auth.js` (`group_identifiers`/`variable_values`), per CLAUDE.md.

## Gates

- 2026-07-10 (M7 review): `scripts/smoke-test.mjs:23` (PORT 34917) and `scripts/boot-check.mjs:31`
  (PORT 34921) hardcode their server ports with no env override — the server-bound gates are NOT
  safe to run concurrently on one machine (parallel worktrees, or a reviewer running the suite
  alongside QA, collide with `EADDRINUSE` and produce phantom reds). Only one agent runs them at
  a time; M8 tracks making them parallel-safe.
- 2026-07-22 (S13): **a boot-check probe that stubs `window.open` cannot observe `javascript:`
  execution** — the stub prevents the navigation that would execute it, so a `window.__pwned`-style
  assertion reads `true` even with the guard fully removed (empirically confirmed during the mutation
  test). Load-bearing assertions must be of the form "no hostile value REACHED the sink". Every probe
  needs a positive control (a legit input that must still reach the sink) or the negative assertion
  can pass vacuously when the dispatcher breaks.
- 2026-07-22 (S13): a probe that computes a readiness flag must GATE on it — the S13 probe originally
  called `fire()` unconditionally, so a missing `window.__onCustomAction` threw, escaped the probe,
  closed the browser, and killed the run **without ever printing `BOOT CHECK: FAIL`** (non-zero exit,
  but nothing for a log-grepping consumer to see).
- 2026-07-22 (S13): probes share ONE default browser context (localStorage is common to all) and run
  in declaration order against a hard 120s whole-run watchdog that is not scaled per probe. A probe
  that writes state must be ordered after any probe that asserts on persistence. Filed as **S20**.
- 2026-07-22 (M9/M10, EMPIRICALLY VERIFIED, the most load-bearing fact here): **agent-thread Bash
  calls reset cwd and lose shell variables between invocations.** `cd /var/tmp` in one call → `pwd`
  in the next returns the repo root. Worse, `cd "$UNSET_VAR"` is `cd ""`, which **returns 0 in zsh**
  and leaves you in the shared checkout — so any multi-call recipe built on a bare `cd` fails **open**,
  silently, into the very tree it was meant to protect. Every recipe handed to an agent must echo its
  absolute paths, use one self-contained chain per call (`cd /abs/path && …`), and use `git -C <abs>`
  for anything cwd-sensitive. This defect was written into the M10 recipe twice before review caught it.
- 2026-07-22 (M9/M10): the **QA scratch-worktree recipe** is mechanically sound and empirically proven:
  `git worktree add --detach <tmp> <SHA>` (creates missing leaf dirs) + `ln -s "$ROOT/node_modules"`
  is sufficient — `express`/`dotenv`/`puppeteer-core` all resolve, and `vendor/`+`.env` are unneeded
  because the SDK is CDN-imported (`js/embed.js`) and both gate scripts force a clean env. Both scripts
  derive `ROOT` from `import.meta.url` and spawn `server.js` with `cwd: ROOT`, so the scratch copy gates
  itself. Cleanup MUST be `git -C <root> worktree remove --force <scratch> && git -C <root> worktree
  prune`: the bare form run from inside the worktree exits **128** (`remove` succeeds, then `prune`
  can't `getcwd()`). `worktree remove` does NOT follow the `node_modules` symlink (canary-tested,
  122 entries before and after). It isolates **files, not ports** — 34917/34921 stay serialized (M8).
- 2026-07-22 (M9/M10): the isolation property was proven, not assumed — during a live mutation the
  scratch worktree showed `M js/app.js` while `git status --porcelain` on the shared checkout was
  EMPTY, and the S13 probe flipped to FAIL under the mutation (teeth confirmed). Caveats: the scratch
  worktree shares `ROOT/.git`, so ref-writing commands (`git stash`/`branch`/`tag`/`reset`) escape the
  "removing the worktree discards every mutation" property — inside it run only
  `git checkout <base> -- <path>`. `node_modules` shows as `?? node_modules` there (`.gitignore` has
  `node_modules/` with a trailing slash, which doesn't match a symlink), so `--force` on removal is
  load-bearing, not decorative, and a scratch tree's `git status` is never empty.
- 2026-07-22 (M9/M10): `git merge-base --is-ancestor A B` exits **0** when A is an ancestor of B *or
  equals B*, **1** when not, **128** when either ref doesn't resolve — three outcomes. It proves
  membership, NOT tip-ness: a stale-but-on-branch SHA still exits 0. Staleness detection needs the
  companion `git rev-parse <branch>` plus "state both and say if they differ". Never cite the ancestor
  check alone as the staleness guard.
- 2026-07-22 (M9/M10): `git log --oneline A..HEAD` can NEVER establish a "records-only" claim — it
  prints the subject the committing agent chose, not a file list. Any governance check on a commit's
  *file set* must use `--name-only`/`--stat` (or `git diff --name-only A..HEAD | sort -u`, which is
  flatter and also covers the merge-commit case). Found re-opening the carve-out at step 7.
- 2026-07-22 (M9/M10): `$PIPESTATUS` does not work under this repo's zsh Bash-tool shell —
  `npm test 2>&1 | tail` yields an empty exit code. Capture gate exit codes by redirecting to a file
  and reading `$?` directly, never through a pipe.
- 2026-07-22 (M9/M10): the CI `guard` job's `case` pattern (`.github/workflows/ci.yml`) can be replayed
  verbatim in a local shell against `git diff --name-only origin/main...<sha>` — it predicts the guard
  check exactly and costs nothing, so QA can report guard status before CI ever runs.
- 2026-07-22 (S13): `window.__onCustomAction` is a plain `window` global, dispatchable directly from a
  probe with a synthetic `{id, data:{clickedPoint:{selectedAttributes:[{column:{name},value}]}}}`
  payload — a host-free `#s=` link plus a direct call exercises registry-rebuild → `extractRow` →
  substitution with zero ThoughtSpot contact. Reusable pattern for custom-action probes.

## Webhooks (S12)

- 2026-07-14 (S12, this PR): **scheduled-Liveboard webhook batching is a permission-model
  consequence, not a bug.** ThoughtSpot renders the report per recipient: an **internal (`USER`)**
  recipient's report runs *as that user* (their RLS) → a personalized render → **one webhook each**,
  and an RLS-blocked user → empty render → **no webhook**; **external (`EXTERNAL_EMAIL`)** recipients
  share one render under the **schedule owner's** permissions → **one batched webhook**. Groups expand
  to per-user webhooks. Triggering is **Send now** / cadence (no REST "run now"); schedules are
  creatable via `POST /api/rest/2.0/schedules/create` (`recipient_details.emails` / `.principals`).
- 2026-07-14 (S12): the receiver stores `data = payload.data || payload` and the inbox renderer reads
  the **full `payload`** — so a `LIVEBOARD_SCHEDULE` renderer must read defensively (top-level
  `eventType` OR `data.notificationType`, and `payload.data.recipients`). HMAC verify is over the
  **raw request bytes**, so a replay that signs the exact bytes it POSTs gets ✓ verified — this is how
  `scripts/simulate-webhook.mjs` produces verified deliveries. Verification is **advisory**: a
  bad/missing signature is still stored and shown, flagged ⚠.
- 2026-07-14 (S12): **real scheduled-Liveboard webhooks to a plain endpoint arrive as
  `multipart/form-data`** — a JSON metadata part **plus the rendered report as a binary file
  attachment** (PDF/CSV/XLSX); only *storage-destination* (GCS/S3) configs send pure JSON with file
  links. The JSON-only `express.json` receiver could not capture the file, so the receiver was made
  multipart-aware: `lib/multipart.js` (dependency-free, binary-safe parser) + `server.js` uses
  `express.raw({type:'multipart/form-data'})` to get raw bytes, `parseMultipart`/`splitMultipart` to
  extract `{meta, files}`, keeps file bytes out-of-band in a `webhookFiles` Map (evicted with the
  50-event ring), and serves them at `GET /api/webhook/file/:recId/:fileId`. HMAC is verified over the
  raw multipart bytes. `server.js` is guard-protected, so this change needs the human-approved label.
- 2026-07-14 (S12): the "RLS-blocked user got no webhook" signal is inferred, not in the payload —
  the inbox summary diffs `scheduleDetails.userIds` (directly-named users) against delivered `USER`
  ids. It can't see **group-expanded** members (their ids aren't in `userIds`), so for the live test
  name the blocked user **directly** on the schedule. The email-vs-webhook check disambiguates
  expected-RLS from a webhook defect (email fails too → by design; email succeeds → likely a bug).

## Upstream / SDK

- 2026-07-10 (W2): the ts-watch detector reports SDK versions 1.49.1–1.50.0 newer than the pinned
  1.49.0. Bump procedure is in `docs/ts-watch-playbook.md`; W2 is the open item.

## Governance / how the rulebook itself fails

- 2026-07-22 (M9/M10): **rules that partition the repo must be written as a closed ALLOW-list; an
  enumerated deny-list of "product paths" fails open.** The post-QA re-verification carve-out was
  first written as an allow-list (`BACKLOG.md`, `docs/org-memory/*`) PLUS a deny-list (`js/`,
  `server.js`, `lib/`, `scripts/`, `*.html`, `*.css`) — which together do not cover the repo.
  `package.json`, `config.js`, `package-lock.json`, `ts-sdk-version.json`, `vendor/**`, and
  `.claude/**` (the org's own machinery) fell in the gap and read as non-invalidating. Traced
  exploit: a post-QA commit editing only `package.json` re-points what `npm test` runs, `guard`
  stays green (it protects `scripts/smoke-test.mjs`, not the script name that invokes it), CI's
  `smoke` job runs the weakened command, all three auto-merge conjuncts hold → production deploy of
  an unverified artifact. Shipped form: "touches **nothing except** those two entries… **there is no
  third category**". Note the guard job's protected-path list and the "is this product code" list are
  **different sets and neither is a superset of the other** — M11 tracks the mechanical gap.
- 2026-07-22 (M9/M10): **"not guard-protected" is not a licence.** Guard-protection and records-only
  are orthogonal axes; conflating them is this rulebook's recurring defect. It appeared twice (the
  step-8 micro-retro's "fix it in this same PR when trivial (those files are not guard-protected)"
  and the step-6 machinery sentence), each time letting an unreviewed post-QA edit to `.claude/*` —
  including the definition of the gate agent itself — ride onto an already-verified PR.
- 2026-07-22 (M9/M10): **`Never X. Exception — Y.` grammatically attaches the carve-out to the
  prohibition**, even when Y is about something else entirely. Caught in `qa-verifier.md` (where the
  scratch-mutation exception scoped over "never weaken a test"), fixed, then immediately RE-CREATED in
  `implementer.md` in the next round. Landed remedy pattern: exceptions as sub-bullets explicitly
  labelled as narrowing *the obligation*, then the prohibition in its own paragraph headed "Standing
  on its own, narrowed by neither of the above… admits **no** exception, in any tree".
  `grep -rn "Exception —" .claude/ docs/bootstrap-org-prompt.md` returning no hits is a cheap standing
  structural check whenever the org's prose changes.
- 2026-07-22 (M9/M10): the single amend boundary across the org's docs is **QA dispatch** — amending
  after QA orphans the verified SHA, so the PR's cited evidence becomes unresolvable (`fatal: bad
  object`), not merely stale. The implementer never pushes, so a QA-verified SHA is remote-unreachable
  until Operations pushes *that commit itself*. The org merges with `--squash`, so the verified SHA is
  never on `main` — post-merge reconciliation goes via `refs/pull/N/head` or tree equality (M13).
- 2026-07-22 (M9/M10): duplicated snippets across `.claude/*` files need a drift tripwire — the QA
  recipe is intentionally byte-identical in `SKILL.md` and `qa-verifier.md` (sha1
  `ba27a041aaf037086be5c0f17b215494bb6ca4dc` at f927b9c). But byte-identity is wrong for any line
  carrying a cross-reference: `# see step 3's commit rule` pointed into SKILL.md while `qa-verifier.md`
  has its own step 3 (`npm run boot-check`) — a reader of the agent file alone resolves it wrongly.
- 2026-09-23 (S22): three SDK shapes for the drill-through demo, MCP-verified against the **pinned
  1.49.0** (all three available at that version — do not re-derive them from memory):
  `CustomAction.dataModelIds = { modelIds?: string[], modelColumnNames?: string[] }`, allowed on
  `VIZ`/`ANSWER`/`SPOTTER` targets only, with column entries formatted **`'<modelGuid>::<columnName>'`**
  — that `::` join is the whole mechanism behind "this action shows on one column and nowhere else"
  (needs SDK 1.43.0+ / 10.14.0.cl+, same gate as `customActions` itself).
  `EmbedEvent.VizPointClick` delivers `payload.data.clickedPoint.selectedAttributes[]` **and**
  `.selectedMeasures[]`, each `{ value, column: { name } }` — the measures half is what makes a
  KPI-vs-row-count reconciliation possible from a click alone.
  `HostEvent.GetFilters` **returns a promise directly** and takes no callback argument (unlike most
  HostEvents) — `await embed.trigger(HostEvent.GetFilters)`; items come back as
  `{ column, operator, values, applicable_viz, linking }`, i.e. `column`, not `columnName`, so they
  need mapping before they can be passed as runtime filters.
- 2026-09-23 (S22): `POST /api/rest/2.0/searchdata` was already called (`aiSearchData`) but through the
  **direct** `api()` path, so it was CORS-blocked under cookieless trusted auth and silently
  unusable there. Any new REST call the app makes should default to `apiRest()` (auto-relays when a
  bearer is set) **and** be added to `REST_RELAY_ALLOW` in `server.js` — the two must change together
  or the call works in browser-session auth and fails in trusted auth, which is the mode most demos run.
- 2026-09-23 (S22): COMPACT `data_rows` are **arrays aligned to `column_names`**, not objects — any
  new row renderer needs a name→value mapping step before it can do placeholder substitution or
  column lookup. `available_data_row_count` is the full match count (not the page size), which is what
  makes `record_offset` paging and a row-count reconciliation badge possible from one response.
- 2026-09-24 (S22, found by the first LIVE run): **`available_data_row_count` is NOT the total.**
  The REST v2 `searchData` response schema documents it as "Total available data row count", but on
  `ps-internal` (26.8.0.cl) it comes back **equal to `returned_data_row_count` on every page** —
  `record_size` 3/10/100/1000 all returned `available == returned == record_size`, and a request at
  `record_offset: 90` still said 100. It only drops below the page size when the result genuinely
  runs out. So: a FULL page tells you nothing about the total, and any `loaded < available` paging
  predicate silently stops after page one. The reliable end-of-data signal is a **short page**.
  `js/app.js dtKnownTotal()` encodes the safe reading: trust a reported total only when it exceeds
  what you already hold, otherwise treat a short page as "that's all" and a full page as "unknown".
  The pre-existing `aiSearchData` consumer inherits the same wrong assumption — filed as S24.
- 2026-09-24 (S22, process): the headless probe for this feature **passed while the code was wrong**,
  because the probe's own fixture hard-coded `available_data_row_count: 3` — i.e. the fixture asserted
  the author's assumption about the upstream contract rather than the contract. A stub can only test
  the code against the fixture's beliefs. Rule of thumb: whenever a fixture encodes an upstream
  response shape, the value chosen must come from an observed real response, and the probe should
  cover the awkward case (here: a full page, where total and page size are indistinguishable).
- 2026-09-25 (S22, found by the first LIVE click test): **a TABLE right-click reports the row's
  attributes in `deselectedAttributes`, not `selectedAttributes`** — and `contextMenuPoints` is an
  OBJECT (`{clickedPoint, selectedPoints}`), not the array the old extractor assumed. Verified on
  26.8.0.cl by right-clicking a `Total Sales Amount` cell on a TABLE_MODE viz: `selectedAttributes`
  came back `[]` while `deselectedAttributes` held `Employee Name='Lynn Tsoflias'`,
  `Territory='Pacific'`, `Day(Order Date)='1769644800'`, and `selectedMeasures` held the clicked
  `Total Sales Amount`. `deselectedMeasures` held the row's OTHER measures, mostly `'{Null}'` — so
  never fall back to it for "the measure the user clicked". CHART clicks are different: there
  `selectedAttributes` IS populated (a bubble/bar click carried Territory + Product), so the
  deselected fallback must be conditional on selectedAttributes being empty. Encoded in
  `clickedPoints()` / `clickedAttributes()` / `dtClickedMeasure()` in app.js. Symptom when wrong:
  the detail query loses its scope entirely and silently returns the whole model.
- 2026-09-25 (S22): `dataModelIds.modelColumnNames` matches the column's **display name as the viz
  shows it**, not the underlying model column. `'<modelGuid>::Total Sales Amount'` put the action in
  the right-click menu of that column; the model's own column is named `Sales Amount`. Confirmed
  live — the menu read Filter · Drill down · Show underlying data · SpotIQ analyze · Copy to
  clipboard · **View orders**.
- 2026-09-25 (S22, driving the embed in tests): ThoughtSpot renders each Liveboard tile as a `div`
  whose **`id` is the viz GUID** (`#c27c6f29-…`), which is a far steadier hook than tile titles or
  `data-testid`s. Its context menu does NOT use `role="menuitem"` — match menu entries by exact leaf
  text instead. Tiles render lazily, so `scrollIntoView` + retry before looking for marks/cells.
  Puppeteer reaches into the cross-origin TS iframe fine (`page.frames()` → `evaluateHandle` →
  `ElementHandle.click()`), so a full live click-path test is possible without any TS-side setup.
- 2026-09-25 (S22, found by reviewing a real screenshot): a drill-through must carry **every**
  attribute on the clicked point, not one. The clicked measure on a table is the intersection of all
  its attribute columns — `Employee Quota Achievement` is Employee × Territory × Day, so scoping the
  detail query to Employee alone returned ~10× the rows and the number could never reconcile. Two
  ThoughtSpot syntax facts make the full scope work:
  (a) bucketed attributes come back wrapped — `Day(Order Date)` — and the wrapper must be stripped
      before use as a search token (`[Order Date]`), or the query is rejected as "Bad tokens";
  (b) the date literal ThoughtSpot's search parser accepts here is **`MM/DD/YYYY`**. Verified on
      26.8.0.cl: `[Order Date] = '01/29/2026'` → 178 rows summing to exactly the clicked KPI, while
      `'2026-01-29'` and bare `2026-01-29` both 400, and `[Order Date].daily = '2026-01-29'` silently
      returned the WRONG rows (200 rows, different sum) rather than erroring. That format is
      locale-shaped — a non-US cluster may need DD/MM/YYYY.
- 2026-09-25 (S22): **which reconciliation is correct depends on the measure.** A count measure
  ("57 Conversations") reconciles against the detail ROW COUNT; a sum ("Total Sales Amount") never
  will — it reconciles against the SUM of the matching detail column. `dtReconcile()` picks
  automatically: if a detail column carries the same name as the clicked measure, add it up,
  otherwise count rows. Getting this wrong doesn't just look odd — it flashes a false mismatch
  warning on a demo that is actually correct.
