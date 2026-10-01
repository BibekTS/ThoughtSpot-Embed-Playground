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
- 2026-09-25 (S22, correcting an earlier entry): **`dataModelIds.modelColumnNames` scopes a custom
  action to a VISUALIZATION, not to a column.** The doc wording is "displayed only on visualizations
  that are created using the specified modelColumnNames", and live behaviour matches: with the action
  scoped to `'<guid>::Total Sales Amount'`, right-clicking the neighbouring `Total Sales Amount Quota`
  cell on the same table still shows it. An earlier entry here implied per-cell targeting — it is not.
  Consequence for any drill-through: never take "the measure the user clicked" as the measure the
  feature is about. Look up the CONFIGURED measure across `selectedMeasures` ∪ `deselectedMeasures`
  on the clicked point and prefer that; on this Liveboard the quota column is `{Null}`, so taking the
  clicked cell produced a modal titled "Total Sales Amount Quota: {Null}".
- 2026-09-25 (S22): a "✓ reconciled" marker must be gated on a comparison having actually HAPPENED —
  numeric measure, paging settled, values equal — not merely on paging being finished. The first cut
  showed ✓ next to a `{Null}` KPI, which is worse than showing nothing: it asserts a check that was
  never performed.
- 2026-09-25 (tooling): the SpotterCode MCP `execute-thoughtspot-code` session is pinned to the
  **Primary** org and there is no way to move it — `/api/rest/2.0/auth/session/org` (POST and PUT),
  `/api/rest/2.0/auth/orgs/switch` and `/callosum/v1/tspublic/v1/session/orgs/update` all 404, the
  `x-requested-orgid` family of headers is ignored (400), and `/callosum/v1/session/orgs/update`
  400s on every body shape tried. Objects in another org return "Logical Table not found". For
  ps-internal content living in the `Bibek` org, verify through the playground's own
  `/api/ts-rest` relay instead — same cluster, same user, correct org.
- 2026-09-25 (S22, precise): **ThoughtSpot reports the exact CELL, not just the row.** Captured live
  on 26.8.0.cl by right-clicking two cells of the same table row:
  clicking the `Total Sales Amount` cell → `selectedMeasures=[Total Sales Amount 134280.9824]`,
  `selectedAttributes=[]`, `deselectedAttributes=[Employee Name, Territory, Day(Order Date)]`,
  `deselectedMeasures=[Quota, Quota %]`.
  Clicking the `Employee Name` cell on that same row → `selectedAttributes=[Employee Name
  'Lynn Tsoflias']`, `selectedMeasures=[]`, `deselectedAttributes=[Territory, Day(Order Date)]`,
  `deselectedMeasures=[all three measures]`.
  So the rule is: **`selected*` is the cell that was clicked; `deselected*` is the rest of that row;
  their union is the full row.** That is why a measure-cell click leaves selectedAttributes empty —
  no attribute was the target. Anything needing "the whole row" must read both buckets; anything
  needing "what did they actually click" reads `selected*` alone.
- 2026-09-25 (S22, click matrix, verified on 26.8.0.cl): **left-click and right-click are not two
  routes to the same menu.** Observed on both a table cell and a chart mark, with VizPointClick
  subscribed: a LEFT click fires `EmbedEvent.VizPointClick` immediately and ThoughtSpot shows **no
  menu**; a RIGHT click fires **no host event at all** and opens ThoughtSpot's own menu (Filter,
  Drill down, Show underlying data, SpotIQ analyze, Copy to clipboard) with the custom action
  appended, and `EmbedEvent.CustomAction` fires only once the user picks that item. An earlier note
  and the inspector hint claimed left-click also raises ThoughtSpot's menu; it does not, at least
  while VizPointClick is subscribed. Practical consequence: left-click is one gesture to the panel,
  right-click is two, and right-click leaves ThoughtSpot's own actions reachable.
  `payload.data.vizId` is present on VizPointClick for both viz types, so scoping a drill to one
  visualization is reliable (confirmed: a left-click on the table did not drill while the drill was
  pinned to the chart).
- 2026-09-25 (S29–S32, this PR): **the SDK-code generator had no mechanical link between what it
  EMITS and what it IMPORTS.** `generateCode()` built `importNames` from a hand-written list of
  conditions (`js/app.js:6345-6360`) while the emitters are hundreds of lines further down, so the
  drill-through section emitted `CustomActionsPosition.CONTEXTMENU`, `CustomActionTarget.VIZ`,
  `HostEvent.GetFilters` and `RuntimeFilterOp.IN` that were never imported — a `ReferenceError` on
  the first paste. The fix is the gating PLUS a generator-wide gate:
  `runCodeGenImportProbe()` in `scripts/boot-check.mjs` walks every rail item, extracts the SDK
  identifiers from each emitted body (comments stripped) and asserts each one appears in that same
  snippet's import line. Any NEW emitter that reaches for an SDK name now fails the gate unless the
  import gating is updated with it. Corollary learned while writing it: a helper emitted
  unconditionally must not reference a conditionally-imported name — `tsFilter` (which uses
  `RuntimeFilterOp`) had to move inside the point-drill branch.
- 2026-09-25 (S30/S31): **a clicked attribute is NOT a carryable runtime filter, and not a search
  token either.** ThoughtSpot reports a bucketed date as `Day(Order Date)` / `Month(Order Date)`
  with a RAW EPOCH value, so three separate coercions are needed and they differ by destination:
  (a) carrying into another Liveboard needs the UNWRAPPED column and NUMERIC epochs — a string
  epoch on `Day(Order Date)` matches nothing and loses the day scope silently;
  (b) a non-Day bucket must become a RANGE, but **the two destinations do not agree on which
  buckets can express one.** A RUNTIME FILTER carries epoch seconds, so `BW_INC` over
  [bucket start, bucket end] (UTC) works for ANY bucket, sub-day included. A SEARCH CLAUSE is
  limited to `MM/DD/YYYY`, which is day-granular — so only Week/Month/Quarter/Year become a range
  (`[Order Date] >= '12/01/2024' [Order Date] <= '12/31/2024'`, two space-joined clauses) and
  Hour/Minute/Second fall back to the plain day-equality clause, the widest true statement the
  literal can make. Emitting only the bucket's start lists the 1st of the month while the KPI covers
  the whole month, and `dtReconcile()` then flags a mismatch that is not real;
  (c) DISPLAY wants the ISO day. `dtBucket`/`dtEpochSec`/`dtBucketEndSec`/`dtMDY`/`dtCarryFilter`
  in `js/app.js` encode all of this; `dtSearchColumn()` is now just `dtBucket().column`.
  Consequence for any column comparison: normalise BOTH sides — a user configuring `scopeColumn`
  types `Order Date` while the click reports `Month(Order Date)`.
- 2026-09-25 (S32): **every `await` in the drill-through path is a suspension point over
  module-level state.** `dt` (the active detail view) is REPLACED wholesale by `openDetailPanel`,
  so `dtFetchPage`'s post-await `if (!dt) return` was not enough — a slow first click's rows landed
  in a second click's panel. The pattern that fixes it is `const mine = dt` before the await and
  `if (dt !== mine) return` after, and the same shape applies to `__onVizPointClick` around
  `await embed.trigger(HostEvent.GetFilters)` (capture `currentEmbed`, then re-check the embed ref,
  `getState().section` and `drillParent` before navigating). A boot-check leg with a deliberately
  SLOW first response and a fast second is what proves it; asserting only on the final row count
  passes either way, so assert on the first row's IDENTITY.
- 2026-09-25 (regression guard): **`EmbedEvent.VizPointClick` was subscribed on EVERY embed**
  (`js/embed.js`). Subscribing it makes a LEFT click fire the host event and ThoughtSpot show no
  menu of its own, so plain Liveboard/Viz/Search embeds silently lost their native left-click
  behaviour. It is now opt-in via `config._vizPointClick`, set in `buildConfig()` only for
  `section === 'drillthrough' && drill.enabled` and explicitly cleared in `enterDrill()` (a click
  inside the DETAIL board is not a new drill). `_vizPointClick` is a derived CONFIG field, not a
  state key — no `js/state.js` change, so the PR stays off the guard-protected paths.
- 2026-09-25 (S29 review): in `js/embed.js`'s constructors the explicit ids
  (`liveboardId`/`vizId`/`answerId`/`hideSearchBar`) now spread AFTER `...flags`, so a shared
  link's flags cannot re-point an embed at a different object. The `search`/`spotter` cases still
  spread `dataSources`/`worksheetId` BEFORE `...flags` — same latent shape, not yet closed.
- 2026-09-27 (S29–S32 round 2, review): **a bucket-end calculation must enumerate EVERY bucket the
  range branch fires for.** `dtBucketEndSec` folded Hour/Minute/Second into the `day` arm while the
  caller ranged over every non-day bucket, so an `Hour(Order Date)` click scoped the detail set to a
  whole day — 24x too wide, 86400x for `Second(...)` — producing exactly the false `dtReconcile`
  mismatch the range work was written to remove. The generated snippet's `tsBucketEnd` twin had the
  identical hole: **an emitted helper is a SECOND implementation and drifts silently**, so every
  round-2 fix here had to be applied twice and is now cross-checked (runtime vs emitted) rather than
  eyeballed.
- 2026-09-27 (S30 round 2): **the epoch magnitude window (1e8..1e11) is a heuristic for "is this
  integer a date at all", not a validity test.** It starts at 1973-03-03, so zero, negatives and
  every earlier date failed it and were carried on as STRING epochs that ThoughtSpot silently
  ignores. When ThoughtSpot has already wrapped the column in a `Day(...)`/`Month(...)` bucket the
  column IS a date and the heuristic is not merely unnecessary but harmful — hence
  `dtEpochSec(v, known)`. The millisecond window still applies on the proven path (1e11..1e14
  SECONDS would be the year 5138+, never the intended reading). `cfbFmtDate` (`js/app.js:4868`) has
  the same blind spot and was deliberately NOT widened: it is the custom-filter-bar's display
  heuristic, and accepting any integer there would render a plain count column named "day count" as
  1970-01-01. `dtMDY` therefore formats from epoch seconds itself instead of routing through it.
- 2026-09-27 (S29 round 2, the sharpest one): **`state.js` does not key-whitelist `flags`** —
  `cleanMap(raw.flags, sectionFlags => cleanMap(sectionFlags, …))` (`js/state.js:308-309`) keeps ANY
  key name under a 200-char cap. So a shared link can carry `flags.<section>.liveboardId`. Wherever
  flags and explicit ids are merged, the two must agree on which wins: `doRender` spreads the ids
  AFTER `...flags` (so the picked object wins), and the code generator emitted the ids BEFORE its
  flags loop (so the later duplicate key won) — the tool rendered the picked board while generating
  a snippet aimed at the attacker's. The fix pins the id keys per section out of the generator's
  flags loop, in lockstep with the constructors in `js/embed.js`. Note the pinned set is
  section-dependent: `vizId` is NOT spread after flags for the plain `liveboard` case, so a flags
  `vizId` legitimately reaches that embed and the snippet must keep matching it.
- 2026-09-27 (S32 round 2): `enterDrill` must call `dtClosePanel()` — `render()` already does
  (`js/app.js:684`). Without it a drill navigation leaves the PARENT board's detail panel mounted
  over the DETAIL Liveboard, and an in-flight `dtFetchPage` writes into it perfectly legitimately
  (`dt === mine`, so the S32 staleness guard cannot catch this one — closing the view is what makes
  the guard fire).
- 2026-09-27 (gates, round 2): **a probe that SKIPS what it cannot check silently loses teeth.**
  `runCodeGenImportProbe` returned `null` for a snippet with no SDK import line and passed on
  `checked > 0`, so a code-view regression in any one section would merely lower the count and stay
  green. The fix is a closed expectation: an explicit `NON_SDK_SECTIONS` allow-list of the two
  host-side (REST/MCP) sections, and any OTHER section that emits no SDK import is a failure. Same
  shape as the governance lesson that rules partitioning a repo must be allow-lists.
- 2026-09-27 (S31, UNVERIFIED — the one thing this work cannot self-certify): the bucket range
  clause `[Col] >= 'MM/DD/YYYY' [Col] <= 'MM/DD/YYYY'` is **extrapolated** from the confirmed
  single-day form. It is unverified against a live cluster, and this parser's failure mode is not an
  error — `[Order Date].daily = '…'` returned HTTP 200 with the WRONG rows. `dtFetchPage` therefore
  treats an EMPTY first page from a range clause as "not understood": it retries once with the
  bucket-start day clause and logs the downgrade (`rangeDowngraded` on the view, so it happens at
  most once and subsequent pages keep the downgraded form). A live `Month(...)` click is still
  needed to confirm the syntax; if it is rejected, the fallback is a per-day `IN` list.
- 2026-09-27 (S22, answering a customer's open question): **`EmbedEvent.VizPointClick` does NOT fire
  for a Muze Studio custom chart.** Tested on 26.8.0.cl against two MUZE_STUDIO vizzes: the chart
  renders in its own nested iframe (`hc-muze-studio.pdom.thoughtspot.com`), two levels below the host
  page, and the ThoughtSpot tile's own DOM contains zero marks. Clicking a real mark inside that
  nested frame (18 marks present) produced **no** VizPointClick on the host. Native chart types and
  table cells both fire it (verified separately), so the rule is: point-click interception works for
  ThoughtSpot's own chart types, not for BYOC/Muze Studio charts. A custom-chart author can of course
  emit their own postMessage, but nothing arrives through the SDK event by default.
- 2026-09-25 (S10, P1 credential exfiltration — fixed on this branch): **SDK `init()` authenticates
  IMMEDIATELY; no embed render and no click are required.** On the pinned 1.49.0, calling
  `init({authType: TrustedAuthTokenCookieless, autoLogin: true, getAuthToken})` makes the SDK invoke
  `getAuthToken` at once — which is `fetchTrustedAuthToken` (`js/embed.js:71`, POST `/api/auth/token`
  on the victim's OWN token server, minting a real token for the default user) — and then GET
  `${thoughtSpotHost}/callosum/v1/session/isactive` with `Authorization: Bearer <token>`;
  `TrustedAuthToken` mints and POSTs `${host}/callosum/v1/session/login/token`. So `initSDK()`
  (`js/embed.js:104`, which guards only on an empty host) is a **credential sink**, not a passive
  configuration step: any `applyConfig()` reached while a `#s=`-supplied host is unconfirmed hands
  an attacker a live token with zero clicks. `applyConfig()` (`js/app.js`) now short-circuits before
  `initSDK` while `pendingHostConfirm`; `buildConfig()` still runs so the code generator stays live.
  Corollary: `pendingHostConfirm` must be cleared by the Confirm click ALONE — `connect()` used to
  clear it for every caller, so `onTokenApplied`'s `connect({silent:true})` was a second route to
  the same sink. (That one is NOT clickless — it needs the user to click "Mint & apply" in the
  trusted-auth modal — but it clears the confirm state without the confirm gesture, so the modal is
  now blocked outright while `pendingHostConfirm`.)
- 2026-09-25 (S10, gates): **both gate servers run with `TS_SECRET_KEY=''`, so anything
  mint-dependent 503s and a probe that merely asserts "no token leaked" passes vacuously.** A probe
  covering a mint path MUST stub the route — puppeteer `setRequestInterception(true)` +
  `r.respond({body: JSON.stringify({token:'FAKE-TOKEN'})})` on `POST /api/auth/token` — and pair it
  with a positive control that the mint DOES happen once the guard is satisfied
  (`runPreauthExfilProbe` in `scripts/boot-check.mjs`). Same interception answers the attacker host
  (`https://evil.invalid` does not resolve, so without a stub the SDK's calls die in DNS and the
  negative assertion is again vacuous).
- 2026-09-25 (S10): `holdHostPersist()` (`js/state.js:150`/`:159`) blanks **only `host`** from
  localStorage; the rest of an unconfirmed link payload (`authType`, `auth.username`/`orgId`,
  `styles.cssUrl`) was still written and outlived a dismissed link. `js/state.js` is guard-protected,
  so the hold is completed from `js/app.js` (`holdAllPersist()`): snapshot the pre-link
  `tsp_state_v1` entry and restore it ~400ms behind `schedulePersist()`'s 250ms debounce on every
  50ms poll until Confirm. **This is a write-then-revert, not a suppression — the payload IS
  briefly in `localStorage`, and a tab closed inside one poll interval of a persist leaves the
  attacker's `authType`/`auth.username`/`styles.cssUrl`/`customActions` (host blanked) behind, to be
  applied against the victim's OWN host on their next visit.** The first cut restored on a
  `subscribe()` callback at +400ms against `schedulePersist`'s +250ms write, i.e. a ~150ms exposure
  window; polling shortens it but cannot close it. Polling is also required for correctness:
  `setState(patch, {silent:true})` (`js/state.js:132`) skips `notify()` but still calls
  `schedulePersist()`, so a `subscribe()`-driven restore never fires for a silent write (only
  `persistCfb()` is silent today, and it is not reachable pre-confirm — latent trap). The real fix
  is to generalise `_holdHostPersist` (`js/state.js:159`) to omit the whole payload instead of just
  `host`; that is a guard-protected change. Note the storage-key constant is now duplicated in
  `js/app.js` (`LS_STATE_KEY`) — it must stay in lockstep with `STORAGE_KEY` (`js/state.js:20`).
- 2026-09-25 (S10 review, a SECOND zero-click host contact the first fix missed): gating
  `initSDK()` is not sufficient — **`renderInspector()` also runs at boot while
  `pendingHostConfirm`** (`js/app.js`, right after the confirm state is computed), and
  `sectionObject`'s `needs === 'viz'` branch auto-fired `loadViz()` → `Discovery.discoverViz` →
  a `credentials:'include'` POST `${host}/api/rest/2.0/metadata/liveboard/data`, with no
  `connected &&` fence — unlike the standalone-Answer auto-load ~25 lines below, which S3 had
  fenced. A link encoding `{host, section:'viz', liveboardId}` (both fields survive sanitize)
  therefore shipped the visitor's cookies to the attacker's host with zero clicks. **Rule: every
  auto-loader reachable from `renderInspector()` needs the `connected &&` fence**, because
  `connected` is the only flag that is provably false pre-confirm (set only in `connect()`, after
  `pendingHostConfirm=false`). Swept the other inspector sections at the time of the fix: the
  remaining discovery calls (`refreshPersonalCopies`, the export/CFB/AI-Insights REST calls) are all
  behind explicit user gestures.
- 2026-09-25 (S10 review, why the probes missed it): **a negative security probe is only as strong
  as the state its fixture reaches.** All three pre-existing pre-confirm probes defaulted to
  `section:'search'`, and the one that did use `{section:'viz'}` omitted `liveboardId` — precisely
  the input that makes `loadViz()` return early at its first line. The probe passed against
  genuinely vulnerable code. When a fence guards a lazy loader, the fixture must carry whatever
  makes that loader *actually run*, and the probe should assert on ANY request to the host, not
  only on the one path the author had in mind.

## Hygiene / a11y / CSS (S41, 2026-09-25)

- 2026-09-25 (S41): **`INSTRUCTIONS.md` cannot be deleted.** `scripts/smoke-test.mjs` probes that
  `/INSTRUCTIONS.md` is NOT statically served; removing the file makes that assertion vacuous (a
  missing file 404s trivially), and `smoke-test.mjs` is guard-protected, so the probe cannot be
  re-pointed without a human `human-approved` PR. Keep the file, or move the probe and the file in
  one human-labelled PR. It still contains a real instance hostname + GUIDs.
- 2026-09-25 (S41): `node --test lib/spotter-mcp/` **fails on Node 22** with
  `Cannot find module …/lib/spotter-mcp` — a directory argument is resolved as a module specifier.
  Use `node --test 'lib/spotter-mcp/*.test.mjs'` (23 pass). Separately, `npm run test:spotter-mcp`
  runs **only** `customize.test.mjs`, so `router.test.mjs` is in no gate at all (that is M15).
- 2026-09-25 (S41): of the 36 `.aip-*` rules in `css/styles.css`, exactly 14 class names are dead;
  the other 22 are built at runtime by the AI Insights panel via `el()` in `js/app.js`. "The aip
  block is dead CSS" is **false** — check each class name, not the block.
- 2026-09-25 (S41): `var(--warn, …)`, `var(--danger, …)` and `var(--success, …)` fallbacks were
  removable because `:root` defines all three. `var(--err, #c0392b)` in `.flow-step.failed .fs-dot`
  is **not** — `--err` is defined nowhere, so that fallback is load-bearing. Left in place.
- 2026-09-25 (S41): `index.html` now ships `<link rel="icon" href="data:,">`, so the browser never
  requests `/favicon.ico`, and `scripts/boot-check.mjs`'s favicon 4xx exemption is **removed** — the
  gate now fails on ANY 4xx/5xx. Verified on a private port (45301, clean env): 0 responses >= 400,
  0 JS errors. **`CLAUDE.md` is now stale on this point** (it still says "no non-favicon 4xx … the
  only allowed console 404 is `/favicon.ico`"); it is guard-protected, so a human PR must fix it —
  filed as **M19**.
- 2026-09-25 (UX O8/O9): `--accent` (`#00c9de`) is **2.02:1 on white** — it is a fill colour, not
  an ink. Every accent-coloured label in `css/styles.css` failed WCAG AA, and the `:focus-visible`
  rule added by S41 (`outline: 2px solid var(--accent)`) failed the 3:1 non-text floor of WCAG
  1.4.11 too. `css/styles.css:23-24` now defines `--accent-ink: #067a87` (5.07:1 on `#fff`,
  4.65:1 on `--accent-soft`, 4.82:1 on `--bg`, but only **4.45:1 on `--surface-3` `#eaf1f7`** — do
  not put accent text there) and `--accent-2-ink: #4f46e5` (6.29:1). Rule, now in `THEME.md` §8:
  **`--accent` paints, `--accent-ink` writes.** Roughly 50 further `color: var(--accent)` sites
  remain in the sheet (`.st-link`, `.lr-type`, `.wh-*`, `.cfb-*`, `.flow-lane`, `.badge-good`, …) —
  same defect, not yet converted; that is a follow-up.
- 2026-09-25 (UX O2/O5): `#topbar` is a single non-wrapping, non-scrolling flex row inside
  `body{overflow:hidden}`, so anything that does not fit is **unreachable**, not scrolled to. Two
  independent failures came out of that: at 390px `#connect-btn` sat at x=411 off-screen, and at
  1440px-connected the utilities wrapped inside their fixed 30px height. The fix needs BOTH halves
  or it just moves the overflow: `.tb-right{flex:0 0 auto}` + `.tb-icon-btn{white-space:nowrap}`
  stops the wrap, but then `#conn-status` (which was `flex:0 0 auto` with `max-width:440px`) pushes
  the whole right cluster past the viewport edge. `#conn-status` must be `flex:0 1 auto` with a
  `min-width` floor (`css/styles.css:134`). Measure `#reset-btn`'s `getBoundingClientRect()
  .right <= innerWidth`, not just `scrollWidth`.
- 2026-09-25 (UX O1): the inspector can be a mobile drawer with **zero JS**. `index.html:17-19`
  puts a visually-hidden checkbox as the first element in `<body>` (NOT `hidden` — `[hidden]` is
  `display:none !important` in this sheet, which kills focusability) and a `<label for=…>` in the
  topbar's `.tb-right`; `.mobile-opt-cb:checked ~ #app #inspector` then wins on specificity over
  the `@media (max-width:860px) { #inspector{display:none} }` rule. The checkbox must stay a
  *preceding sibling of `#app`* for that combinator to work. Keyboard focus lands on the invisible
  checkbox, so the ring is painted on the label via
  `.mobile-opt-cb:focus-visible ~ #app .mobile-opt-btn`.
- 2026-09-25 (UX O1, follow-up): the onboarding copy in `index.html` says "in the options panel
  **on the right**", which is wrong once the panel is a bottom sheet. The `st-needs` variant of
  that string is generated in `js/app.js`, so both must change together in a JS pass — not done
  here (CSS/HTML-only scope).
- 2026-09-25 (UX O11): `index.html` had **zero** `h1`–`h4`. The static overlay titles, inspector
  title and modal titles are now real `<h2>`s and the wordmark an `<h1>`; `.tb-name` needed
  `font-size/font-weight/line-height: inherit` added (`css/styles.css:113`) because the UA
  `h1` sizing would otherwise blow up the 14px brand scale. `js/app.js` still builds two
  `.modal-title` **divs** (`js/app.js:2793`, `:2996`) — those stay unheaded until a JS pass.

## In-flight fences / async races (S33)

- 2026-09-25 (S33, this PR): `connect()` (`js/app.js:488`) is the THIRD site of the same defect
  class as S3/S11 and the widest: it awaits `discoverOrg` then `discoverObjects` and writes four
  module globals (`connected`, the status pill, the overlay, `discovered`). It is now fenced with a
  monotonic `connectSeq` ticket (`js/app.js:210`) plus the captured-host check, evaluated as
  `isStale()` after EVERY await (`:507`, `:544`). The ticket alone is not enough and the host check
  alone is not enough — a second connect to the SAME host also needs the seq. `loadAnswers()`
  (`js/app.js:2401`) keeps its host-only fence; it is idempotent per host, `connect()` is not.
- 2026-09-25 (S33, boot-check): a race probe does NOT need a cross-origin stub. Point both "hosts"
  at SAME-ORIGIN paths on the gate's own server (`${BASE}/s33a`, `${BASE}/s33b`) — `validHost()`
  (`js/state.js:188`) accepts them (scheme + `new URL` only, no host shape), so plain puppeteer
  request interception can stub `/api/rest/2.0/auth/session/user` and `/metadata/search` with no
  CORS headers and, crucially, no preflight — a cross-origin stub needs an OPTIONS response that
  CDP interception does not reliably surface. `discovered.worksheets` is observable by clicking the
  "Worksheet / Model" `.sel-btn` (the `.sel-item` list renders lazily on open).

## Code execution in the UI (S37)

- 2026-09-25 (S37, FIXED, this PR): the custom-styles paste box ran `new Function` on pasted text
  (`parseRulesObject`, formerly `js/app.js:4106`) — arbitrary JS in the page's origin, with no CSP
  anywhere in the repo to fall back on. Replaced by `jsObjectLiteralToJson()` + `JSON.parse`
  (`js/app.js:4102-4211`): a hand-written tokenizer for the tolerant JS-literal grammar (single
  quotes, bare identifier keys, trailing commas, `//` and `/* */` comments), values restricted to
  string / number / true / false / null / nested object. The wrap-in-braces decision for a bare
  `rules_UNSTABLE: {…}` fragment MUST look past leading trivia (`skipTrivia`) — testing
  `text.startsWith('{')` wraps a paste that opens with a comment twice and rejects it.
- 2026-09-25 (S37): `grep -n "new Function" js/` returning only the explanatory comment is the
  standing check. Note the paste box was reachable without any ThoughtSpot contact at all — the
  boot-check probe just opens the "CSS rules (rules_UNSTABLE)" accordion on a host-free page.

## Gates (additions)

- 2026-09-25 (S33/S37): a port-shifted COPY of a gate script (`sed 's/const PORT = 34921;/…/'` into
  `scripts/boot-check.local.mjs`, run, delete) lets a worktree-isolated implementer verify and
  mutation-test frontend probes without touching the shared 34917/34921 ports (M8). Both scripts
  derive ROOT from `import.meta.url`, so the copy must live in `scripts/` of the same worktree.
  This is verification, never weakening: the committed gate scripts are unchanged by it.
- 2026-09-25 (S33/S37, mutation-proven): reverting `parseRulesObject` to `new Function` flips the
  S37 probe's "did NOT execute" AND "hostile paste rejected" to false; deleting the two `isStale()`
  lines flips the S33 probe's status and discovered-objects assertions (final pill read
  "USER_A · ORG_A", picker showed WS_A). Unlike the S13 `window.open` stub, the S37 `__pwned`
  assertion is NOT vacuous — nothing stubs the evaluator, so the flag really does get set.
- 2026-09-25 (S33/S37): the boot-check whole-run watchdog was raised 120s → 180s
  (`scripts/boot-check.mjs:55`) — the S33 probe deliberately holds a response 2.5s and then waits
  3.5s more, so it alone spends ~7s inside a budget that was already ~60% consumed.

## Detector / tooling

- 2026-09-25 (S34, FIXED): `scripts/check-ts-updates.mjs` pushed ANY `!r.ok` watched-doc response
  onto `changes`, so a transient 503/429 at developers.thoughtspot.com produced "CHANGES DETECTED"
  (exit 10) and sent the weekly cloud routine off to open a PR about nothing. Only 404/410 is drift
  now; everything else is a warning, matching the npm/GitHub branches. `main` is exported and the
  bottom-of-file invocation is guarded by an `import.meta.url === process.argv[1]` check so
  `scripts/check-ts-updates.test.mjs` (`npm run test:ts-watch`) can import it and stub global fetch.

## Client-side PDF / Spotter chat

- 2026-09-25 (S35): `groupStatements` in `js/invoice-pdf.js` keyed a plain `{}` by LIVE TS ROW DATA.
  A group value of `constructor`/`toString` makes the `if (!statements[key])` init test truthy
  (inherited member) and `__proto__` assignment is swallowed — one row's text aborted or corrupted
  the whole export. Now a `Map`. Any object keyed by TS row/column data in this repo is the same
  bug waiting to happen. `fetchAllRows` also gained a 50k row ceiling and an empty-page break.
- 2026-09-25 (S36): `js/spotter-mcp.js` `createLiveboard()` built its link base as
  `https://${tsHost}` while `js/app.js` passes an ALREADY-SCHEMED host — a relative `dashboard_url`
  resolved to `https://https/…`. The module already normalises the host once for `tsOrigin`
  (`js/spotter-mcp.js:196`); reuse it rather than re-deriving. Same file: the typing indicator is
  now removed in a `finally` (`ask()` delegates to `askTurn()`), and the relay-supplied
  `iframe_url` is scheme-checked before it reaches `frame.src` — an iframe src is a navigation sink
  in THIS document's context, same class as the S13 `window.open` hole.
- 2026-10-01 (S45): Spotter MCP `api-version` cutover, verified by `tools/list` against
  `https://agent.thoughtspot.app/token/mcp?api-version=X` on ps-internal: **beta, 2026-05-01,
  2026-06-01, 2026-09-01** → Spotter 3 set (check_connectivity, search_objects,
  create_analysis_session, send_session_message, get_session_updates, create_dashboard);
  **2026-04-01 and earlier** (2026-01-01, 2025-10-01, 2025-01-01) → legacy set ONLY (ping,
  createLiveboard, getDataSourceSuggestions, getRelevantQuestions, getAnswer) — connects fine,
  silently wrong toolset; **latest / 2026-10-01** → Spotter 3 set + preview model tools
  (create_model_session, send_model_message, get_model_updates, finalize_model; latest also
  get_data). ThoughtSpot docs recommend a DATED version for custom apps. By human decision
  both the relay default (`lib/spotter-mcp/mcp-client.mjs` `DEFAULT_MCP_URL`) and the generated
  snippet use `api-version=latest` (newest toolset; pin a date via `TS_MCP_URL` to freeze it). `.env.example` still claims "ONLY beta" (guard-protected, human follow-up).
- 2026-10-01 (PR #37 review): **z-index scale — modals 200 > mobile inspector 190 > toasts 150 >
  dropdowns 50/60**; only `.sel-panel`, `body::before` (1000) and `.demo-exit` (900) sit above.
  `.modal` is 200, NOT 1000. Any new full-window overlay (the full-screen bottom panel is 120) must
  stay below 150 or it hides the toasts and dialogs it can itself open. `highlightJs` was fuzzed
  (200k inputs) to preserve text exactly, so `#code-view.textContent === generateCode()` holds.
- 2026-10-01 (S45): the generated Spotter MCP snippet (`js/app.js` `spotterMcpCode`) set
  `frameEl.src = evt.iframe_url` — the EXACT bug a customer (Guidewire) hit: iframe_url carries the
  `tsmcp=true` marker and renders blank/unauthenticated as a raw src. It now emits `init()` (via the
  shared `sdkInitAuthLines(s, esc)`, also used by `generateCode`) + `startAutoMCPFrameRenderer()` and
  appends a FRESH marker iframe per answer. Sharp edge: the auto-renderer REPLACES your iframe
  element, so a kept reference is detached afterwards — `prev.replaceWith(next)` is a silent no-op.
  Replace through a per-answer container (`slot.replaceChildren(iframe)`), as `renderAnswer`
  (`js/spotter-mcp.js:340`) does via `card.querySelector('iframe')`. The same function's default
  output had never parsed (a `//` comment swallowed `JSON.stringify(...)`'s closing paren). **Rule:
  snippet code must mirror the app's own runtime path, and must be `node --check`ed** (filed M21).
- 2026-10-01 (S45): `scripts/boot-check.mjs` `importGapsIn` used `/import \{([\s\S]*?)\} from
  '@thoughtspot…'/`, which on a snippet that imports ANOTHER package first matched from that
  earlier `import {` to the SDK's and reported every SDK name as missing (false "missing import:
  init" for spotter-chat). Now `[^}]*` (one statement). spotter-chat was removed from
  `NON_SDK_SECTIONS`, so the gate now REQUIRES its SDK import. Mutation-checked: dropping `init` or
  `AuthType` from the snippet's import is reported; dropping the import line is an unexpected skip.

## Review-round corrections to the S33/S35/S37 work (2026-09-27)

- 2026-09-27 (S35, review must-fix): a row ceiling on a document that prints a **Total** is not a
  performance knob, it is a disclosure obligation. The first cut capped at 50k and only
  `console.warn`'d, while `fetchAllRows` returned `{rows, schema}` — so the per-region Total
  (`js/invoice-pdf.js:348`) and the "from N row(s)" success log (`js/app.js:5270`) were both computed
  over the capped set and read as complete: a 60k-row viz produced a financial-looking PDF
  understating revenue by ~10k rows behind a green success toast. Two comments actively claimed the
  opposite ("the export says so"). Now `fetchAllRows` returns `truncated`, `groupStatements(rows,
  schema, {truncated})` sets `totalLabel: 'Total (partial)'` + an "INCOMPLETE EXPORT — capped at N
  rows" footer line, and `handleInvoicePdf` logs ⚠ and raises an error toast. **Rule of thumb: a
  truncation that a downstream aggregate is computed over must travel in the RETURN VALUE; a console
  line is not a disclosure.** Verified: 60k-row fake service → rows=50000, truncated=true, printed
  total 50000 with the partial label on every page.
- 2026-09-27 (S37, review must-fix): the non-executing paste parser must accept **arrays**. Rejecting
  them was a real workflow regression, not a hardening win: `findRulesUnstable` (`js/app.js:4082`)
  exists precisely so a user can paste a whole customizations/ViewConfig wrapper, and those wrappers
  routinely carry `visibleActions:['save','edit']` / `hiddenActions` / `runtimeFilters` — every one of
  which `new Function` used to accept. Arrays are safe here because they leave through the same
  `JSON.stringify` → `JSON.parse` path as every other value; `readArray` adds no evaluation. An
  expression *inside* an array (`[(window.x=1)]`) is still refused. Lesson: when replacing an
  evaluator with a parser, enumerate what the evaluator ACCEPTED, not just what it must now refuse.
- 2026-09-27 (S33, review must-fix — the fence's real boundary): fencing `connect()` was not enough
  because the last thing `connect()` does is **fire-and-forget** `refreshPersonalCopies()`
  (`js/app.js:5654`, launched at `:553`), which has its own two unfenced awaits and writes both module globals
  (`currentUserLogin`/`currentUserName`) and PERSISTED state (`setState({personalLb.copies})`).
  Connect A → switch to B before A's `getCurrentUser` returns → host A's login lands in the live
  host-B session, which then scopes its owner-filtered tag search to A's login (the cross-user leak
  its own comment warns about), and A's copy GUIDs get persisted to localStorage and serialised into
  B's share link. **A fence stops at the function boundary; every fire-and-forget launched from
  inside it needs its own.** `refreshPersonalCopies` now carries the same `connectSeq` + captured-host
  `isStale()` check after each await. Its `finally` clears `plbDiscovering` unconditionally by
  design — gating that on `!isStale()` strands the spinner forever when the newer connect returns
  early (host B with no `liveboardId`).
- 2026-09-27 (S34, review must-fix, EMPIRICALLY CONFIRMED): an `import.meta.url` vs `process.argv[1]`
  direct-run guard **must realpath both sides**. Node resolves symlinks for the ESM module path but
  NOT for `argv[1]`, so a symlinked invocation makes them disagree and the guarded block never runs:
  measured `OLD guard (path.resolve equality): false` / `NEW guard (realpathSync equality): true` for
  `node <symlink-to-script>`. For a detector that is the worst possible failure — `main()` never
  runs, the process exits **0**, and the weekly routine reads that as "no drift" while the check has
  gone blind. `scripts/check-ts-updates.mjs` `invokedDirectly()` realpaths both and fails OPEN to
  running: a spurious run is harmless, a spurious skip is undetectable.
- 2026-09-27 (S35): `console.warn(..., d)` where `d` is a live response object is a customer-data
  leak into devtools, screen shares and captured browser logs, exactly like `console.log` — the
  earlier "console dumps removed" pass missed it because it grepped only for `console.log`. Grep for
  **`console.` followed by a bare object argument**, not for one method name.
- 2026-09-27 (S33, KNOWN-VACUOUS, filed as backlog not fixed): the boot-check connect-race probe
  never asserts host A's late response actually **arrived**. It relies on puppeteer running the two
  interception handlers concurrently; if a future version serialised them, B would win by ordering
  alone and the probe would pass with the fence deleted. Same vacuity family as the recorded S13
  `window.open` stub. Today it has teeth (mutation-proven: pill read "USER_A · ORG_A"), but the
  assertion needs an "A responded" counter to STAY meaningful.
- 2026-09-27 (S35, still open, filed as backlog): the per-row objects in `normalizeRows`
  (`js/invoice-pdf.js:133-136`) are still plain `{}` keyed by column DISPLAY NAME, so a column named
  `__proto__` silently vanishes from the PDF. `groupStatements` was converted to a `Map`; the row
  builder was not. Same class, one layer down.
- 2026-09-25 (S25–S28, S38/S39): **`fetch` (undici) silently DROPS a caller-supplied `Host` header.**
  Any smoke assertion about the Host allowlist written with `fetch` tests nothing — it passes a
  loopback Host and the guard never fires. `scripts/smoke-test.mjs:~90` now has a `rawRequest()`
  helper built on `node:http`, which does honour an explicit `Host`. Verified empirically both ways.
- 2026-09-25 (S27): **`app.set('trust proxy', true)` is a rate-limiter bypass, not a convenience.**
  With it on, `req.ip` is the caller-supplied leftmost `X-Forwarded-For`, so rotating that header
  makes every request look like a new client. `'loopback'` is no better *here*: the server binds to
  127.0.0.1, so loopback is exactly the hop every real client arrives on. Default is now `false`
  (`server.js:~240`, env `TS_TRUST_PROXY`). Measured: 16×429 in 71 rotating-XFF requests after the
  fix, 0 before.
- 2026-09-25 (S26): **`if (SET.size && !SET.has(x))` is a fail-OPEN idiom.** An empty allowlist
  skipped the guard entirely, so a server with neither `TS_USERNAME_ALLOWLIST` nor
  `TS_DEFAULT_USERNAME` minted for any username (`server.js:~296` before the fix). Separately,
  `!autoCreate &&` on the same line meant `auto_create:true` bypassed the allowlist for EXISTING
  users — JIT must govern creation only. Both now explicit branches at `server.js:~330`.
- 2026-09-25 (S25): **`/api/webhook/file/*` shares an origin with the token mint endpoint.** A
  multipart part's `Content-Type` is sender-controlled, so serving it back `inline` made a
  `text/html` attachment stored XSS against `POST /api/auth/token`. Fixed with an allowlisted
  Content-Type + `attachment` + `nosniff` (`server.js:~560`). The same reasoning is why the Host
  allowlist exempts ONLY `POST /api/webhook`, not the `/api/webhook/*` prefix.
- 2026-09-25 (S39): **`state.flags[section]` is spread LAST into every embed constructor**
  (`js/embed.js:~253`), so before the per-section key allowlist a crafted `#s=` link could set any
  constructor option — `flags.viz.answerId` silently overriding the explicit one. `FLAG_KEYS` in
  `js/state.js:~28` mirrors app.js's `DISPLAY` table by hand (state.js must not import the
  controller); **a new DISPLAY flag that isn't added there is silently dropped from shared links.**
- 2026-09-25 (CI): **`node --test <directory>` fails on Node 22.17** with
  `MODULE_NOT_FOUND: Cannot find module '<dir>'` — it tries to run the directory as a module. The
  glob form works: `node --test "lib/spotter-mcp/*.test.mjs"` (quoted, so node expands it, not the
  shell). `package.json` `test:spotter-mcp` used to name only `customize.test.mjs`, so
  `router.test.mjs`'s 11 tests had never run in CI; both files pass (23 tests).
- 2026-09-27 (S25–S28 round 2): **`whk-${Date.now()}-${webhookEvents.length}` is not a unique id.**
  `length` PINS at `WEBHOOK_BUFFER_MAX` once the ring saturates, so every same-millisecond delivery
  after the 50th reused an id. Harmless while attachments were only count-evicted (one mis-served
  file); fatal once a byte counter existed — `webhookBytes` charged for both copies but
  `webhookFiles` held one, so the counter drifted monotonically up and the budget evicted EVERY
  attachment forever (~60 deliveries into a demo, all downloads 404 "aged out" until restart). Now a
  monotonic `webhookSeq` (`server.js:~478`) plus `retainWebhookFile()` which credits the old bytes
  back before replacing a key. **Lesson: adding a resource counter to a keyed cache turns any latent
  key collision from cosmetic into permanent.** A budget assertion must SATURATE the ring — the first
  version sent 9 deliveries and could not see this.
- 2026-09-27 (CI): **`node --test <non-matching-glob>` exits 0 with `# tests 0`.** A glob-based test
  step is therefore green-when-empty, and Node's own glob expansion is a late-20.x feature while CI
  pins Node 20 — so the pattern may match nothing on CI while working locally on 22. `package.json`
  `test:spotter-mcp` now NAMES both files, and `.github/workflows/ci.yml` has a tripwire step that
  fails if any `lib/**/*.test.mjs` is absent from the script (the other half of the same hazard).
- 2026-09-27 (S38): **a sanitizer is only half a guard — the WRITER must normalize to the same
  shape.** `validOrigin()` accepts origins only, but `connect()` (`js/app.js:~486`) wrote the user's
  raw string and `setState` does not sanitize, so a pasted `https://host/#/home` connected fine and
  then silently blanked on the next load. `connect()` now normalizes via `new URL(host).origin`. Same
  writer/sanitizer lockstep rule the org already recorded for `safeNavUrl`.
- 2026-09-27 (S25): **Express non-strict routing matches `/api/webhook/` for a route declared as
  `/api/webhook`, so an exact-string path exemption in a preceding middleware desynchronizes from it.**
  A tunnel URL registered with a trailing slash got silent 403s with an empty inbox. Any
  path-matching guard placed in front of a router must normalize trailing slashes the way the router
  does (`server.js:~292`).
- 2026-09-27 (smoke harness): a child process spawned outside a `try/finally` survives a throw and
  the NEXT `npm test` reds with EADDRINUSE — a phantom failure that looks like the code under test.
  Every `bootServer()` call in `scripts/smoke-test.mjs` is now wrapped, and the handle exposes
  `.kill()`.
- 2026-09-27 (S28 test integrity): **a burst written as `for (…) await post(…)` cannot reproduce a
  same-millisecond id collision** — each iteration gets a fresh `Date.now()`, so the assertion passes
  with the bug fully restored. The three ring-saturation checks in `scripts/smoke-test.mjs` were
  vacuous until the burst became `15 × Promise.all(8)`. Mutation-tested all four ways: colliding
  recId + sequential burst = GREEN (vacuous); colliding recId + concurrent burst = RED, 40 duplicate
  ids / 0 live files. **Concurrency is load-bearing in that test and is commented as such** — a
  "tidying" refactor back to a sequential loop silently disarms it. General rule: a regression test
  for a timestamp-keyed collision MUST issue its requests concurrently, and the way to know it bites
  is to re-break the code and watch it go red.
- 2026-09-27 (S28): `retainWebhookFile()`'s `dropWebhookFile(key)` is **unreachable defence in depth**
  once recIds are unique — no test can cover it, because a key is never replaced. Mutation-tested:
  removing it with unique ids stays 45/45 green. Kept deliberately; do not "prove it with a test",
  and do not delete it as dead code either — it is the second line against any future id scheme that
  can repeat.
- 2026-09-27 (merge of S25 onto S33, found at merge time): **a probe fixture must satisfy the same
  input normalization as the code it drives.** S33's connect-race probe told its two fake clusters
  apart by PATH (`${BASE}/s33a`, `/s33b`); S25 made `connect()` normalize every host to its ORIGIN
  (lockstep with `sanitize()`), so both collapsed into one host and the probe failed on correct code.
  It now uses two distinct fake origins and stubs `window.fetch` via `evaluateOnNewDocument` (request
  interception cannot reliably answer the CORS preflight a cross-origin JSON POST needs). Re-proven
  by mutation: `isStale = () => false` → pill reads "USER_A · ORG_A", gate FAILS.

## Over-engineering audit (ponytail, 2026-10-01, at 5afc85e → S46/S47, R2–R9)

- 2026-10-01: no function defined in `js/app.js` L1–4100 is dead; every one has a caller. The real
  cuttable mass there is duplication. Truly dead (0 callers): `cfbDiscoverColumns` (app.js ~L4801),
  `downloadLiveboardPdf` and `assignTag` (discovery.js). Ranged findings are filed as R2–R9.
- 2026-10-01: three `el()` helpers with two meanings for arg 3: app.js:310 and auth.js:72 →
  `innerHTML`; `js/spotter-mcp.js:36` → `textContent`. Merging them naively re-opens S9.
- 2026-10-01: hand copies that must change together until deduped: the drill-through snippet
  generator (app.js ~L7113-7209) mirrors `dtEpochSec`/`dtBucketEndSec`/`dtMDY`/`CFB_DATE_NAME_RE`
  and has ALREADY drifted (S46); the PDF writer exists 3× (app.js `tinyPdfBrowser`,
  invoice-pdf.js ~L378-392, scripts/simulate-webhook.mjs `tinyPdf`); the trusted-auth token
  request body is built 3× (auth.js `buildTrustedAuthConfig` + `mintToken`, embed.js
  `fetchTrustedAuthToken`) — a new claim must touch all three until R3 lands.
- 2026-10-01: Node 20's `new Response(buf,{headers}).formData()` can parse the express.raw-buffered
  webhook body (HMAC still over `req.body`) but REJECTS malformed bodies the hand parser tolerates.
- 2026-10-01: smoke-test and boot-check get a clean env by passing explicit, sometimes EMPTY,
  vars that dotenv won't override; any move off dotenv (R9) must preserve that for `''` values.
- 2026-10-01: CSS/index.html/config.js audited clean — dynamically built class names
  (`api-method--*`, `tier-*`, `badge-*`, `toast-*`, `wh-comp-*--*`) are why grep finds them unused.
- 2026-10-01 (R2): `restError()` (`discovery.js:73`) is now the ONLY TS-REST error-body parser in
  discovery.js; `aiError()` (`:461`) is `restError()` + the 401/403 Spotter hints. Verified
  restError is never less informative than the old aiError (it also surfaces top-level `.message`,
  `.debug`, and raw non-JSON bodies, and never yields `[object Object]`). metadata/search parsing is
  shared via `ofType(arr, kind)` (`:153`) + `tagNames(m)` (`:156`); the three mappers stay separate
  because their shapes differ (`listPersonalCopies` uses `title`/'Copy', `discoverAnswers` has no
  `tags`). `downloadLiveboardPdf`/`assignTag` are gone; `assignTags` now REQUIRES an array.
- 2026-10-01 (R4): the ops scripts' shared helpers live in `scripts/lib/cli.mjs` (`ok/bad/warn`,
  `cliArgs`, `fetchT`, `isTimeout`, `resolveToken`). `cliArgs()` is `util.parseArgs` with NO
  declared options + `strict:false`, which reproduces the old regex parser exactly for `--k=v` /
  bare `--k` / last-repeat-wins; `--k v` is still `k:true` (value NOT consumed) — declaring
  `type:'string'` options would silently change that. `fetchT` uses `AbortSignal.timeout`, so a
  timeout rejects as `TimeoutError` (not `AbortError`) and now also bounds the `resp.text()` body
  read; check with `isTimeout(e)`, never `e.name`. Keep `import 'dotenv/config'` the FIRST import
  in each script — cli.mjs reads no env at import time, so ordering is the only contract.
- 2026-10-01 (R4 review): CI esm-parse covers `scripts/*.mjs` (top level) + repo-root `lib/` only;
  `scripts/lib/cli.mjs` is under no gate until M24. undici refused-connection errors carry their
  code on `e.cause`, not `e.code` (S48).
- 2026-10-01 (R6): `lib/spotter-mcp/router.mjs` contains a literal NUL byte (the `getMcp` cache-key
  separator, ~L177 `${host}<NUL>${token}`), so git shows the file as **binary** (`Bin` in `--stat`,
  no hunks) and plain `grep` prints nothing. Use `git diff --text` / `grep -a`.
- 2026-10-01 (R3, supersedes the "built 3×" note above): the trusted-auth token body has ONE owner,
  `tokenRequestBody(auth)` (`js/auth.js:45`). `buildTrustedAuthConfig` now returns only
  `{tokenEndpoint, autoLogin, requestBody}` — `cfg.trustedAuth` no longer carries the individual
  claims, so nothing may read e.g. `cfg.trustedAuth.username` (nothing did at R3). A new claim is ONE
  edit there. Pre-R3 the two bodies differed for exactly one input: a `custom` token whose
  `auth.objects` held only falsy entries — Mint sent `"objects":[]`, the SDK omitted the key.
  Unreachable (`strArr` drops `''` on every load; `chipsEditor` only appends trimmed non-empty
  strings), and both now send the SDK's form. Proven by an old-vs-new harness (40k random auth
  states, byte-compare of the fetched JSON body).
- 2026-10-01 (R3): `doRender` (`js/embed.js:222`) spreads a `common` object FIRST in every
  constructor; `viz` without `answerId` FALLS THROUGH into the shared `LiveboardEmbed` case, which
  pins `vizId` after `...flags` only via `...(section === 'viz' && {vizId})` — keep that guard, it is
  the per-section pinning the code generator mirrors. Options are value-identical to pre-R3 for all
  864 section×config×flags×options combos tested (incl. adversarial flags), but KEY INSERTION ORDER
  changed (common keys now first) — irrelevant to the SDK, visible only to an `Object.keys` snapshot.
- 2026-10-01 (R3): the four auth row editors are `rowsEditor(key, addLabel, blank, build)`
  (`js/auth.js:248`); `build(row)` returns `{cells, read}`. `read()`'s KEY ORDER lands in the
  shared-link hash — append new fields, don't reorder. `blank` is a factory so two "+ Add" clicks
  never share one `values` array.
- 2026-10-01 (S46, resolved): the drill-through snippet's date helpers are now emitted from the live
  source, e.g. `` L.push(`const tsEpochSec = ${dtEpochSec};`) `` (app.js ~L7120-7134). So
  `dtEpochSec`/`dtBucketEndSec`/`dtMDY` must stay SELF-CONTAINED (globals only: Number/Math/Date/
  String/isNaN); a reference to another module identifier would paste as a ReferenceError. Their
  inner `//` comments ship in the snippet too. This relies on there being no build step
  (`Function.prototype.toString` returns the authored text); a minifier would break it. Guarded by
  boot-check's S46 line, which reads `CFB_DATE_NAME_RE` from app.js on disk and `node --check`s the snippet.
- 2026-10-01 (S46 review): boot-check legs that run snippet code via `new Function` in Node inherit
  the runner's TZ (UTC on GitHub), so they cannot catch a local-time-getter regression (the
  "UTC, not local midnight" rule) unless run under a non-UTC TZ (e.g. a `TZ=America/Los_Angeles`
  child process). The S46 leg does not do this yet.
- 2026-10-01 (M26): `reviewer` and `architect` declare a `tools:` allowlist with NO Skill tool, so
  "load skill X" in those agents is a no-op — their rules must be inline. `implementer` has no
  `tools:` line (inherits all, incl. Skill). Automated over-engineering audits must never propose
  inlining an R1-extracted module or contradict an open R/S row (rule lives in `reviewer.md`).
