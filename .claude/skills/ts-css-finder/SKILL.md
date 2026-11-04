---
name: ts-css-finder
description: Find the real CSS selector for ANY element inside an embedded ThoughtSpot view, including icon-only buttons, menu items that appear only after a click, tooltips and popovers that appear on hover, icons, tile titles, KPI values, filter chips, and custom (BYOC) chart internals. Then write the rules_UNSTABLE CSS that hides, recolors, resizes, aligns or swaps it, prove the change by measuring it headless against the live cluster, and hand over the SDK code plus a playground link. Use when the user or a client asks to "hide", "remove", "style", "center", "move", "recolor", "change the icon of" or "write custom CSS for" anything in an embed, asks "what's the CSS selector for…", or wants rules_UNSTABLE / customCSS code.
---

# ts-css-finder: from "make X look like Y" to tested rules_UNSTABLE code

ThoughtSpot renders inside a cross-origin iframe, so its DOM is not visible from the playground
page and selectors cannot be guessed. This skill inspects the **real** embed headless, reaches UI
that only exists after a hover or click, picks selectors that survive releases, and verifies the
result by measurement and screenshot.

Script: `.claude/skills/ts-css-finder/inspect.mjs`. Prerequisites:
- Node 18+, `npm install` done, and Google Chrome (or `CHROME_PATH`).
- `npm start` running on :3000 (`--server` to change). The script mints its login token there, so
  `.env` needs `TS_SECRET_KEY`, and the link's user must be on the username allowlist
  (`npm run doctor` checks this).
- The link's host must equal the server's `THOUGHTSPOT_HOST`. The script refuses any other host:
  it skips the playground's "connect to this host?" prompt, and a shared link must not be able to
  send a live token to a host it names.
- The target must render with data. If it does not, run `find … --shot` and look at the screenshot.

```bash
S=.claude/skills/ts-css-finder/inspect.mjs
node $S '<link>' find 'text:Total sales'                  # visible text (SVG chart labels included)
node $S '<link>' find 'text:Share'                        # icon-only button, via aria-label/title
node $S '<link>' find '[data-testid*="kpi" i]'             # …or any CSS selector
node $S '<link>' tree '[data-testid="kpi_herodata"]' --up 14 --down 3   # why is it where it is?
node $S '<link>' measure '[data-testid="kpi_herodata"]'    # offset from tile center (0px = centered)
node $S '<link>' find '[data-testid="share-button"] svg' --props fill,width,height   # any computed props
# UI that needs interaction: --hover / --click, repeatable, run in the order given:
node $S '<link>' find 'text:Download' --hover 'text:Sales and orders' \
     --click '[data-testid="answer-header-menu-button"]'   # hover tile → open its ⋯ menu → find item
node $S '<link>' find 'text:Southwest' --hover 'text:Southwest'      # hover a label → find its tooltip
```
Options: `--shot <file.png>`, `--step-wait ms` (default 2000, after each hover/click),
`--props a,b,c`, `--nth N` (tree), `--tile '<selector>'` (measure), `--wait ms` (default 15000,
tile render), `--width`/`--height` (viewport, default 1600×1000).

**What `find` reports for each match:**
- The frame: `[ts]` is the ThoughtSpot iframe; a custom chart's host is its own nested iframe.
  Elements inside a shadow root are marked `(shadow)`.
- Tag, classes, `data-testid`, `aria-label`/`title`, layout and position (`x y w h`).
- Colors (`color`, `bg`, and `fill` on SVG), or whatever properties you pass with `--props`.
- **Icon source**: `svg-use=#rd-icon-…` (a sprite icon), `img=…`, `bg-image`, `mask`, or
  `::before`/`::after` content.
- `(not rendered)` when it is in the DOM but hidden or 0×0.
- A **suggested selector**, plus the **ancestor hooks** (the nearest `data-testid`s above it).
- **`ts-vars:`** lists the documented `--ts-var-*` variables that ThoughtSpot's own CSS already uses
  on this element, as `property←variable` (e.g. `color←--ts-var-viz-title-color`). If the property
  you need is listed, set that variable instead of writing a rule (Workflow step 0). It's read
  from the stylesheets the frame can access, so an empty line means "none found", not "none
  exist": check the docs too.

`text:` matches an element that owns a text node with the words, or whose `aria-label`, `title`,
`alt`, `placeholder` or `data-tooltip` contains them.

## Workflow

0. **Check what ThoughtSpot already provides out of the box, before any CSS rule.**
   `rules_UNSTABLE` is the last resort, because it breaks when ThoughtSpot's DOM changes. Go down
   this ladder and stop at the first rung that does the job:

   | # | Ask | Out-of-the-box option | Doc |
   |---|---|---|---|
   | 1 | Logo, favicon, chart color palette, chart/table fonts, nav color, footer, page title (whole instance, no code) | Admin **Develop → Customizations → Styles** | [customize-style](https://developers.thoughtspot.com/docs/customize-style) |
   | 2 | Hide or grey out an action, menu item or button (Download, Share, Pin, Edit, …) | `hiddenActions` / `disabledActions` (+ `disabledActionReason`) with `Action.*`. Confirm the member exists with the MCP `symbol: "Action"` lookup. | SDK `Action` enum |
   | 3 | Colors, fonts, radius, shadows, spacing of a component | `customizations.style.customCSS.variables` (`--ts-var-*`). `find` prints the variables that already style the element (`ts-vars:`). | [css-variables-reference](https://developers.thoughtspot.com/docs/css-variables-reference) |
   | 4 | A whole brand theme, or a theme from brand assets | **Theme Builder** (Develop → Customizations → Theme Builder; AI or Manual mode). Its exported JSON goes into `customCSS.variables`. To try it in the playground, paste it into the CSS rules box wrapped as `{"variables": <the JSON>}`, or as `:root { … }` CSS. A bare flat `{"--ts-var-…": …}` map is not recognised as variables and gets dropped. | [theme-builder-doc](https://developers.thoughtspot.com/docs/theme-builder-doc) |
   | 5 | Rename UI text | `customizations.content.stringIDs` (precise; find IDs with `exposeTranslationIDs`, the playground's Custom styles → *expose IDs*), or `strings` (substring, global, case-sensitive; longest first). Keep `{placeholders}`. | [customize-text](https://developers.thoughtspot.com/docs/customize-text) |
   | 6 | Replace an icon (one or many) | `customizations.iconSpriteUrl`: an SVG sprite whose `<symbol id>` reuses the `rd-icon-*` id that `find` reports as `svg-use=`. The host needs CSP connect-src + img-src. | [customize-icons](https://developers.thoughtspot.com/docs/customize-icons) |
   | 7 | Fonts, or many rules hosted with the app | `customizations.style.customCSSUrl`: one file holding variables, `@font-face` and rules. The host goes on the CSP allowlist (Develop → Security Settings); `cdn.jsdelivr.net` is allowed by default. | [custom-css](https://developers.thoughtspot.com/docs/custom-css) |
   | 8 | Anything else | `rules_UNSTABLE`: the rest of this workflow | [custom-css](https://developers.thoughtspot.com/docs/custom-css) |

   - **Look these up live; don't trust this table's details.** All six pages are indexed by the
     Spottercode MCP. Call `get-developer-docs-reference` with the ask, e.g. `query: "CSS variable
     for viz tile title color"`, or `pageId`/`symbol` for exact members. Pass `environment.sdkVersion`
     when you know it, so the MCP flags members your version lacks. Fall back to the doc links if the
     MCP is unavailable.
   - **Use the live DOM to confirm.** A variable name in the docs is only a candidate until `find`'s
     `ts-vars:` line shows ThoughtSpot's CSS reading it on that element. The docs note that some
     names differ by release.
   - **Mix freely, and say which rung each part uses.** For example, `variables` for the colors
     plus one `rules_UNSTABLE` rule for the one thing no variable covers. Note that CSS overrides
     beat the admin Styles settings.
1. **Get a playground link that renders the target.** Use the user's link, or build one with the
   `link-generator` skill. Run `find … --shot` once and look at the screenshot. If tiles show "No
   data", an overlay or the wrong board, fix that first; you cannot style what does not render.
2. **Reach and find the element.**
   - Start with `find 'text:<what the user sees or the button's label>'`. If there's no hit, try a
     partial selector (`[data-testid*="share" i]`, `[class*="hero"]`) or
     `find '<container> button'` to list a region's controls.
   - If it only appears after interaction, add the steps in order:
     - Tile buttons show only while hovering the tile: `--hover 'text:<tile title>'`.
     - Menus open on click: `--click '[data-testid="answer-header-menu-button"]'` (a tile's ⋯), or
       `--click 'text:More'` (the Liveboard's ⋯).
     - Tooltips: `--hover` the thing that triggers them.
   - If the same text matches in more than one frame, **work out which copy is on screen before
     writing CSS** (see "Custom charts"). A rule that hides a copy nobody sees still measures as
     hidden.
3. **Understand it.** Run `tree` on the element. The cause is usually in the ancestors:
   - Left-aligned content: a flex parent with `justify`/`align = normal`, or `text-align: start`.
   - Off-center by a few px: a stray `margin` or `pad` on one side. Zero it.
   - Truncated text ("…"): the tile is too narrow. CSS centering cannot fix this.
   - An icon that won't recolor: check `icon{…}`. A `svg-use` icon follows `fill`/`color`. An `img`
     or `bg-image` icon must be replaced, not recolored.
4. **Pick selectors, most stable first:**
   1. `[data-testid="…"]`: test hooks, the most stable across releases. If the element's own hook
      is generic (every menu label is `menu-item-label-testid`), use the **ancestor hook** that
      names the item (`[data-testid="download"]`), scoped by its container
      (`[data-testid="answer-header-action-menu"] [data-testid="download"]`).
   2. `[class*="heroDataContainer"]`: the part of a CSS-module class after `__`, matched by
      substring. Never use the full `module__name` class, and never use hashed classes.
   3. `button[aria-label="Share"]`: works, but it's localized, so it breaks for non-English users.
      Say so if you use it.
   4. Scope with `:has()` to reach only some tiles, e.g.
      `.react-grid-item:has([data-testid="chartviz_kpi"]) [data-testid="dynamic-title-box"]`.
   Every rule hits **every** matching element in the embed. The same control often exists twice
   (`find` shows a second copy at `y<0`: a hidden header or an off-screen clone). That's fine,
   but say it. To target one tile, look for a per-tile attribute with `tree`; if none exists, say so.
5. **Write the rules** as `{ selector: { 'kebab-case-prop': 'value !important' } }`. Every value
   needs `!important`, or ThoughtSpot's own styles win. See "Recipes".
6. **Apply them through the link and measure.** Encode with the local-only `link-generator`
   skill, which is not in the repo:
   `node .claude/skills/link-generator/link.mjs encode --base '<link>' --set 'styles.rules=<json>'`.
   Without it, paste the CSS into the playground's Custom styles → CSS rules box, click **Apply —
   reload embed**, and copy the share link. A rule does not reach the embed until Apply or a
   reload.
   - Re-run `find`/`measure` on the new link **with the same `--hover`/`--click` steps**, plus
     `--props display,…` for the properties you changed.
   - Compare before and after with numbers, not just screenshots. Drop any rule whose removal does
     not change the measurement.
   - Measure the element the user **sees**. If in doubt, run a recolor test: set the candidate's
     `background` to `red !important` and screenshot it. If the box on screen does not turn red,
     you have the wrong element.
   - Check what must NOT change: for example, the other menu items still `display=flex`, or the
     bar tooltip still appears.
7. **Hand over**, in this order: the CSS, what each rule does, the before/after numbers, the
   screenshots, the playground link ("open it, then press ⌘R"), and the caveats below. For a
   customer, write a short `.md` with the `init()` snippet. Keep it outside the repo, with no
   customer names or data in anything committed.

## Recipes (tested 2026-11-04, cluster 26.11.0.cl, SDK 1.49.0, Liveboard embed)

Each recipe was applied through a playground link and verified with `find --props` plus a screenshot.

| Ask | Rule(s) | Found with |
|---|---|---|
| Hide a header button | `[data-testid="highlights-button"] { display: none }` | `find 'text:AI Highlights'` |
| Recolor a button | `[data-testid="share-button"] { background-color: #ffe08a }` | `find 'text:Share'` |
| Swap one icon | `[data-testid="share-button"] svg use { display: none }` and `[data-testid="share-button"] svg { background: url("data:image/svg+xml;utf8,<svg …>") center / contain no-repeat }` | `find '[data-testid="share-button"] svg'` → `icon{svg-use=#rd-icon-share}` |
| Hide one tile-menu item | `[data-testid="answer-header-action-menu"] [data-testid="download"] { display: none }` (prefer `hiddenActions: [Action.Download]`) | `find 'text:Download' --hover 'text:<tile>' --click '[data-testid="answer-header-menu-button"]'`, then read the ancestor hooks |
| No tooltip on a custom chart's axis labels, keep the bar tooltip | `.muze-axis-container .muze-ticks { pointer-events: none }` | see "Custom charts" |

(Every value also needs `!important`. It's left out above to keep the table short.)

Icon notes:
- ThoughtSpot icons are sprite references: `<svg><use href="#rd-icon-NAME">`.
- To recolor one, set `fill`/`color` on the `svg`.
- To swap one, hide the `use` and paint the `svg` with a `background` (a `data:` SVG works, with `#`
  escaped as `%23`).
- To swap icons everywhere, use `iconSpriteUrl` instead.
- Icons drawn with `img`, `bg-image` or `::before` need `content: url(…)` or `background-image`
  on the element `find` reports.

## Applying the code (what to tell developers)

```js
init({
  thoughtSpotHost, authType, /* … */
  customizations: { style: { customCSS: { rules_UNSTABLE: {
    '[data-testid="kpi_herodata"]': { 'text-align': 'center !important' },
  } } } },
});
```

- Rules in `init()` apply to every embed on the page.
- A per-embed `customizations.style.customCSS` **replaces** the `init()` one (a shallow merge), so
  copy any `init()` rules that are still needed into it.
- The CSS runs only inside the ThoughtSpot iframe (and custom charts nested in it), so it never
  affects the host page or host-drawn UI such as the playground's drill-through modal.
- In the playground itself: Custom styles → CSS rules accepts a pasted CSS block or a
  `rules_UNSTABLE` object, then **Apply — reload embed**. It is saved in the share link as
  `styles.rules`.

## Custom charts (BYOC / Muze) and their tooltips

A custom chart tile runs in **its own cross-origin iframe nested inside** the ThoughtSpot iframe
(for example `hc-advanced-stacked-bar.pdom.thoughtspot.com`). `find` labels it by that host.

- **`rules_UNSTABLE` does reach that iframe.** ThoughtSpot forwards `customCSS` into it, so axis
  labels, bars and legends inside the chart can be styled.
- **The tooltips you see are not the chart's own.** The chart draws a tooltip in its frame, and
  ThoughtSpot then copies it into its own frame, under
  `div.tooltip-module__chromelessTooltip > div`, inside a **shadow root** with a fixed stylesheet.
  One host serves every tooltip kind (axis-label "header" tooltip and data-point tooltip alike), and
  nothing on the host tells them apart. Outside CSS cannot select inside a shadow root.
  - Hiding the chart's own `.muze-header-tooltip-container` measures as hidden but changes
    nothing on screen. This exact mistake was shipped once.
  - Hiding `[class*="chromelessTooltip"]` hides **every** custom-chart tooltip, data points included.
  - CSS variables do cross the shadow boundary, but the shadow stylesheet's `:host` variables
    (`--tooltip-background-color`, `--tooltip-opacity`, …) are shared by all tooltip kinds.
- **To suppress one kind of tooltip, stop its trigger inside the chart's iframe**, not the tooltip:
  `.muze-axis-container .muze-ticks { pointer-events: none !important; }` removes the axis-label
  tooltip and keeps the bar tooltip.
  - To verify: `find '[class*="chromelessTooltip"]' --hover 'text:<label>'` must return no match.
    Then hover a bar (bars are unclassed `rect`s; pick one with `tree`) and confirm the copy still
    appears.
  - Caveat for the user: the labels also lose clicks, and the full-name tooltip on truncated
    ("…") labels.

## Screenshots

The script turns site isolation off (`site-per-process`) so nested custom-chart frames render in
the same process. With it on, headless screenshots of those frames came back blank, or showed a
tooltip the DOM had already removed. If a screenshot disagrees with the DOM numbers, trust neither:
run the recolor test (Workflow step 6).

## Caveats to always state

- `rules_UNSTABLE` targets ThoughtSpot's internal DOM, so selectors can break after an upgrade.
  Record the cluster build (shown in the iframe's CDN URLs, e.g. `26.11.0.cl`) and the SDK
  version you tested on.
- Selectors are global to the embed. Say exactly which elements change.
- Hiding a control with CSS is cosmetic, not a permission: the feature is still reachable through
  other paths and the API. For real restrictions, use privileges or `hiddenActions`.
- `:has()` needs a current browser: Chrome/Edge 105+, Safari 15.4+, Firefox 121+.

## How the script gets in (and why)

- A trusted-auth link opened in a browser with no ThoughtSpot session stops at "Embed session not
  authenticated": the playground probes `session/user` before it mints. The script therefore logs
  the headless browser in first (`/callosum/v1/session/login/token` with a token from
  `/api/auth/token`), which matches a user who is already signed in.
- Headless Chrome blocks third-party cookies, which the iframe needs. The script launches with
  that blocking turned off, and with site isolation off (see Screenshots).
- It compares the link's host with `/api/auth/config`'s `thoughtSpotHost` before minting anything.
  It also redacts the token from any login error, since puppeteer error messages quote the full URL.
- It then clicks the playground's "connect to this host?" confirm, waits for the iframe, then waits
  `--wait` ms (default 15000) for tiles to render. Raise it for slow boards.
- `--click`/`--hover` targets are searched in every embed frame; the first visible match wins. The
  script converts that frame's coordinates to the page and moves the real mouse, so the app's own
  hover and click handlers fire.
