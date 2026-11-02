---
name: ts-css-finder
description: Find the real CSS selector for any element inside an embedded ThoughtSpot view (a KPI value, tile title, menu item, filter chip, header button), write the rules_UNSTABLE CSS that restyles it (align, hide, recolor, resize), prove the change by measuring it headless against the live cluster, and hand over the SDK code plus a playground link. Use when the user asks to "style", "center", "hide", "move", "recolor" or "write custom CSS for" something in an embed, asks "what's the CSS selector for…", or wants rules_UNSTABLE / customCSS code for a customer.
---

# ts-css-finder: from "make X look like Y" to tested rules_UNSTABLE code

ThoughtSpot renders inside a cross-origin iframe, so its DOM is not visible from the playground
page and selectors cannot be guessed. This skill inspects the **real** embed headless, picks
selectors that survive releases, and verifies the result by measurement and screenshot.

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
node $S '<link>' find 'text:Total sales'                 # find elements by visible text
node $S '<link>' find '[data-testid*="kpi" i]'            # …or by selector
node $S '<link>' tree '[data-testid="kpi_herodata"]' --up 14 --down 3   # why is it where it is?
node $S '<link>' measure '[data-testid="kpi_herodata"]'   # offset from tile center (0px = centered)
# every mode takes --shot <file.png>; tree takes --nth N; measure takes --tile '<selector>'
```

## Workflow

1. **Get a playground link that renders the target.** Use the user's link, or build one with the
   `link-generator` skill. Run `find … --shot` once and look at the screenshot. If tiles show "No
   data", an overlay or the wrong board, fix that first; you cannot style what does not render.
2. **Find the element.** `find 'text:<what the user sees>'` is the fastest start. Then `find` with a
   partial selector (`[data-testid*="kpi" i]`, `[class*="hero"]`) to see siblings of the same family.
3. **Understand its layout.** Run `tree` on the element. The cause is usually in the ancestors:
   - Left-aligned content: a flex parent with `justify`/`align = normal`, or `text-align: start`.
   - Off-center by a few px: a stray `margin` or `pad` on one side. Zero it.
   - Truncated text ("…"): the tile is too narrow. CSS centering cannot fix this.
4. **Pick selectors, most stable first:**
   1. `[data-testid="…"]`: test hooks, the most stable across releases.
   2. `[class*="heroDataContainer"]`: the part of a CSS-module class after `__`, matched by
      substring. Never use the full `module__name` class, and never use hashed classes.
   3. Scope with `:has()` to reach only some tiles, e.g.
      `.react-grid-item:has([data-testid="chartviz_kpi"]) [data-testid="dynamic-title-box"]`.
   Every rule hits **every** matching element in the embed. To target one tile, look for a
   per-tile attribute with `tree`; if none exists, say so.
5. **Write the rules** as `{ selector: { 'kebab-case-prop': 'value !important' } }`. Every value
   needs `!important`, or ThoughtSpot's own styles win.
6. **Apply them through the link and measure.** Encode with the local-only `link-generator`
   skill, which is not in the repo:
   `node .claude/skills/link-generator/link.mjs encode --base '<link>' --set 'styles.rules=<json>'`.
   Without it, paste the CSS into the playground's Custom styles → CSS rules box and copy the share
   link. Then
   then run `measure` (or `tree`) on the new link. Compare before and after with numbers, not just
   screenshots. Drop any rule whose removal does not change the measurement.
7. **Hand over**, in this order: the CSS, what each rule does, the before/after numbers, the
   screenshots, the playground link ("open it, then press ⌘R"), and the caveats below. For a
   customer, write a short `.md` with the `init()` snippet. Keep it outside the repo, with no
   customer names or data in anything committed.

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
- The CSS runs only inside the ThoughtSpot iframe, so it never affects the host page or
  host-drawn UI such as the playground's drill-through modal.
- In the playground itself: Custom styles → CSS rules accepts a pasted CSS block or a
  `rules_UNSTABLE` object, and it is saved in the share link as `styles.rules`.

## Caveats to always state

- `rules_UNSTABLE` targets ThoughtSpot's internal DOM, so selectors can break after an upgrade.
  Record the cluster build (shown in the iframe's CDN URLs, e.g. `26.11.0.cl`) and the SDK
  version you tested on.
- Selectors are global to the embed. Say exactly which elements change.
- `:has()` needs a current browser: Chrome/Edge 105+, Safari 15.4+, Firefox 121+.

## How the script gets in (and why)

- A trusted-auth link opened in a browser with no ThoughtSpot session stops at "Embed session not
  authenticated": the playground probes `session/user` before it mints. The script therefore logs
  the headless browser in first (`/callosum/v1/session/login/token` with a token from
  `/api/auth/token`), which matches a user who is already signed in.
- Headless Chrome blocks third-party cookies, which the iframe needs. The script launches with
  that blocking turned off.
- It compares the link's host with `/api/auth/config`'s `thoughtSpotHost` before minting anything.
  It also redacts the token from any login error, since puppeteer error messages quote the full URL.
- It then clicks the playground's "connect to this host?" confirm, waits for the iframe, then waits
  `--wait` ms (default 15000) for tiles to render. Raise it for slow boards.
