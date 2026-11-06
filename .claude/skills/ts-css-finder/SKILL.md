---
name: ts-css-finder
description: Make any client styling ask for an embedded ThoughtSpot view real, out-of-the-box first. Check what ThoughtSpot already provides (admin Styles, hiddenActions/disabledActions, --ts-var-* CSS variables, Theme Builder, stringIDs text overrides, iconSpriteUrl, customCSSUrl) through the Spottercode MCP docs tool. Then, only for what's left, find the real CSS selector for ANY element (icon-only buttons, menu items that appear after a click, tooltips that appear on hover, icons, tile titles, KPI values, filter chips, custom/BYOC chart internals) and write rules_UNSTABLE that hide, recolor, resize, align or swap it. Prove every change by measuring it headless against the live cluster, and hand over the SDK code plus a playground link. Use when the user or a client asks to "hide", "remove", "style", "theme", "brand", "rename", "center", "move", "recolor", "change the icon of" or "write custom CSS for" anything in an embed, asks "what's the CSS selector/variable for…", or wants customizations / rules_UNSTABLE code.
---

# ts-css-finder: from "make X look like Y" to tested customization code

ThoughtSpot renders in a cross-origin iframe, so selectors can't be guessed from the host page.
`inspect.mjs` logs a headless Chrome in and inspects the **real** embed. It searches every embed
frame, including custom charts' nested iframes, and goes into open shadow roots.

**Prerequisites:**
- `npm install`, plus Chrome (or set `CHROME_PATH`).
- `npm start` on :3000. The script mints its login token there, so `.env` needs `TS_SECRET_KEY`
  and the link's user must be on the username allowlist (`npm run doctor`).
- The link's host must equal the server's `THOUGHTSPOT_HOST`. The script refuses any other host,
  because it skips the playground's "connect to this host?" prompt and a shared link must not be
  able to send a live token to a host it names.

```bash
S=.claude/skills/ts-css-finder/inspect.mjs
node $S '<link>' find 'text:Total sales'                 # own text (SVG labels too) or aria-label/title/alt/placeholder
node $S '<link>' find '[data-testid*="kpi" i]' --props display,fill   # any selector; --props = computed values
node $S '<link>' tree '[data-testid="kpi_herodata"]' --up 14 --down 3  # ancestors + children, with layout
node $S '<link>' measure '[data-testid="kpi_herodata"]'   # text offset from tile center (0px = centered)
node $S '<link>' find 'text:Download' --hover 'text:Sales and orders' \
     --click '[data-testid="answer-header-menu-button"]'  # --hover/--click: repeatable, run in order first
```
Other options: `--shot f.png`, `--nth N`, `--tile sel`, `--wait ms` (tile render, default 15000),
`--step-wait ms` (default 2000), `--width`/`--height`.

**Reading `find`'s output:**
- Each match shows its frame (`[ts]` or the custom chart's host), `(shadow)` if it sits in a
  shadow root, `(not rendered)` if it's 0×0, plus its layout, colors and icon source
  (`svg-use=#rd-icon-…`, `img`, `bg-image`, `mask`, `::before`).
- `suggested selector` is the best stable selector for the element.
- `ancestor hooks` are the nearest `data-testid`s above it.
- `ts-vars` lists the `--ts-var-*` variables that ThoughtSpot's own CSS reads on this element, as
  `property←variable`. An empty line means none were found in the readable stylesheets, not that
  none exist.

## Workflow

0. **Out of the box first.** `rules_UNSTABLE` breaks on upgrades, so stop at the first rung that
   does the job. Mix rungs freely, and say which rung each part of the answer uses.

   | # | Ask | Option | Doc |
   |---|---|---|---|
   | 1 | Logo, favicon, chart palette, chart/table fonts, nav color, footer (whole instance, no code) | Admin **Develop → Customizations → Styles** | [customize-style](https://developers.thoughtspot.com/docs/customize-style) |
   | 2 | Hide or disable an action, menu item or button | `hiddenActions` / `disabledActions` with `Action.*` | SDK `Action` |
   | 3 | Colors, fonts, radius, shadows, spacing | `customCSS.variables` (`--ts-var-*`); check `find`'s `ts-vars` | [css-variables-reference](https://developers.thoughtspot.com/docs/css-variables-reference) |
   | 4 | A whole brand theme | **Theme Builder** (Develop → Customizations); its JSON → `customCSS.variables` | [theme-builder-doc](https://developers.thoughtspot.com/docs/theme-builder-doc) |
   | 5 | Rename UI text | `content.stringIDs` (precise; IDs via `exposeTranslationIDs`) or `strings` (global substring, case-sensitive, longest first). Keep `{placeholders}`. | [customize-text](https://developers.thoughtspot.com/docs/customize-text) |
   | 6 | Replace an icon everywhere | `iconSpriteUrl`: a sprite whose `<symbol id>` reuses the `rd-icon-*` id from `find`. Needs CSP connect-src + img-src. | [customize-icons](https://developers.thoughtspot.com/docs/customize-icons) |
   | 7 | Fonts, or many rules hosted with the app | `customCSSUrl`: one file with variables, `@font-face` and rules. Its host goes on the CSP allowlist; `cdn.jsdelivr.net` is allowed by default. | [custom-css](https://developers.thoughtspot.com/docs/custom-css) |
   | 8 | Anything else | `rules_UNSTABLE`: steps 1–7 below | [custom-css](https://developers.thoughtspot.com/docs/custom-css) |

   Confirm the details through "Docs lookup", and confirm a variable on the live element with
   `ts-vars`, since names differ by release. CSS overrides beat the admin Styles settings.
   - To try Theme Builder JSON in the playground, wrap it as `{"variables": …}` or paste it as
     `:root{…}` CSS. A bare flat map gets dropped.
1. **Get a link that renders the target.** Use the user's link, or build one with `link-generator`.
   Run `find … --shot` and look at the screenshot: "No data", an overlay or the wrong board must
   be fixed first.
2. **Find it.**
   - Start with `find 'text:<visible text or button label>'`. If that misses, try a partial
     selector or `find '<container> button'`.
   - Tile buttons appear only while the tile is hovered (`--hover 'text:<tile title>'`).
   - Menus open on click (`--click '[data-testid="answer-header-menu-button"]'` for a tile's ⋯).
   - Tooltips need `--hover` on their trigger.
   - **If the text matches in more than one frame, decide which copy is on screen before writing
     CSS** (see "Custom charts").
3. **Understand it** with `tree`:
   - Left-aligned content: a flex parent with `justify`/`align` set to `normal`.
   - A few px off-center: a stray `margin` or `pad`.
   - Text cut off with "…": the tile is too narrow; CSS can't fix it.
   - An icon that won't recolor: an `svg-use` icon follows `fill`/`color`, but an `img` or
     `bg-image` icon must be replaced.
4. **Pick selectors, most stable first:**
   1. `[data-testid]`. If the element's own hook is generic (`menu-item-label-testid`), use the
      ancestor hook scoped by its container:
      `[data-testid="answer-header-action-menu"] [data-testid="download"]`.
   2. A CSS-module fragment, `[class*="heroDataContainer"]`. Never the full `module__x` class or a
      hashed one.
   3. `[aria-label="…"]`. It's localized, so say so if you use it.
   4. `:has()` to scope to some tiles:
      `.react-grid-item:has([data-testid="chartviz_kpi"]) …`.

   Rules hit every match in the embed. A second copy at `y<0` is normal (a hidden clone). If no
   per-tile attribute exists, say so.
5. **Write** `{ selector: { 'kebab-prop': 'value !important' } }`. Without `!important`,
   ThoughtSpot's own styles win.
6. **Apply and measure.**
   - Encode with `node .claude/skills/link-generator/link.mjs encode --base '<link>' --set
     'styles.rules=<json>'` (local-only skill). Or paste into Custom styles → CSS rules and click
     **Apply — reload embed**; nothing applies until then.
   - Re-run with the **same `--hover`/`--click` steps** and `--props` on what you changed, and
     compare numbers before and after.
   - Also check what must not change, such as the other menu items or the bar tooltip.
   - Drop any rule whose removal changes nothing.
   - **Recolor test** when unsure you have the visible element: set it to `background: red
     !important`. If the box on screen doesn't turn red, it's the wrong element.
7. **Hand over:**
   1. The supported options used (by rung), then any CSS with what each rule does and why no
      supported option covered it.
   2. Before/after numbers and screenshots.
   3. The link ("open it, then press ⌘R").
   4. The caveats.
   - For a customer, write a short `.md` with the `init()` snippet, outside the repo and with no
     customer names.

## Docs lookup (Spottercode MCP)

Use `get-developer-docs-reference` (`mcp__claude_ai_Spottercode__get-developer-docs-reference`).
It's usually deferred, so load it with `ToolSearch` `select:<name>`. It only reads docs and SDK
types, and needs no org. Always pass `environment: {sdkVersion, clusterVersion}`; the cluster
version is in the iframe's CDN URL, e.g. `26.11.0.cl`. Never recommend a member marked
`availableInYourVersion: false`; state the version it needs instead. Verified 2026-11-04:

| Need | Call | Returns |
|---|---|---|
| A variable for X | `query: "CSS variable for <component> <property>"` | Reference rows with descriptions |
| All variables, version-checked | `symbol: "CustomCssVariables"` | 356 vars with descriptions; feature flags noted (e.g. `isLiveboardMasterpiecesEnabled`) |
| The action behind a control | `symbol: "Action"` | 213 members: `name` (`Action.Download`), `value` (`"download"`), description |
| What `customizations` takes | `symbol: "CustomisationsInterface"` | `content`, `iconSpriteUrl`, `style` |
| One page | `pageId` = URL slug (`customize-text`, `customize-icons`, `theme-builder-doc`, `custom-css`, `customize-style`) + `query` | That page only. `css-variables-reference` does **not** filter. |

- Large symbol results (78–104k chars) get saved to a file. Search that file instead of reading it:
  ```bash
  python3 -c "import json,sys;c=json.load(open(sys.argv[1]))['results'][0]['content'];[print(m['name'],m.get('availableInYourVersion'),(m.get('description') or '')[:90]) for m in json.loads(c[c.index('{'):])['members'] if sys.argv[2] in m['name']]" "$FILE" chip
  ```
- Matching `find` output to `Action`: a menu item's `data-testid` is often the `Action` value
  (`download` → `Action.Download`). Confirm with the member's description. Buttons differ:
  `highlights-button` is `Action.AIHighlights`.
- Playground links take `Action` **names** (`hiddenActions: ["Download"]`); a value like
  `"download"` is silently dropped. To check what reached the embed, read `hideAction=` in the
  ThoughtSpot iframe URL.

## Recipes (verified 2026-11-04, cluster 26.11.0.cl, SDK 1.49.0, Liveboard)

Each CSS value below also needs `!important`.

| Ask | Supported (use this) | CSS (one element only / no supported option) |
|---|---|---|
| Hide AI Highlights | `hiddenActions: [Action.AIHighlights]` (not rendered at all) | `[data-testid="highlights-button"] {display:none}` |
| Hide Download in tile menus | `hiddenActions: [Action.Download]` (the rest of the menu is intact) | `[data-testid="answer-header-action-menu"] [data-testid="download"] {display:none}` |
| Recolor a button | `--ts-var-button--secondary-background` (affects **all** secondary buttons) | `[data-testid="share-button"] {background-color:#ffe08a}` |
| Swap an icon | `iconSpriteUrl` with `<symbol id="rd-icon-share">` (everywhere) | Hide `[data-testid="share-button"] svg use`, then give the `svg` a `background: url("data:image/svg+xml;utf8,…") center/contain no-repeat` (`#` → `%23`) |
| Tile title color/font/size | `--ts-var-viz-title-color`, `-font-family`, `--ts-var-liveboard-tile-title-fontsize` | (only for a single tile) |
| Custom-chart axis labels: no tooltip, keep the bar tooltip | none | `.muze-axis-container .muze-ticks {pointer-events:none}` |

```js
init({ thoughtSpotHost, authType, /* … */
  customizations: {
    style: {
      customCSSUrl: 'https://cdn.jsdelivr.net/gh/<org>/<repo>/theme.css',   // optional, loads first
      customCSS: {
        variables: { '--ts-var-viz-title-color': '#1d232f' },
        rules_UNSTABLE: { '[data-testid="kpi_herodata"]': { 'text-align': 'center !important' } },
      },
    },
    content: { stringIDs: { 'Facet.objectType.pinboards': 'Dashboards' } },
    iconSpriteUrl: 'https://cdn.jsdelivr.net/gh/<org>/<repo>/icons.svg',
  },
});
new LiveboardEmbed('#embed', { liveboardId, hiddenActions: [Action.Download, Action.AIHighlights] });
```
- `init()` customizations apply to every embed on the page.
- A per-embed `customCSS` **replaces** the `init()` one (a shallow merge), so copy across any
  rules that are still needed.
- The CSS only runs inside the ThoughtSpot iframe and the custom charts nested in it.

## Custom charts (BYOC / Muze)

A custom chart runs in its own iframe nested inside ThoughtSpot's (for example
`hc-advanced-stacked-bar.pdom.thoughtspot.com`). `rules_UNSTABLE` **does** reach it.

**The tooltip you see is not the chart's.** ThoughtSpot copies it into its own frame, at
`div.tooltip-module__chromelessTooltip > div`, inside a **shadow root**:
- One host serves every tooltip kind (axis label and data point alike).
- Outside CSS can't select inside the shadow root.
- The shared `:host` variables (`--tooltip-*`) restyle all tooltip kinds at once.

So:
- Hiding the chart's own `.muze-header-tooltip-container` measures as hidden but changes nothing
  on screen. This mistake was shipped once.
- Hiding `[class*="chromelessTooltip"]` kills every tooltip.
- **Stop the trigger instead**, inside the chart frame (see the last recipe).
  - Verify that `find '[class*="chromelessTooltip"]' --hover 'text:<label>'` returns no match.
  - Then confirm that hovering a bar still shows the copy.
  - Caveat for the user: the labels also lose clicks and the full-name tooltip on "…" labels.

## Caveats to always state

- `rules_UNSTABLE` uses internal DOM, so it can break on upgrade. Record the cluster build and the
  SDK version tested.
- Selectors are global to the embed. Name exactly what changes.
- Hiding with CSS is cosmetic, not a permission. Use privileges or `hiddenActions`.
- `:has()` needs Chrome/Edge 105+, Safari 15.4+ or Firefox 121+.
- Screenshots: the script turns site isolation off because nested frames otherwise screenshot
  blank or stale. If a screenshot and the DOM numbers disagree, run the recolor test.
