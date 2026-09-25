# retros.md — the micro-retro log

One line per cycle: `- YYYY-MM-DD <cycle/ID>: <friction observed> → <action taken or M-row filed>`.
"No friction" entries are valid and worth recording — they establish that the process worked.
This log is the raw material for org retrospectives (BACKLOG M2).

- 2026-07-10 (M6): pre-dating this file — stranded BACKLOG Status edits and re-picked items led to
  the records-only-PR rule and the mandatory micro-retro → shipped as M6 (PR #10).
- 2026-07-10 (M7): retros before this date lived only in cycle reports and were lost with the
  session → this file created; the Records step now persists each micro-retro here.
- 2026-07-10 (M7): adversarial review of the org-v2 diff itself caught four structural defects
  pre-merge (gate-port races under the new parallelism, records-file append conflicts across
  parallel branches, an ambiguous "once the records PR is in", README contradicting itself on who
  merges to production) → all fixed in-PR; M8 filed for parallel-safe gate ports. Process changes
  deserve the same adversarial review as code.
- 2026-07-10 (M7): two interactive sessions shared one working tree — this session branch-switched
  and stashed a live S2 cycle's WIP mid-flight before noticing; state was restored and the M7 work
  moved to an isolated worktree → reinforced in the skill: sessions/agents that build in parallel
  ALWAYS take a worktree, never the shared checkout.
- 2026-07-13 (S3): the cycle adopted a dead cycle's uncommitted WIP found in the shared checkout
  (a full S3 implementation, no commit/PR, backlog still `open`). Routing it through research +
  3 adversarial lenses + `/code-review` + QA (rather than trusting or discarding it) paid off: the
  correctness lens caught an `answerList` stale-on-host-switch bug, and — critically — the fix for
  THAT (a `connect()` reset) *introduced* a last-write-wins race that only `/code-review` then
  caught. Lesson: a correctness fix is itself an unverified diff; re-review after fixing, don't just
  re-run gates. No process/skill friction — the playbook's fix→re-verify loop worked as written.
- 2026-07-13 (discover, parallel hunt ∥ drain): ran a find-only discovery hunt (4 lenses over the
  embed/runtime-filter ground) concurrently with an active S3 drain — safe because hunters are
  read-only and QA owned the gate ports. Multi-lens paid off twice: the correctness + data-integrity
  lenses independently confirmed the same cfb string-epoch bug (S14), and the regression lens REFUTED
  the correctness lens's low-confidence `onDone`-re-push suspicion by proving idempotency (dropped it
  pre-filing). Friction: the S3 drain committed + merged (#17) mid-hunt under the shared checkout, so
  the CEO re-read git state before filing and branched the records PR off the *post-#17* main — the
  worktree discipline held. Filed S13–S17. No skill change needed.
- 2026-07-22 (S13, P1 security drain): the FIX was sound first time — the security lens could not
  break it — but the cycle's *process* failed twice, both traceable to playbook instructions. (1) The
  implementer was told to leave its work UNCOMMITTED for review; a concurrent actor in the shared
  working directory then swept the uncommitted P1 security fix into its own unrelated feature commit
  on its own branch, leaving the S13 branch empty and requiring a full re-apply + re-verify. Filed
  **M9**: the implementer must commit to its branch. (2) "Review Board ∥ QA" put reviewers on a live
  tree that QA was concurrently MUTATING for its mutation test — the regression reviewer read the sink
  as guarded at 09:58 and unguarded at 10:04 and rightly refused to trust either. Filed **M10**:
  reviewers get an immutable commit/patch, QA mutates a scratch copy. Both are direct consequences of
  how the skill is written, not agent error. What worked: parallel lenses earned their keep — security
  cleared the guard while correctness AND regression independently caught the same editor-save false
  positive (`https://{{Domain}}` → rejected) that the gates were blind to, and QA's insistence on
  re-doing the mutation test itself surfaced both that the probe's `__pwned` assertion is vacuous and
  that the repo state didn't match the brief. Delegated research also caught that the org-memory line
  cites were ~1200 lines stale. Lesson: gates prove a fix works; only adversarial review proves it
  doesn't break something else.
- 2026-07-22 (M9/M10, the org fixing its own process): the two process failures the S13 cycle filed
  were fixed — but the fix itself needed **four review rounds**, and every round found the new
  doctrine re-committing the failure it was written to prevent. Round 1: QA FAILED by *executing* the
  shell recipe the PR shipped (cleanup exited 128), and all three lenses independently found the
  recipe relied on cwd/`$VARS` surviving between agent Bash calls — they don't, and `cd "$UNSET"`
  returns 0, so QA's mutation test would have landed in the shared checkout: M10 re-opened by M10's
  own fix. Round 2: the recipe ordered cleanup BEFORE the mutation test, leaving the single most
  dangerous command in the bar with no worktree to run in. Round 3: the governance lens traced a
  production-deploy exploit through the new carve-out's deny-list (`package.json` re-points what
  `npm test` runs; `guard` protects `scripts/smoke-test.mjs` but not the script name invoking it).
  Round 4: the reconciliation check the PR added used `git log --oneline`, which cannot decide a
  file-list predicate — decorative. **Lesson: a rule about a mechanism must be executed, not just
  read.** QA's insistence on running the shipped recipe verbatim, in the real multi-call agent shape,
  is what caught rounds 1 and 2; no amount of careful reading had. The corresponding lesson for
  authors: prose describing a shell workflow is code, and untested code.
- 2026-07-22 (M9/M10): the cycle dogfooded its own output — the implementer committed to its branch
  every round (M9), and reviewers were handed SHAs while QA mutated a worktree (M10). That is why the
  parallel Review Board ∥ QA phase was safe this time, and QA proved it: during the live mutation the
  scratch worktree showed `M js/app.js` while the shared checkout stayed empty. Adversarial review
  earned its keep at a ratio nothing else matches — 21 confirmed findings across 4 rounds on a
  docs-only diff, of which 4 were exploitable holes in the org's own safety machinery.
- 2026-07-22 (M9/M10, process friction worth naming): the playbook says "one item per cycle unless
  explicitly batching" but M9 and M10 were inseparable — M10's "review this SHA" is unimplementable
  unless M9 guarantees a SHA exists. Batching was right and cost nothing. The real friction was
  convergence: four fix rounds on a docs-only diff is expensive, and three of the four were caused by
  the same author-side blind spot (writing shell prose without running it). Filed S21, M11, M12, M13.
- 2026-09-25 (full-project review — S25–S41, M14–M19): the first end-to-end sweep since 2026-07-22
  found **17 app bugs and 6 process failures**, four of them P1 security. The uncomfortable part is
  *why the gates were blind to all of them*. (1) **The gates boot without a secret.** Both
  `smoke-test.mjs` and `boot-check.mjs` spawn the server with `TS_SECRET_KEY: ''`, so every
  trusted-auth-path assertion passes **vacuously** — the code under test is never reached. That is
  how S26 (empty username allowlist fails open; `autoCreate` bypasses it) survived a gate whose
  stated job is the username allowlist. Filed **M14** (mint-stubbing probe pattern) and **M16** (the
  smoke test never asserted the allowlist or the rate limiter *at all* — the two guards S26/S27
  break). A gate that cannot fail proves nothing, and nothing in the bar distinguishes "asserted and
  passed" from "skipped". (2) **`lib/` is outside every gate.** `esm-parse` covers `js/*.js`;
  `npm run test:spotter-mcp` runs one of the two test files, so `lib/spotter-mcp/router.test.mjs`
  has never been executed by CI, and there is no lint anywhere (**M15**). (3) **Records decay.** No
  retro since 2026-07-22, `codebase.md` at 282–405 lines against its own ~120-line cap, rows marked
  `done` before merge, and verification evidence quoted without a SHA (**M17**) — every one of these
  is the org failing the doctrine it wrote for itself in the M9/M10 cycle, which is a sharper signal
  than any single bug. What worked: the hunt was worth an order of magnitude more than the cycle
  that produced it, and the highest-value findings came from lenses aimed at *the gates* rather than
  at the code. Lesson, and it is the M9/M10 lesson again one level up: **a gate whose environment
  disables the code path it asserts is untested code**, exactly as prose describing a shell workflow
  is untested code. Both must be executed adversarially — mutation-tested — not merely read.
