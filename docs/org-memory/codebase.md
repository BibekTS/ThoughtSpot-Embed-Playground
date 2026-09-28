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
