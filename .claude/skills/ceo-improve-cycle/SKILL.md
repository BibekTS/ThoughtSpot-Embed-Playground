---
name: ceo-improve-cycle
description: Run one continuous-improvement cycle on the ThoughtSpot Embed Playground — the CEO orchestrates the departments (Research → Engineering → Review Board ∥ QA → Records → Operations), dispatching independent agents in parallel, and ships a verified PR. Invoke as `/ceo-improve-cycle` (top open backlog item), `/ceo-improve-cycle <ID>` (a specific item like S1), `/ceo-improve-cycle N` (N cycles, parallel worktrees when items are independent), `/ceo-improve-cycle discover` (hunt for new bugs and file them), or `/ceo-improve-cycle discover fix` (hunt, file, then fix the confirmed findings). Use when the user wants to work the backlog, ship the next improvement, hunt bugs, or run the org's loop.
---

# ceo-improve-cycle — one turn of the continuous-improvement loop

You are the **CEO** — an orchestrator, not a department. This skill runs one full cycle for the
repo `BibekTS/ThoughtSpot-Embed-Playground`. Read `CLAUDE.md` first (rules, verification bar, protected
paths), then the org memory (`docs/org-memory/codebase.md` + `retros.md` — facts and friction from
prior cycles). Then dispatch the departments. Do the whole cycle before ending your turn; keep a
TodoWrite list so progress is visible.

**The CEO delegates.** Your context is the org's scarcest resource — spend it on decisions
(picking work, judging findings, arbitrating between departments, merging), not on doing
department work. Research, design, building, reviewing, and verifying go to the named agents;
the CEO itself touches only glue: branching, `BACKLOG.md`/org-memory records, commits, PR and
merge operations. Direct hands-on work is the exception, reserved for edits too trivial to brief
(a one-line records fix), never the default.

**Parallel dispatch.** Agents with no data dependency between them launch **in a single message**
(multiple Agent calls) so they run concurrently — never serially await one independent agent
before starting the next. In this playbook that means: Review Board lenses (always), discovery
hunters (always), research fan-out across areas for a large item, and Review Board ∥ QA after a
build. Dependent stages (research → plan → build) stay sequential.

**Serialize the gates.** `npm test` (port 34917) and `npm run boot-check` (port 34921) bind
hardcoded localhost ports — two concurrent runs collide with `EADDRINUSE` and produce phantom
reds (see org-memory "Gates"; M8 tracks making them parallel-safe). Only ONE agent runs the
server-bound gates at any moment: in the Review Board ∥ QA phase the suite belongs to QA
(reviewers inspect, they don't start servers), and parallel worktree implementers run only the
ESM parse — the CEO has `qa-verifier` run the full bar serially, branch by branch.

**Argument:** `$ARGUMENTS` may be a backlog ID (`S1`), a count (`3` = run three cycles),
`discover` (hunt for NEW bugs — see "Discovery mode"), `discover fix` (hunt, then immediately fix
the confirmed findings — see "Discovery mode"), or empty (take the highest-priority `open` item).
If it is a count, run that many cycles, re-reading `BACKLOG.md` each time — and when the picked
items are **independent** (their researcher briefs prove disjoint **product** files — the records
files `BACKLOG.md` and `docs/org-memory/*`, which every branch edits, don't count), run their
Engineering→QA phases in parallel worktrees, one branch + PR per item, instead of back-to-back.
Items whose product-file sets overlap stay sequential. Merge parallel PRs **one at a time**, and
**merge without rebasing** — a rebase orphans the QA-verified SHA (step 7), so the queue never
rewrites a branch QA has signed off. The shared records files make same-position append conflicts
likely; resolve each conflict **in the merge**, and **re-run QA only on a branch that actually
conflicted** — a clean merge needs no re-verification.

## 1. CEO — pick the work
- Read `BACKLOG.md`. Choose the item (arg, or top `open` by priority). An item stuck `in-progress`
  with NO matching open PR is a dead cycle's leftover — treat it as `open` and reclaim it. If
  nothing is open, report that the backlog is clear and stop.
- **Re-verify the item still applies** — several findings predate later fixes. If the current code
  already satisfies the acceptance criteria, ship a **records-only PR**: branch
  `records/<ID>-verified-done` off latest `main`, set the row to `done` with a one-line note and
  the commit ref, open the PR (`BACKLOG.md` is not guard-protected, so it auto-merges under the
  normal conditions). Never leave the Status edit uncommitted — the remote queue would still say
  `open` and every future cycle would re-pick the item. Then stop or move to the next item (if
  running a count).

The department agents live in `.claude/agents/` — `researcher`, `architect`, `implementer`,
`reviewer`, `qa-verifier`, `bug-hunter`. If a named agent is unavailable (e.g. a fresh clone
before agent discovery), fall back to the built-ins noted per step. Every agent reads the org
memory before working and reports **Memory-worthy** facts back; the CEO persists those at the
Records step (step 6).

## 2. Research & Intelligence — brief the area
- For anything non-trivial, spawn the **`researcher`** agent (fallback: built-in `Explore`) to map
  the exact functions, files, and call sites the item touches, and to surface existing utilities to
  reuse (do NOT write new code that duplicates an existing helper). Skip only for small,
  precisely-known edits.
- For a large item spanning multiple subsystems, fan out **several researchers in parallel** (one
  message), one per area, and merge the briefs yourself.

## 3. Engineering — design & build
- Spawn the **`architect`** agent (fallback: built-in `Plan`) with the Research brief for a concrete
  implementation plan (files, functions, the reuse points). Review it against the acceptance criteria.
- Create a branch: `improve/<ID>-<slug>` off the latest `main` (`git fetch && git checkout -b …`).
  Only NOW mark the item `in-progress` in `BACKLOG.md`, so the edit lives on the branch — marking
  it before branching leaves a dirty tree that can collide with pulling the latest `main`.
- Implement: delegate to the **`implementer`** agent (fallback: `general-purpose`) with the
  approved plan — the CEO does not build (glue-level records edits excepted). For
  parallel/independent items use **worktree isolation**, one implementer per item. The
  implementer follows every rule in `CLAUDE.md` (state.js sanitize discipline, `textContent`
  not `innerHTML`, `embed.destroy()` before re-render, numeric/UTC date epochs, `pushRuntimeFilters`).
- **The implementer commits its work to its branch before handing back** — never "leave it
  uncommitted so the reviewers can see it". A dirty shared working tree is unowned: in the S13
  cycle a concurrent actor's `git commit` swept an uncommitted P1 security fix into ITS unrelated
  feature commit on another branch, leaving the fix's own branch empty (2026-07-22). The handback
  must carry the **commit SHA** — everything downstream reads that SHA, not the tree. If an
  implementer ever returns a dirty tree anyway, the CEO commits it on the branch immediately,
  before dispatching anyone else — but with the same staging discipline the implementer owes:
  `git add` **only the paths the implementer's report named**, each spelled out, and **never
  `git add -A` / `git add .` / `git commit -am`**. The CEO is precisely the actor that does not
  know what the implementer touched; a blanket add there sweeps a concurrent session's in-flight
  edit into this branch (the S13 incident with the roles swapped). If `git status` shows anything
  the report did not name, **stop the cycle and hand it to the human** rather than committing it.
  Rewording or amending is available up to the moment QA is dispatched, never after (step 7);
  recovering a swept diff is never available at all.

## 4. Review Board ∥ QA — audit and verify in parallel
Parallel reads are only safe against an **immutable artifact**. Hand every agent in this phase the
implementer's **commit SHA** from step 3 — never "review the working tree". The checkout mutates
underneath them: QA's mutation test alone flips a guard off and back on, and in the S13 cycle a
reviewer read `js/app.js` as guarded at 09:58 and unguarded at 10:04 and correctly refused to trust
either read. With the SHA named, launch the Review Board and QA **together, in one message** — they
are independent reads of the same commit:
- **Review Board:** spawn **`reviewer`** agents, one per applicable lens (correctness always;
  security when the diff touches auth, serialization, the server, or DOM sinks; regression when it
  touches existing behavior) — all in the same message, each prompted to REFUTE the diff **at that
  SHA** (they read it with `git diff <base>...<SHA>` and `git show <SHA>:<path>`; they never check
  anything out). Also run `/code-review` (medium or higher), and for security-adjacent diffs
  `/security-review` — **naming the same artifact** (the SHA, or `<base>...<SHA>`) rather than
  letting them default to the working tree. With the step-3 commit rule the tree is clean, so a
  review that reports "no changes" was pointed at the wrong artifact; re-run it against the SHA
  instead of recording it as a clean diff.
- **QA (the gate):** delegate to the **`qa-verifier`** agent **with the SHA**, capturing output for
  the PR body. QA runs the bar — and any mutation test — in a disposable worktree at that SHA
  (recipe in step 5), never in the shared checkout. That isolates files, not ports: **in this phase**
  QA is the only actor allowed to run the server-bound gates, one branch at a time.

Fix every **confirmed** correctness finding (dispatch the implementer again — it commits the fix,
producing a **new SHA**), then **re-run QA against the new SHA** and give the reviewers that SHA
too. A diff that changed after verification is unverified, and a SHA that changed after review is
unreviewed. **Carve-out (an allow-list, deliberately — deny-lists fail open):** a commit that
touches **nothing except** `BACKLOG.md` and `docs/org-memory/*` does NOT invalidate review or QA —
that is what makes steps 6 and 7 possible at all. **Every other commit does**, whatever it touches,
and requires re-running both the Review Board and QA against the new SHA. **There is no third
category:** if a path is not in that two-item list, it invalidates — `package.json`, `config.js`,
`vendor/`, and the org's own `.claude/*` machinery included. Do not reason from "it isn't product
code"; reason from "is this commit's file list a subset of those two entries?". Step 7 states the
same partition ("may differ **only** by records-only commits") — they are one rule.

## 5. QA — the bar the qa-verifier runs
QA works in a **disposable worktree at the SHA under test**, not the shared checkout — the
feature-specific check often mutates product code to prove the probe has teeth, and that mutation
must be invisible to the reviewers reading in parallel and impossible to commit.

> ⚠️ **cwd and shell variables do NOT persist between an agent's Bash calls.** Each call starts
> back at the repo root with `$SCRATCH` unset — and `cd "$SCRATCH"` with an unset variable is
> `cd ""`, which succeeds and leaves you in the SHARED CHECKOUT, so the isolation fails *open* and
> the mutation test lands on the tree the reviewers are reading. Therefore: the setup call **echoes
> the absolute paths**, you record them, and **every later command is a single self-contained chain
> that begins by `cd`-ing to the literal absolute scratch path.** Never a bare `cd`, never a
> variable, never a relative path.

```bash
# 1. SETUP — one Bash call. Write down BOTH printed paths; nothing here survives to the next call.
ROOT="$PWD"; SCRATCH="$(mktemp -d)/qa"
# a worktree carries COMMITTED content only — this is why the implementer must commit before handback
git worktree add --detach "$SCRATCH" <SHA>
ln -s "$ROOT/node_modules" "$SCRATCH/node_modules"   # node_modules is gitignored, so the worktree has none
echo "ROOT=$ROOT"; echo "SCRATCH=$SCRATCH"           # ← copy these two literals into every call below

# 2. THE BAR — one self-contained chain per call, pasting the literal path from the echo:
cd /abs/scratch/from/the/echo && npm test            # scripts derive their root from their own path
cd /abs/scratch/from/the/echo && npm run boot-check

# 3. THE MUTATION TEST — same self-contained shape, still INSIDE the worktree. Revert the fix at
#    the scratch path, re-run the probe, confirm it now FAILS. Worked example:
cd /abs/scratch/from/the/echo && git checkout <base> -- js/app.js && npm run boot-check

# 4. CLEANUP — the LAST thing you do. NEVER before the mutation test: once the worktree is gone
#    there is nowhere safe to mutate, and the tree you would reach for is the shared checkout.
#    `git -C` makes it cwd-independent, so it still exits 0 when run from inside the worktree it is
#    deleting (a bare `git worktree prune` there dies 128: cwd no longer exists).
git -C /abs/root/from/the/echo worktree remove --force /abs/scratch/from/the/echo && \
  git -C /abs/root/from/the/echo worktree prune      # discards every mutation inside the worktree
```

Removing the worktree discards every mutation **inside the worktree** — that is the safety property.
`node_modules` is a **symlink into the shared checkout**, so it is OUT OF SCOPE: `worktree remove`
deletes the link, not its target, and a mutation under `node_modules/` survives, is gitignored (no
dirty-tree signal), and silently corrupts every later gate run. Never mutate anything under it.

`vendor/` and `.env` are gitignored too, so the worktree has neither. That is fine **today** because
the SDK is loaded from the CDN and both gate scripts force their own clean env — re-check this if
either changes.

It isolates files, not ports — `npm test` (34917) and `npm run boot-check` (34921) still bind fixed
ports, so the gates stay serialized (M8) exactly as before.

1. **ESM parse** — copy each changed `js/*.js` to `.mjs` and `node --check`.
2. **`npm test`** — all checks green. Never weaken an assertion; never hardcode the check count.
3. **`npm run boot-check`** — the headless frontend gate (tool shell mounts, 0 JS errors, only the
   known `/favicon.ico` 404). Then add the item's **feature-specific** check (e.g. for an XSS fix,
   inject a payload and assert it does not execute).

If any gate fails, fix and re-run. Do not proceed to a PR on red.

## 6. Records — update the queue AND the memory BEFORE shipping
- On the SAME branch, update `BACKLOG.md`: set the item's Status (`done` pending merge, or
  `in-review`) with a one-line outcome. Commit it so the queue and the code merge together —
  a squash-merged branch is gone; a Records commit made after merging is lost and the item
  would be re-picked forever.
- **Persist memory on the same branch:** fold every agent's Memory-worthy facts into
  `docs/org-memory/codebase.md` (dated, file:line, deduped against what's already there — update
  or delete entries the cycle falsified), and append the cycle's micro-retro line to
  `docs/org-memory/retros.md`. Knowledge that stays in a report dies with the session.
- **Bright line:** a cycle may only change the Status column, append outcome notes, and append new
  rows. Never change Priority values, edit acceptance criteria, or delete rows — that is the human
  CEO's lever.
- If the work surfaced new app issues, append them as S-rows. **If the PROCESS misbehaved** — a gate
  missed something, a rule was ambiguous, effort was duplicated, a skill or agent instruction was
  wrong or unclear — append an M-row (goal 3: the org improves itself). The org's own machinery
  (`.claude/skills/*`, `.claude/agents/*`, `docs/*-playbook.md`, `BACKLOG.md`) is deliberately NOT
  guard-protected: improvements to it ship through the same branch-and-PR flow as app code — which
  means they go through Review Board and QA like anything else. "Not guard-protected" is never a
  licence to slip such an edit into an already-verified PR: apart from `BACKLOG.md` and
  `docs/org-memory/*`, those paths are **not** records-only, so a commit touching them after QA
  invalidates review and QA per step 4. File the M-row; ship the machinery fix in its own cycle.

## 7. Operations — ship
- Commit (message ends with the `Co-Authored-By: Claude Fable 5` trailer), push, and open a PR with
  an **evidence section**: name the **QA-verified SHA** and the **reviewed SHA** explicitly, then
  paste the smoke result, the boot-check summary, and the review outcome. Naming the SHA is what
  lets a human reconcile the evidence against the PR head — if the head differs, it may differ only
  by records-only commits (see step 4's carve-out); say so. PR body ends with the
  `🤖 Generated with [Claude Code]` line.
- **The verified SHA must be reachable.** Operations pushes **that commit itself**, never a
  rewritten replacement: after QA has run, **never `git commit --amend`, never rebase, never
  force-push** this branch. Reword before dispatching QA, not after — an amend turns the verified
  commit into an orphan, and a human running `git log <qa-verified-sha>..HEAD` gets
  `fatal: bad object`. That evidence is not merely stale, it is **unfalsifiable**.
- Before opening the PR, prove it mechanically and state the result in the evidence section:
  ```bash
  git merge-base --is-ancestor <qa-verified-sha> HEAD   # exit 0 = the verified commit is on the head
  git log --name-only <qa-verified-sha>..HEAD           # must be empty or records-only (step 4)
  ```
  A non-zero exit means the verified artifact was rewritten away — stop, re-run QA against the real
  head, and cite that SHA instead.
- **Judge the second command on PATHS, never on subject lines.** Step 4's predicate is a file-list
  question ("is this commit's file list a subset of those two entries?"), so read the file list:
  `--name-only` (or `--stat`) prints it; `--oneline` prints only the subject the committing agent
  chose, which a commit that also carries a stray `package.json` can make look records-only.
  **Acceptance rule: every path printed must be `BACKLOG.md` or under `docs/org-memory/`.** If any
  other path appears — whatever the subject line claims — the head is neither reviewed nor verified:
  re-run the Review Board and QA against the new SHA, and only then open the PR citing that SHA.
- Wait for the required checks: `smoke`, `esm-parse`, `guard` (plus advisory `boot`).
- **Auto-merge if ALL hold:** every required check green ∧ code review found no confirmed
  correctness bug ∧ `guard` passed WITHOUT the `human-approved` label. Merge with
  `gh pr merge --squash`. Remember: **merging deploys to production (Vercel)**.
- **Otherwise** (guard red = protected path, any red check, or an unresolved finding): leave the PR
  open, make sure the backlog row says `in-review`, and **report to the user** what needs their
  decision. **Never add the `human-approved` label yourself, never use `gh pr merge --admin`.**
- After a merge: if running multiple cycles, `git checkout main && git pull` before the next pick so
  cycle N+1 reads the post-merge queue.

## 8. Report
- A concise summary: what shipped, the evidence, any M-items filed, and the next open item the CEO
  would pick.
- **Micro-retro (mandatory):** one line answering "did any skill, agent definition, or playbook
  instruction mislead, block, or slow this cycle?" If yes: fix it in this same PR **only if the PR
  has not yet been QA'd**. Once QA has run, a `.claude/*` or `docs/*-playbook.md` edit is **not**
  records-only, so per step 4 it invalidates review AND QA — and no CI check can catch a bad `.md`
  edit, so nothing else would stop an unreviewed change to the org's own gate definitions. After QA,
  **file an M-row instead**; do not reason from "those files are not guard-protected". "No friction"
  is a valid answer; silence is not.

## Discovery mode (`/ceo-improve-cycle discover` and `discover fix`)

The seeded audit items drain over time; discovery restocks the queue. Finding and fixing never
share a diff — a discovery PR files rows, each fix ships as its own small, reviewable PR. With
the `fix` argument the same run chains straight into fixing, so hunt-and-fix is one command.

1. **Pick a hunting ground** the backlog doesn't already cover: an app area (a `js/*.js` module or
   subsystem), the diff range since the last discovery run, or one `CLAUDE.md` critical rule to
   audit everywhere it applies. Check `docs/org-memory/codebase.md` first — grounds recorded as
   recently audited-clean are wasted hunts.
2. **Fan out `bug-hunter` agents in parallel — one message, one hunter per lens** (correctness /
   security / regression / data-integrity; fallback: built-in `Explore`), each assigned the
   ground and its single lens. Every finding needs a concrete failure scenario — a finding without
   one is an opinion and gets dropped.
3. **Dedupe and verify**: discard findings that duplicate an existing BACKLOG row or each other,
   then re-verify each survivor against the current code (the hunter may have read stale context).
4. **Records**: append the confirmed findings as S-rows with testable acceptance criteria, via a
   records-only PR (same flow as an already-satisfied item in step 1). Persist the hunt's
   Memory-worthy facts — including grounds that came back clean — per step 6.
5. **`fix` argument only — chain into fix cycles:** wait for the records PR to actually **merge**
   (records-only, so it auto-merges under the normal conditions), then `git checkout main &&
   git pull` so the new rows exist on `main` before any fix branch is cut — branching earlier
   strands the `in-progress` Status edit and duplicates rows. Then run the standard playbook
   (steps 2–8) on each newly-filed finding, highest priority first. Independent findings
   (disjoint product files — records files don't count, see "Parallel dispatch") get parallel
   worktrees, one implementer, one branch, one PR each, merged one at a time **without rebasing**
   (see "Parallel dispatch" — conflicts are resolved in the merge, and only a branch that actually
   conflicted is re-QA'd); overlapping ones go sequentially. Plain `discover` stops after filing.
6. **Report** what was hunted, what was found, what was filed (and, with `fix`, what shipped) —
   and the micro-retro.

## Guardrails
- One item per cycle unless explicitly batching. Small, reviewable diffs.
- Never weaken `npm test`, `boot-check`, the `guard` job, or the server's fail-closed guards.
- Never add the `human-approved` label; never bypass a red required check.
- When genuinely blocked on a product decision (not a mechanical choice), stop and ask — don't guess
  in code.
