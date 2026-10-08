> ⚠️ **Superseded (2026-06-03).** The app was redesigned from the fictional "Vantage Sales"
> marketing shell into a tool-first **ThoughtSpot Embed Playground**. See `README.md` for the
> current architecture and run steps. The original app is preserved under `legacy/`. The notes
> below document the *old* build and remain useful for SDK lessons, but no longer describe the UI.

# Vantage Sales — ThoughtSpot Embed Playground
## Build Instructions, Lessons Learned & AI Prompt

---

## 1. What This App Is

A polished, client-facing demo shell that wraps all five ThoughtSpot Visual Embed SDK
components inside a fictional B2B sales company website ("Vantage Sales").

The landing page looks like a real product, complete with KPI cards, product categories,
and regional performance data drawn from a Sales dataset. Clicking "Explore Analytics"
enters a sidebar-driven analytics workspace where each ThoughtSpot embed type can be
tested independently.

An **Advanced panel** exposes SDK features interactively — runtime filters, runtime
parameters, action visibility, custom actions, host events, and CSS customization —
with a live **Embed Code** view showing exactly what changed in the SDK configuration.

**Primary use case:** Demonstrating ThoughtSpot embed capabilities to clients in a
realistic, production-like context.

---

## 2. Project File Structure

```
Project/
├── index.html          — All HTML. No inline CSS or JS.
├── config.js           — All ThoughtSpot GUIDs and settings. Edit this to switch clients.
├── css/
│   └── styles.css      — Complete design system (variables, landing, app, panels, tabs)
└── js/
    ├── auth.js         — Auth check utility (kept for reference, not used in main flow)
    ├── embed.js        — ThoughtSpot SDK wrapper: initSDK() + doRender()
    └── app.js          — Main controller: state, navigation, all advanced features
```

---

## 3. Dataset Context (Vantage Sales)

| Field | Description |
|---|---|
| Employee Name | Full name of the sales rep |
| Order Date | Date the order was placed |
| Ship Date | Date the order was shipped |
| Sales Order Number | Unique order identifier |
| Sales Amount | Actual sales revenue |
| Sales Amount Quota | Target sales amount |
| Quota % | Sales Amount / Sales Amount Quota |
| Gross Margin % | Profit / Sales |
| Rolling Sales Avg (3m) | 3-month rolling average (excluding current month) |
| Cycle Time in Days | Days from order placed to shipped |
| Product | Product name |
| Product Category | e.g. Technology, Furniture, Office Supplies |
| Product Sub Category | Sub-group of category |
| Country / Region / Territory | Geographic hierarchy |

---

## 4. ThoughtSpot Configuration

All values live in `config.js`. Use `window.TS_CONFIG = { ... }` — NOT `const TS_CONFIG`.

```js
window.TS_CONFIG = {
  thoughtSpotHost:   'https://YOUR-INSTANCE.thoughtspot.cloud',
  authType:          'None',

  worksheetId:       'GUID',   // Used by: SearchEmbed, SpotterEmbed
  liveboardId:       'GUID',   // Used by: LiveboardEmbed, Visualization
  vizId:             'GUID',   // Used by: Visualization (paired with liveboardId)

  searchTokenString: '[Sales Amount] [Region]',  // optional search pre-fill
  executeSearch:     false,
};
```

**Where to find GUIDs in ThoughtSpot:**
- Liveboard GUID: URL → `.../#/pinboard/<liveboardId>`
- Viz GUID: URL → `.../#/pinboard/<liveboardId>/viz/<vizId>`
- Worksheet GUID: Data tab → open the worksheet → check the URL

---

## 5. What Each Embed Needs

| Embed | SDK Class | Required Fields |
|---|---|---|
| Search Data | `SearchEmbed` | `dataSources: [worksheetId]` |
| Spotter AI | `SpotterEmbed` | `worksheetId` |
| Liveboard | `LiveboardEmbed` | `liveboardId`, `liveboardV2: true` |
| Visualization | `LiveboardEmbed` | `liveboardId` + `vizId`, `liveboardV2: true` |
| Full App | `AppEmbed` | `pageId: Page.Home`, `showPrimaryNavbar: false` |

---

## 6. How to Run

1. Install the **Live Server** extension in VS Code
2. Open the `Project/` folder in VS Code
3. Click **"Go Live"** in the bottom status bar (opens at `http://localhost:5500`)
4. In another tab, log into your ThoughtSpot instance
5. Return to `localhost:5500` — embeds will render using your active session cookie

> **Why localhost:5500?**
> Your instance's CORS allowlist (e.g. `your-instance.thoughtspot.cloud`) typically includes:
> `localhost`, `localhost:3000`, `localhost:4200`, `localhost:5500`, `localhost:8000`
> Opening from `file://` is not whitelisted and will block all SDK requests.

---

## 7. Design System

| Token | Value |
|---|---|
| Background | `#0A0F1E` |
| Surface | `#111827` |
| Surface raised | `#1a2235` |
| Border | `#1F2937` |
| Accent blue | `#3B82F6` |
| Accent indigo | `#6366F1` |
| Text primary | `#F9FAFB` |
| Text secondary | `#9CA3AF` |
| Success | `#10B981` |
| Font | Inter (Google Fonts) |

---

## 8. Lessons Learned — What Worked vs What Didn't

### CRITICAL BUGS ENCOUNTERED

#### Bug 1 — `const TS_CONFIG` is not `window.TS_CONFIG`
**Symptom:** `Cannot read properties of undefined (reading 'thoughtSpotHost')` on every embed call.

**Cause:** `const` and `let` at the top level of a script tag do NOT attach to the `window`
object. ES modules reading `window.TS_CONFIG` got `undefined`.

**Fix:** Use `window.TS_CONFIG = { ... }` in `config.js`.

---

#### Bug 2 — Async auth pre-flight blocked all rendering
**Symptom:** UI stuck at "Verifying connection..." forever. No embed ever appeared.

**Cause:** A `fetch()` to `/api/rest/2.0/auth/session/user` was called before every render.
When running from a non-whitelisted origin, the CORS preflight hung with no response,
and there was no `AbortController` timeout.

**Fix:** Remove the auth gate entirely. Call `init()` on `DOMContentLoaded` and render
directly on section switch. The embed iframe is not subject to CORS restrictions.

---

#### Bug 3 — "Unknown section: null" crash on advanced options
**Symptom:** Applying any advanced option produced `🔴 Unknown section: null`.

**Cause:** Advanced functions used the pattern `const s = currentSection; currentSection = null; renderEmbedNow(s)`
to force a re-render. After the first advanced re-render, `currentSection` stayed permanently `null`.

**Fix:** `renderEmbedNow(section)` always sets `currentSection = section` at the top.
All advanced functions call `renderEmbedNow(currentSection)` directly — no null trick needed.

---

#### Bug 4 — Wrong SDK property names

| Property | Wrong | Correct |
|---|---|---|
| Search datasource | `dataSource: 'guid'` (string) | `dataSources: ['guid']` (array) |
| Liveboard version | (missing) | `liveboardV2: true` |
| iframe sizing | `frameParams: { width: '100%', height: '100%' }` | `frameParams: {}` |

---

#### Bug 5 — `_addCssRuleRowWithValues` broke with double-quote selectors
**Symptom:** Adding a CSS rule row for `[data-testid="share-button"]` produced a broken
input value — the `"` in the selector terminated the HTML `value="..."` attribute early.

**Cause:** Row inputs were created with `innerHTML` template literals that included
`value="${selector}"`. Double quotes inside the selector broke the HTML attribute.

**Fix:** Remove `value=` from the innerHTML template entirely. After appending the element,
set values via JS: `row.querySelector('.csr-selector').value = sel`.

---

#### Bug 6 — Bottom panel pushed the embed up on expand
**Symptom:** Opening Event Log or Embed Code shrank the embed iframe because the panel
was a `flex-shrink: 0` child in the flex column.

**Fix:** Changed `#bottom-panel` to `position: fixed; bottom: 0; left: var(--sidebar-w); right: 0`
so it overlays the embed. Added `padding-bottom: var(--log-h)` to `#main` to reserve
space for the collapsed bar so it doesn't obscure content.

---

#### Bug 7 — Feature panel overlapped the embed on open
**Symptom:** Opening the Advanced panel (Runtime Filters, Custom Styles, etc.) slid over
the embed iframe rather than resizing the embed area.

**Fix:** On `openFeaturePanel`, add class `fp-open` to `#main`. CSS transitions
`#main { margin-right: 0 }` → `#main.fp-open { margin-right: 400px }` so the embed
container shrinks to make room. Reversed on `closeFeaturePanel`.

---

#### Bug 8 — Reset All didn't restore TS_CONFIG to config.js defaults
**Symptom:** After editing config via the Configure panel and clicking Reset All, the host/GUIDs
remained at the modified values rather than the originals from config.js.

**Fix:** On `DOMContentLoaded`, snapshot the original config:
  `window._TS_CONFIG_DEFAULT = { ...window.TS_CONFIG }`
In `resetAll()`, wipe all keys from `window.TS_CONFIG` and re-assign from the snapshot.
Then sync the Configure panel DOM fields (cfg-host, cfg-auth, cfg-worksheet, etc.) to the
restored values so the UI stays in sync.

---

#### Bug 9 — Gear icon opened options panel for wrong embed section
**Symptom:** Clicking ⚙ on a nav item while a different embed was active opened the gear
panel but still showed/applied options to the previously active section.

**Fix:** `openEmbedOpts(section, e)` now calls `switchSection(section)` before setting
`currentEoSection`, so the embed switches to match the gear icon that was clicked.

---

## 9. Full AI Prompt — Recreate From Scratch

Copy and paste the following into Claude to rebuild the complete app:

---

```
Build a ThoughtSpot Visual Embed SDK playground called "Vantage Sales" as static files
(no build tools, no bundler, no framework).

═══ TECH STACK ═══════════════════════════════════════════════════════════
- Plain HTML / CSS / JavaScript (ES modules via <script type="module">)
- ThoughtSpot Visual Embed SDK via CDN:
  https://unpkg.com/@thoughtspot/visual-embed-sdk/dist/tsembed.es.js
- Google Fonts: Inter
- No frameworks, no npm, no build step

═══ FILE STRUCTURE ═══════════════════════════════════════════════════════
Project/
├── index.html        — HTML only, no inline CSS or JS
├── config.js         — window.TS_CONFIG = { ... }  ← must use window., NOT const
├── css/styles.css    — all styles
└── js/
    ├── embed.js      — SDK wrapper: initSDK(config), doRender(section, config, callbacks, options)
    └── app.js        — main controller (ES module)

═══ CONFIG (config.js) ═══════════════════════════════════════════════════
window.TS_CONFIG = {
  thoughtSpotHost:   'https://your-instance.thoughtspot.cloud',
  authType:          'None',
  worksheetId:       'YOUR-WORKSHEET-GUID',
  liveboardId:       'YOUR-LIVEBOARD-GUID',
  vizId:             'YOUR-VIZ-GUID',
  searchTokenString: '[Sales Amount] [Region]',
  executeSearch:     true,
};
CRITICAL: window.TS_CONFIG, not const — ES modules cannot read non-window globals.

═══ INITIALIZATION (must follow exactly) ═════════════════════════════════
Call init() immediately on DOMContentLoaded. Never gate rendering behind an async
auth check — CORS prevents the preflight from resolving and hangs forever.

  document.addEventListener('DOMContentLoaded', () => {
    init({
      thoughtSpotHost: window.TS_CONFIG.thoughtSpotHost,
      authType: AuthType.None,
      ...(window.TS_CONFIG._customStyles && {
        customizations: { style: window.TS_CONFIG._customStyles }
      }),
    });
  });

═══ EMBED TYPES & SDK CONFIG ═════════════════════════════════════════════
Search:
  new SearchEmbed('#ts-embed-container', {
    frameParams: {},
    collapseDataSources: true,
    dataSources: [config.worksheetId],        // array, not string
    hiddenActions, disabledActions,
    searchOptions: { searchTokenString, executeSearch },
    runtimeParameters,
  })

Spotter:
  new SpotterEmbed('#ts-embed-container', {
    frameParams: {}, worksheetId, hiddenActions, disabledActions,
  })

Liveboard:
  new LiveboardEmbed('#ts-embed-container', {
    frameParams: {}, liveboardV2: true, liveboardId,
    hiddenActions, disabledActions, customActions, runtimeParameters,
  })

Visualization (single viz):
  new LiveboardEmbed('#ts-embed-container', {
    frameParams: {}, liveboardV2: true, liveboardId, vizId,
    hiddenActions, disabledActions, customActions, runtimeParameters,
  })

Full App:
  new AppEmbed('#ts-embed-container', {
    frameParams: {}, showPrimaryNavbar: false, pageId: Page.Home,
    modularHomeExperience: true,
    hiddenActions, disabledActions, customActions,
  })

═══ embed.js WRAPPER ═════════════════════════════════════════════════════
Export two functions:

  initSDK(config):
    Calls init({ thoughtSpotHost, authType: AuthType[config.authType] ?? AuthType.None,
      ...(config._customStyles && { customizations: { style: config._customStyles } }) })

  doRender(section, config, callbacks, options = {}):
    options destructures: { hiddenActions=[], disabledActions=[], customActions=[],
                            runtimeParameters=[] }
    const rtParams = runtimeParameters.length ? runtimeParameters : undefined
    Switch on section → create the right embed class with options spread in.
    Register events: AuthInit, EmbedListenerReady, Load, LiveboardRendered,
                     NoCookieAccess, Error, Data, CustomAction
    On CustomAction: call window.__onCustomAction(payload) if defined.
    Call embed.render() and return the embed instance.

Also export: HostEvent, Action, RuntimeFilterOp, CustomActionsPosition

═══ LAYOUT ════════════════════════════════════════════════════════════════
Two modes, toggled by showing/hiding #landing and #app divs.

MODE 1 — Landing Page:
  Fixed top nav: logo + links + "Explore Analytics" CTA
  Hero: gradient headline, subline, counters ($24.6M sales, 87% quota, 34.1% margin, 11.3d cycle)
  Feature grid: Product Categories (bar rows) + Regional Performance (2×2 grid)
  Analytics CTA banner

MODE 2 — Analytics App (#app):
  Left sidebar (240px): logo, "Advanced" toggle button, 5 embed nav items, divider, "Back to Home"
  Main area (#main, flex-column):
    Top header bar: section title + SDK badge left, "⚙ Configure" button right
    Embed area (flex:1, relative): #ts-embed-container (absolute inset:0)
      + #embed-loading overlay (absolute inset:0, z-index:10) with states:
        - checking: spinner + "Verifying…"
        - unauth: login prompt with link
        - cors: CORS warning with "Proceed anyway" option
        - error: error message + retry button
        - loading: spinner + "Loading embed…"
    Bottom panel (#bottom-panel): fixed to viewport bottom, overlays embed (does not push it up)

═══ BOTTOM PANEL (tabbed) ════════════════════════════════════════════════
Single panel with two tabs side by side in the header row:
  [● Event Log  N events] [</> Embed Code]   ... [Reset All] [Copy] [▲]

Tabs share one expand/collapse chevron (▲).
"Reset All" button: always visible with soft amber border/color (rgba(251,146,60,.8)),
  turns red on hover. Resets all advanced options AND restores TS_CONFIG to original
  config.js defaults (syncs Configure panel UI fields). Re-inits SDK and re-renders.
  Also shown on the Connection Error overlay next to Retry (amber styled, .ls-btn-reset).
"Copy" button: only visible on the Embed Code tab.

Event Log tab:
  Collapsed by default. New events prepend (newest first).
  Each row: timestamp | event type | event data
  Listen: EmbedEvent.Load, EmbedListenerReady, Error, LiveboardRendered,
          NoCookieAccess, Data, CustomAction, AuthInit

Embed Code tab:
  Shows delta-only SDK code — only the options that differ from defaults.
  Syntax-highlighted (comments, enum values, strings, keywords).
  If nothing changed: "// No advanced options applied yet."
  Updates live whenever advanced options change.

═══ ADVANCED SIDEBAR PANEL ═══════════════════════════════════════════════
A slide-out right panel (#feature-panel) triggered by "Advanced" button in sidebar.
Sub-panels (fp-content divs), one active at a time:

1. RUNTIME FILTERS (#fp-filters)
   Build filter rows: column name | operator dropdown (EQ/NE/LT/LE/GT/GE/IN) | value
   Apply via HostEvent.UpdateRuntimeFilters — no re-render needed.
   Works best on: Liveboard, Viz, Full App.

2. RUNTIME PARAMETERS (#fp-params)
   Build parameter rows: name | value
   Applied at render time as runtimeParameters: [{name, value}]
   Requires re-render. Works on: Search, Liveboard, Viz.

3. MODIFY ACTIONS (#fp-actions)
   Table of SDK Action enum values with Hide and Disable checkboxes.
   Applies hiddenActions/disabledActions arrays — requires re-render.
   Actions: Download, DownloadAsCsv, DownloadAsPdf, DownloadAsXlsx,
            Share, Edit, Pin, Explore, DrillDown, LiveboardInfo, SpotIQAnalyze

4. CUSTOM ACTIONS (#fp-custom-action)
   Form: label + position (START/END) → adds to customActions array.
   Chips show active actions with remove buttons.
   Registers window.__onCustomAction to capture EmbedEvent.CustomAction payload.
   Payload displayed in panel. Requires re-render.

5. CODE-BASED ACTIONS (#fp-code-action)
   Same as custom actions but defined entirely in code (no ThoughtSpot admin setup).
   Live code preview updates as user types label/position.
   Requires re-render.

6. HOST EVENTS (#fp-host-events)
   Trigger SDK host events on the active embed in real time:
   - Search query (HostEvent.Search) → Search Data embed
   - Navigate to path (HostEvent.Navigate) → Full App embed
   - Show only these vizs (HostEvent.SetVisibleVizs) → Liveboard/Viz
   - Reload (HostEvent.Reload) → all embeds
   Each row has a selector input + → trigger button.
   Context badges show which embed type each event targets.

7. CUSTOM STYLES (#fp-styles)
   Section A — Parse Element:
     Textarea (#cs-parse-input) + "→ Extract Selector" button.
     User pastes raw HTML copied from browser DevTools (Copy element).
     parseElementHtml() uses DOMParser to extract the best selector:
       Priority: data-testid > aria-label > id > first class
     Creates a new CSS rule row with the selector and "display: none !important".
     Clears the textarea after extraction and scrolls to the new row.

   Section B — CSS Rules (rules_UNSTABLE):
     Row builder: each row = CSS selector input + CSS declaration input
     (e.g. selector: [data-testid="share-button"], css: display: none !important)
     + Remove button per row. "+ Add Row" button.
     IMPORTANT: Row values are set via .value = assignment (not innerHTML),
     so selectors containing double-quotes (attribute selectors like
     [data-testid="foo"]) are handled correctly without HTML injection.

   Section B — Code Block:
     Textarea accepting JS-style rules_UNSTABLE format:
       '[data-testid="my-element"]': {
         display: 'none !important',
       },
     "↺ Sync" button imports code block into rows.
     Apply merges both sources (rows override code block for same selectors).

   Sample code block below the textarea (selectable, read-only, syntax-colored)
   showing common use cases.

   Apply re-inits SDK with customizations.style.customCSS.rules_UNSTABLE,
   then re-renders. Reset clears all rules and re-renders without customizations.

   NOTE: Quick Pick element selector was removed. To find selectors, open the
   embed in a separate browser tab, right-click any ThoughtSpot UI element →
   Inspect → look for data-testid attributes.

═══ ADVANCED STATE IN app.js ═════════════════════════════════════════════
let embedOptions = {
  hiddenActions: [], disabledActions: [], customActions: [],
  runtimeParameters: [],
  _hiddenKeys: [],    // Action enum key names for code view
  _disabledKeys: [],
  _activeFilters: [], // Current runtime filters for code view
};

renderEmbedNow(section) ALWAYS sets currentSection = section first.
All advanced apply functions call renderEmbedNow(currentSection) directly.
Never use the old "null trick" (currentSection = null then re-render).

openEmbedOpts(section, e) calls switchSection(section) first if currentSection !== section,
so clicking a gear icon on an inactive nav item switches the embed before opening the panel.

═══ EMBED CODE VIEW (delta only) ════════════════════════════════════════
generateEmbedCode() reads embedOptions + window.TS_CONFIG._customStyles.
Shows only what changed:
  - Embed class header comment + separator
  - new EmbedClass('#container', { hiddenActions, disabledActions,
      customActions, runtimeParameters }) with only non-empty arrays
  - .on(EmbedEvent.CustomAction, ...) if customActions present
  - embed.trigger(HostEvent.UpdateRuntimeFilters, [...]) if filters active
  - init({ customizations: { style: { customCSS: { rules_UNSTABLE } } } })
    if CSS rules applied
  - "// No advanced options applied yet." if nothing changed

Syntax colorizer (_colorize):
  - Comments: cv-comment (muted)
  - SDK enums (Action.X, HostEvent.X, etc.): cv-enum (indigo)
  - String literals: cv-str (green)
  - Keywords (new, const, embed, init, etc.): cv-kw (pink)

═══ DESIGN SYSTEM ════════════════════════════════════════════════════════
CSS variables on :root:
  --bg: #0A0F1E  --surface: #111827  --surface-2: #1a2235
  --border: #1F2937  --border-light: #2d3a4f
  --accent: #3B82F6  --accent-2: #6366F1
  --text-primary: #F9FAFB  --text-secondary: #9CA3AF  --text-muted: #4B5563
  --success: #10B981  --danger: #EF4444
  --sidebar-width: 240px  --log-h: 38px  --header-h: 52px

Font: Inter (Google Fonts), weights 300–900.
Dark sidebar with blur backdrop. Active nav: left accent bar + blue glow.
Buttons: gradient accent→accent-2, box-shadow glow on hover.
Slide-out panels: position fixed, right: -400px, transitions to right: 0 when .open
  Feature panel push: when .open, adds .fp-open class to #main which transitions
  margin-right: 0 → 400px so the embed area shrinks rather than being overlapped.
Bottom panel: position fixed, bottom: 0, left: var(--sidebar-w), right: 0; z-index: 300
  overlays the embed area. #main has padding-bottom: var(--log-h) to reserve space
  for the collapsed bar.

═══ EMBED LOADING OVERLAY ════════════════════════════════════════════════
On EmbedEvent.Load or EmbedEvent.EmbedListenerReady: add .fade-out class
(opacity:0 + pointer-events:none, 300ms transition), then display:none after 300ms.
4-second fallback setTimeout hides overlay if no SDK event fires.

═══ FILE PROTOCOL WARNING ════════════════════════════════════════════════
On DOMContentLoaded, if window.location.protocol === 'file:', show a fixed
orange/red banner: "Opening from file:// — embeds won't work. Use VS Code
Live Server → click Go Live → opens at localhost:5500"

═══ CONFIG PANEL ═════════════════════════════════════════════════════════
Slide-out from right (#config-panel, 370px). Groups:
  - ThoughtSpot Connection: host URL + auth type dropdown
  - Data Objects: worksheetId + liveboardId + vizId
  - Search Options: pre-fill query + auto-execute toggle
"Apply & Reload Embed" re-inits SDK and re-renders current section.
```

---

## 10. Key ThoughtSpot SDK Rules (Quick Reference)

1. **`window.TS_CONFIG`** — never `const TS_CONFIG`. ES modules can't see non-window globals.
2. **`init()` on DOMContentLoaded** — one call, immediately, before any user interaction.
3. **No async auth gate** — render directly. An iframe is not subject to CORS.
4. **CDN** — `https://unpkg.com/@thoughtspot/visual-embed-sdk/dist/tsembed.es.js`
5. **`dataSources: [array]`** — SearchEmbed takes an array, not a string.
6. **`liveboardV2: true`** — required for modern liveboard rendering.
7. **`frameParams: {}`** — leave empty; the SDK sizes the iframe to its container.
8. **`AuthType.None`** — user must be logged into the ThoughtSpot host in the same browser.
9. **CORS whitelist** — serve from `localhost:5500` (VS Code Live Server).
10. **`embed.destroy()`** — always destroy the previous embed before rendering a new one.
11. **Re-render vs live trigger** — actions/params/styles require re-render; runtime filters
    use `HostEvent.UpdateRuntimeFilters` and take effect immediately.
12. **Re-init for styles** — `customizations` is an `init()` option, not a render option.
    Changing CSS variables or rules requires calling `init()` again then re-rendering.
