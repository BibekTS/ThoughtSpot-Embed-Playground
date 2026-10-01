# UI quality playbook — the Review Board's UI lens

The standing brief for any change that touches what a user **sees**: `css/styles.css`,
`index.html`, `THEME.md`, or JS that builds DOM (`el(...)`, `className`, inline `style`, new
overlays/panels). The `reviewer` applies it as the **UI lens**, `bug-hunter` hunts with it as the
`ui` lens, `architect` and `implementer` design and build to it, and `qa-verifier` runs its
mechanical checks.

**Provenance.** Distilled from the `taste-skill` anti-slop frontend skill
(github.com/Leonxlnx/taste-skill, MIT), first applied here in PR #38. That skill targets landing
pages and portfolios and says so: dense tool UIs are out of its scope. So this file keeps only the
rules that hold for a developer tool, restated against this repo's theme. **Do not load or apply
the upstream skill wholesale**; its default stack (React, Tailwind, Motion, GSAP) contradicts the
no-build vanilla rule in `CLAUDE.md`.

**Precedence.** `CLAUDE.md` > `THEME.md` > this file. THEME.md owns the look (Inter, the
cyan→violet gradient, light-only); this file owns the floor every UI change must clear.

## The design read (fixed for this repo)

A light-only developer tool for SEs and engineers, with dense controls in the Compendium theme.
On the taste dials: variance 3, motion 3, density 7. Motion is feedback and progress only, never
decoration. Hierarchy comes from weight and colour, not from size or effects.

## Rules

Each rule ends with how to check it. Under the org's finding rule, a UI finding still needs a
concrete failure scenario: name the **element, the state, and the measured value**
(e.g. "`.wh-type` on `--surface-3`, 12px bold, 4.45:1 < 4.5").

**U1. Fills paint, inks write.** The bright brand and status colours fail AA as text. Text uses
the ink twin and the original keeps dots, borders, left rules, glows and soft fills.

| Fill (never text on light) | Text token | Ratio |
|---|---|---|
| `--accent` #00c9de | `--accent-ink` | 5.07:1 on white, 4.65:1 on `--accent-soft` |
| `--accent-2` #6366f1 | `--accent-2-ink` | 5.47:1 on `#eeeefb` |
| `--success` | `--success-ink` | 5.46:1 on `--success-soft` |
| `--warn` | `--warn-ink` | 4.96:1 on `--warn-soft` |
| `--danger` | `--danger-ink` | 5.62:1 on `--danger-soft` |

Exception: on a **dark** surface (navy tooltip `.rail-tip`, `--code-bg`, the navy toast) the
bright original is correct; say so in a comment. Known trap: `--accent-ink` is only **4.45:1 on
`--surface-3`**, so don't put accent text there.
*Check:* M1. Its only expected hit is `.rail-tip-cls`, on the navy tooltip.

**U2. White text sits on an ink fill.** A button, pill or marker with `color: #fff` uses
`--accent-ink` / `--success-ink` (or the ink gradient
`linear-gradient(135deg, var(--accent-ink), var(--accent-2-ink))`), never the bright fill.
Exempt: the `.tb-mark` logo glyph. A hex or `rgb()` fill is judged by computing the ratio
(white on `#c0392b`, the `.flow-step.failed` marker, is 5.44:1 and passes). *Check:* M2.

**U3. De-emphasise text with colour, not opacity.** `opacity: .5` on a text block takes
`--text-secondary` to about 2.4:1. Use `--text-muted` (≥4.5:1 on white and on `--bg`) and/or a
lighter weight. Opacity is fine for disabled controls (`.unavailable`, `:disabled`), which WCAG
exempts. *Check:* M3, then judge each hit.

**U4. Every animation is motivated and honours reduced motion.** Valid reasons: feedback (a
press, a toast), state change (panel open), or progress (spinner, live phase). Decoration is not a
reason. A new `animation:` must be stopped by the global `@media (prefers-reduced-motion: reduce)`
block at the end of `css/styles.css` (add its selector there) or by its own media block. Spinners
are the one exemption, because they are the only signal that work is in flight. Transitions are
already neutralised globally. *Check:* M4. Every selector it lists must appear in a
reduced-motion block or be a spinner.

**U5. Animate only `transform` and `opacity`.** Animating `height`/`width`/`top`/`left` is
layout-bound jank. The one sanctioned exception is the existing bottom-panel `height` transition;
don't add others.

**U6. Full viewport height uses `dvh`.** A full-height `100vh` (or `calc(100vh - …)`) jumps
under mobile browser chrome. Declare `100vh` and then `100dvh` in the same rule: browsers without
`dvh` keep the first one, so `100vh` is the fallback. Fractional caps such as `max-height: 88vh` are fine. *Check:* M5 should print nothing.

**U7. No pure black; shadows are navy-tinted.** Use `rgba(26,31,74,…)` (THEME.md rule 4). Pure
`#000` is allowed only inside a `mask-image` gradient, where it means "opaque", not a colour.
*Check:* M6.

**U8. Never kill focus.** The global `:focus-visible` rule near the end of `css/styles.css` must
stay the last word on `outline`. A new `outline: none` placed **after** it, or a new focusable
widget it doesn't cover, is a finding. Controls that paint their own focus keep
`border-color: var(--accent)` + the soft halo **and** stay listed in that rule.

**U9. Tokens, not literals.** Components reference `:root` variables. A new hex in a component
rule needs a reason (a third-party brand colour, a one-off warning palette already used nearby).
A new token gets documented in `THEME.md` in the same PR.

**U10. Every async surface has its states.** Anything that fetches renders **loading, empty and
error**, not just the happy path. Follow the existing patterns: `#state-overlay` phases,
`.log-empty` / `.wh-empty`, and skeletons (`.plb-skel`, `.dt-skel-*`) shaped like the content.
Error text is inline and specific (what failed, what to do).

**U11. Controls read cleanly.** Labels stay on one line (`white-space: nowrap` on fixed-height
controls). Use one label per intent across the app; don't add "Copy" in one place and "Copy
code" for the same action elsewhere. Form fields have a real label (`<label>` or `aria-label`
for toolbar inputs); a placeholder is never the only label. Untrusted strings still go in via
`textContent` (`CLAUDE.md`).

## Out of scope here (do not file these)

Everything from the upstream skill that assumes a marketing page: hero and nav sizing,
eyebrow counts, bento grids, logo walls, image and illustration rules, scroll choreography, the
Inter and serif bans, the React/Tailwind/Motion/GSAP stack, and dark mode. THEME.md is
light-only by design, so a dark set would be its own backlog item, not a finding.

**Open question, the human's call:** the upstream skill bans em-dashes in visible copy. This
app's copy uses them throughout (about 215 JS string literals). Until the human decides
(BACKLOG M23), an em-dash is **not** a finding.

## Mechanical checks

These checks are **evidence for the UI lens, not a gate**. M1, M2, M5 and M6 have a fixed expected
output: anything beyond it is a finding unless the reviewer judges it safe and says why. M3 and M4
list every candidate, so each new hit gets a one-line justification (an icon, a spinner) or is a
finding. BACKLOG M24 tracks promoting M1 and M2 to a real gate.

How to run them:
- **Point `CSS` at a real file.** To check a commit, write it out first:
  `CSS=$(mktemp "${TMPDIR:-/tmp}/ui-<SHA>.XXXXXX") && git show <SHA>:css/styles.css > "$CSS"`. Use a unique file
  (agents run in parallel; a shared `/tmp/ui-sha.css` lets one judge another's CSS). Never assign a
  `<(…)` process substitution to `CSS`: it is a single-use pipe, so every check after the first
  fails with `Bad file descriptor`.
- **Use `/usr/bin/grep`** (the block sets `G`). Agent shells can wrap `grep` in a function
  (ugrep) with different regex behaviour. Everything here is POSIX ERE and awk, and was tested
  with BSD grep and BSD awk.
- **New hits = SHA output minus base output.** Run the block on both files and diff, ignoring
  line numbers: `diff <(… base | sed 's/^[0-9]*://') <(… sha | sed 's/^[0-9]*://')`.

The checks were tested against a fixture of known violations, including `color:var(--accent)`
with no space, `background-color:`, unspaced and `to right` gradients, `color: white`,
`animation: .22s ease slidein`, `animation-name:`, `rgb(0 0 0 / .2)`, and `100vh` and `100dvh`
on separate lines.

```bash
CSS=css/styles.css
G=/usr/bin/grep
# M1  fill colours used as TEXT (U1). Expected: only .rail-tip-cls (navy tooltip).
$G -niE '(^|[^-])color: *(var\(--(accent|accent-2|success|warn|danger)[,)]|#00c9de|#6366f1|#2d8b65|#c08930|#b85450)' "$CSS"
# M2  white text on a light or bright fill (U2). Expected: .tb-mark, plus
#     .flow-step.failed .fs-dot (#c0392b, 5.44:1). .plb-tab-close.armed is open in BACKLOG S48.
#     Hex/rgb/hsl fills are listed for judgment: compute the ratio. --danger is deliberately not
#     listed (white on it is 4.75:1). Rule-level only: it cannot see the cascade (see below).
awk 'BEGIN{RS="}"} { b=tolower($0) }
  b ~ /(^|[^-])color: *(#fff([^0-9a-f]|$)|#ffffff|white|rgba?\( *255[, ] *255[, ] *255|hsla?\( *0[, ]+0%[, ]+100%)/ &&
  b ~ /background(-color|-image)?:[^;]*(var\(--(accent|accent-2|success|warn|[a-z0-9-]*-soft|surface(-[0-9])?|bg)[,)]|#[0-9a-f][0-9a-f][0-9a-f]|rgba?\(|hsla?\()/ {
    s=$0; while ((i = index(s, "{")) > 0) { sel = substr(s, 1, i - 1); s = substr(s, i + 1) }
    sub(/.*\*\//, "", sel); gsub(/[ \t\n]+/, " ", sel); print "M2:" sel }' "$CSS"
# M3  opacity on text that is not disabled (U3). Judge each hit: icons, drag ghosts and
#     already-added rows are fine. Known open hits: BACKLOG S48.
$G -nE 'opacity: *0?\.[0-6]' "$CSS" | $G -vE 'disabled|unavailable|not-allowed|scrim|reduced-motion|::before|::after|@keyframes|[0-9]+% *\{'
# M4  animations (U4). Each must be in a reduced-motion block or be a spinner.
$G -nE 'animation(-name)?: *[^;]' "$CSS" | $G -vE 'animation(-name)?: *none'
# M5  full-height vh without a dvh twin in the same rule (U6). Expected: nothing.
awk 'BEGIN{RS="}"} /100vh/ && !/100dvh/ { s=$0; while ((i = index(s, "{")) > 0) { sel = substr(s, 1, i - 1); s = substr(s, i + 1) } gsub(/[ \t\n]+/, " ", sel); print "M5:" sel }' "$CSS"
# M6  pure black (U7). Expected: only mask-image lines.
$G -niE '#000([^0-9a-f]|$)|#000000|rgba?\( *0, *0, *0|rgba?\( *0 +0 +0|(^|[^-a-z])black([^-a-z]|$)' "$CSS" | $G -v mask-image
```

**Coverage gap: the checks read one rule at a time and cannot see the cascade.** A white-text
rule whose fill is changed by a `:hover`, `.is-*` or `--modifier` rule elsewhere passes M2 (the
`.plb-add--cta:hover` comment in the CSS records exactly this failure). When a diff adds or changes
a `background` in such a rule, read the white-text rule it lands on by hand.

**Coverage gap: the checks only read CSS.** For `index.html` and DOM-building JS, also inspect
inline styles by hand: `/usr/bin/grep -nE 'style="|\.style\.[a-zA-Z]|cssText|setProperty' index.html js/*.js`.
Any colour or opacity set there must follow U1 to U3 the same way.
