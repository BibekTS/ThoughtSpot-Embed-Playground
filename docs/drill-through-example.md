# Drill-Through from an Embedded ThoughtSpot Liveboard

**Two patterns: click a chart to open another Liveboard, or right-click for a list of linked records**

This guide shows how to add two drill-through interactions to a Liveboard embedded with the ThoughtSpot Visual Embed SDK:

| | Approach A: left-click, open a Liveboard | Approach B: right-click, "View orders" list |
|---|---|---|
| **User gesture** | One left-click on a chart point or table cell | Right-click → pick **View orders** from ThoughtSpot's menu |
| **What opens** | A second, more detailed Liveboard, filtered to the clicked point | A list of order records drawn by your app, each row a link (e.g. to the order in your system) |
| **SDK pieces** | `EmbedEvent.VizPointClick`, `HostEvent.GetFilters`, `runtimeFilters` | `customActions` (`CONTEXTMENU` / `VIZ`), `EmbedEvent.CustomAction` |
| **Backend call** | None | `POST /api/rest/2.0/searchdata`, through your backend |
| **ThoughtSpot's own menu** | Hidden on left-click while you listen for clicks | Kept: Filter, Drill down, etc. stay available |

You can run both at once on the same Liveboard. Left-click drills to the detail Liveboard, and right-click still opens ThoughtSpot's menu with **View orders** added to it.

> **Tested on:** ThoughtSpot 26.8.0.cl with Visual Embed SDK 1.49.0. Every behaviour marked *(verified)* below was observed on that build.

---

## Requirements

| Feature | Minimum version |
|---|---|
| `EmbedEvent.VizPointClick` | SDK 1.11.0 · ThoughtSpot 8.3.0.cl |
| `HostEvent.GetFilters` | SDK 1.23.0 · ThoughtSpot 9.4.0.cl |
| Code-based `customActions` (incl. `dataModelIds`, `metadataIds`) | SDK 1.43.0 · ThoughtSpot 10.14.0.cl |
| `POST /api/rest/2.0/searchdata` | ThoughtSpot 9.0.0.cl |

For Approach B, the user also needs at least view access to the detail Model. If Role-Based Access Control is on, they also need the **Can download detailed data** privilege (`CAN_DOWNLOAD_DETAILED_DATA`).

---

## Shared helpers: reading the clicked point

Both approaches start from the same question: *what did the user click?* ThoughtSpot sends the answer in a slightly different shape depending on the surface, so it is worth handling that in one place.

Things to know about the payload *(verified)*:

- **`selected*` is the cell that was clicked, and `deselected*` is the rest of that row.** Clicking a bar or bubble fills `selectedAttributes`. Clicking a *measure* cell in a table leaves `selectedAttributes` empty and puts the row's attributes (Employee, Territory, Date…) in `deselectedAttributes`. If you read only `selectedAttributes`, a table click carries no scope, and the drill silently shows *everything*.
- **Left-click payloads use `data.clickedPoint`.** Context-menu payloads use `data.contextMenuPoints`, which is an **object** (`{ clickedPoint, selectedPoints }`) on tables and an **array** on some other surfaces.
- **Bucketed dates arrive wrapped, with a raw epoch value**, for example `Day(Order Date)` = `1769644800`. The wrapper is only a display name. Before you use the value as a filter or a search token, strip the wrapper to get `Order Date`.
- **Nulls arrive as the string `'{Null}'`.** Skip them rather than filtering on them.

```js
import {
  init, AuthType, LiveboardEmbed, EmbedEvent, HostEvent, RuntimeFilterOp,
  CustomActionsPosition, CustomActionTarget,
} from '@thoughtspot/visual-embed-sdk';

/** The clicked point, for both a left-click and a context-menu action. */
function clickedPoint(payload) {
  const d = payload?.data ?? payload ?? {};
  const cmp = d.contextMenuPoints;
  return d.clickedPoint
    ?? (Array.isArray(cmp) ? cmp[0] : cmp?.clickedPoint)
    ?? d.selectedPoints?.[0]
    ?? null;
}

/** The point's attribute values as [{ column, value }], nulls dropped. */
function pointAttributes(point) {
  if (!point) return [];
  const attrs = point.selectedAttributes?.length
    ? point.selectedAttributes
    : (point.deselectedAttributes || []);          // table measure-cell click
  return attrs
    .map(a => ({ column: a.column?.name, value: a.value }))
    .filter(a => a.column && a.value != null && a.value !== '' && a.value !== '{Null}');
}

const BUCKET = /^(Day|Week|Month|Quarter|Year)\((.+)\)$/i;

/** "Month(Order Date)" → { bucket: 'month', name: 'Order Date' }; no wrapper → bucket ''. */
function splitBucket(column) {
  const m = BUCKET.exec(String(column).trim());
  return m ? { bucket: m[1].toLowerCase(), name: m[2] } : { bucket: '', name: column };
}

/** Epoch seconds (accepts seconds or milliseconds). */
function toEpochSec(v) {
  const n = Number(v);
  return n >= 1e11 ? Math.floor(n / 1000) : n;
}

/** Inclusive last second of a week/month/quarter/year bucket, in UTC. */
function bucketEndSec(bucket, startSec) {
  const d = new Date(startSec * 1000);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate();
  const next = {
    week: Date.UTC(y, mo, da + 7),
    month: Date.UTC(y, mo + 1, 1),
    quarter: Date.UTC(y, mo - (mo % 3) + 3, 1),
    year: Date.UTC(y + 1, 0, 1),
  }[bucket];
  return Math.floor(next / 1000) - 1;
}
```

---

## Approach A: left-click a chart point to open a detail Liveboard

### How the flow works

```
 User left-clicks a bar          ThoughtSpot (iframe)                 Your app
 ───────────────────────►  EmbedEvent.VizPointClick  ─────────►  1. read clicked attributes
                           { vizId, clickedPoint }               2. ask for the board's own filters
                                                   ◄──────────── HostEvent.GetFilters
                                                   ─────────────► 3. merge → runtime filters
                                                                 4. destroy summary embed
                                                                 5. render DETAIL Liveboard
                                                                    with runtimeFilters
                                                                 6. show a "← Back" button
```

1. **Listen for `EmbedEvent.VizPointClick`** on the summary Liveboard. While you are subscribed, a left-click sends the event to your app and ThoughtSpot shows **no menu of its own** *(verified)*. Subscribe only on the Liveboards where you want left-click to drill.
2. **Limit the drill to one visualization** (optional but recommended). The event fires for every viz on the board. `payload.data.vizId` is present on both charts and tables *(verified)*, so compare it to the viz you intend to drill from. Without this check, clicking a table elsewhere on the board would also drill away.
3. **Turn the clicked attributes into runtime filters:**
   - Strip the bucket wrapper: `Day(Order Date)` → `Order Date`.
   - Date values must be **numbers** (epoch seconds, UTC), not strings. ThoughtSpot silently ignores a string epoch.
   - A `Month(...)`, `Quarter(...)` or `Year(...)` click is the **start** of the bucket. Send a `BW_INC` range over the whole bucket, or the detail board shows only the first day of the month.
4. **Carry the filters the user set inside the Liveboard.** `HostEvent.GetFilters` **returns a promise** and takes no callback. Its items use `column`, not `columnName`, so map them. When both sources carry the same column, the clicked value wins.
5. **`destroy()` the summary embed, then render the detail Liveboard** with `runtimeFilters`. Always destroy before re-rendering into the same container.
6. **Give the user a way back** that re-renders the summary board.

### Code

```js
init({ thoughtSpotHost: 'https://your-instance.thoughtspot.cloud', authType: AuthType.TrustedAuthTokenCookieless /* … */ });

const SUMMARY_LB = '<summary-liveboard-guid>';
const DETAIL_LB  = '<detail-liveboard-guid>';
const DRILL_VIZ  = '<chart-viz-guid>';     // '' = drill from any viz on the board

let embed = renderSummary();

function renderSummary() {
  hideBackButton();
  const e = new LiveboardEmbed('#ts-embed', { liveboardId: SUMMARY_LB });
  e.on(EmbedEvent.VizPointClick, onPointClick);
  e.render();
  return e;
}

/** A clicked attribute → a runtime filter the detail Liveboard will honour. */
function toRuntimeFilter({ column, value }) {
  const { bucket, name } = splitBucket(column);
  if (!bucket) return { columnName: name, operator: RuntimeFilterOp.IN, values: [String(value)] };
  const start = toEpochSec(value);                                   // NUMBER, UTC
  if (bucket === 'day') return { columnName: name, operator: RuntimeFilterOp.IN, values: [start] };
  return { columnName: name, operator: RuntimeFilterOp.BW_INC, values: [start, bucketEndSec(bucket, start)] };
}

async function onPointClick(payload) {
  const vizId = payload?.data?.vizId;
  if (DRILL_VIZ && vizId && vizId !== DRILL_VIZ) return;

  const clicked = pointAttributes(clickedPoint(payload)).map(toRuntimeFilter);
  if (!clicked.length) return;                     // nothing to scope by

  // Filters the user set inside the Liveboard. Unsupported on some builds, so treat as optional.
  const source = embed;
  let boardFilters = [];
  try {
    const res  = await source.trigger(HostEvent.GetFilters);
    const list = Array.isArray(res) ? res : (res?.filters || res?.data || []);
    boardFilters = list
      .filter(f => f?.column && Array.isArray(f.values) && f.values.length)
      .map(f => ({ columnName: f.column, operator: RuntimeFilterOp[f.operator] ?? RuntimeFilterOp.IN, values: f.values }));
  } catch { /* fall back to the clicked point only */ }
  if (embed !== source) return;                    // the user navigated away while we waited

  // One entry per column. The clicked value wins over a board filter on the same column.
  const byCol = new Map();
  [...boardFilters, ...clicked].forEach(f => byCol.set(f.columnName, f));
  openDetail([...byCol.values()]);
}

function openDetail(runtimeFilters) {
  embed.destroy();
  embed = new LiveboardEmbed('#ts-embed', { liveboardId: DETAIL_LB, runtimeFilters });
  embed.render();
  showBackButton(() => { embed.destroy(); embed = renderSummary(); });
}

// showBackButton / hideBackButton: a plain button in your page chrome, outside the iframe.
```

### Things to watch for

- **Column names must exist on the detail Liveboard's Model.** Runtime filters match by column name. If the detail board sits on a different Model that names the column differently, map the name before sending it.
- **To open the detail board in a new tab or route instead**, encode the runtime filters into your own app's URL and render the detail Liveboard there. The click-handling steps stay the same.
- **Runtime filters are not a security boundary.** They are visible to, and editable by, the user. Row-level security must be enforced in ThoughtSpot, for example through RLS rules or the user's token.

---

## Approach B: right-click → "View orders" → a clickable list of records

### How the flow works

```
 User right-clicks a cell   ThoughtSpot shows its own menu:
 ─────────────────────────► Filter · Drill down · Show underlying data · … · View orders
                            (no event reaches your app yet)

 User picks "View orders"   EmbedEvent.CustomAction                 Your app
 ─────────────────────────► { id: 'view-orders',  ──────────────►  1. read the clicked row
                              contextMenuPoints }                  2. POST scope to YOUR backend
                                                                   3. backend → searchdata on the
                                                                      order-level Model, as the user
                                                                   4. render the list; each row is a
                                                                      link, e.g. /orders/{Order Id}
                                                                   5. "Load more" pages with
                                                                      record_offset
```

1. **Declare the action in the embed config.** Use `position: CONTEXTMENU` and `target: VIZ`. The `VIZ` target is what makes the clicked row come through in the payload.
2. **Control where the item appears.** Use **one** of these keys, not both:
   - `metadataIds.vizIds: ['<vizGuid>', …]` shows the item **only** on those visualizations *(verified)*. Use this when you know which tiles should offer the drill.
   - `dataModelIds.modelColumnNames: ['<modelGuid>::<Column Name>']` shows the item on every visualization built on that column. Use the **display name the viz shows** (e.g. `Total Sales Amount`), not the underlying Model column name *(verified)*.

   **The scoping keys are OR'd, not AND'd** *(verified on 26.8.0.cl)*. With both set, the item still appeared on every viz built on the column, so `vizIds` did nothing. Column scoping also applies to the whole **visualization, not a single cell** *(verified)*: the item appears when the user right-clicks a neighbouring measure on the same table.

   When a user right-clicks a visualization outside `vizIds`, ThoughtSpot leaves the item out **and** fires `EmbedEvent.Error` with code `VIZ_ACTION_FILTER_VALIDATION` *(verified)*. That event is informational. If your error handler treats every `EmbedEvent.Error` as fatal, filter this code out, or a harmless right-click will tear down your UI.
3. **Nothing reaches your app on the right-click itself.** ThoughtSpot opens its own menu with your item added. `EmbedEvent.CustomAction` fires only when the user picks **View orders** *(verified)*.
4. **Fetch the order rows through your backend** with `POST /api/rest/2.0/searchdata`, using **that user's own token**. This way ThoughtSpot applies the user's row-level security to the detail rows. Under cookieless trusted auth, a direct browser-to-ThoughtSpot REST call is also blocked by CORS, so the backend hop is needed anyway.
5. **Render the list yourself.** Use `textContent` for values, build each link from a template, and allow only `http(s)` URLs.

### Frontend code

```js
const SUMMARY_MODEL = '<summary-model-guid>';
const ACTION_ID     = 'view-orders';
const MEASURE       = 'Total Sales Amount';            // display name, as the viz shows it
const LINK_TEMPLATE = 'https://example.com/orders/{Order Id}';
const PAGE_SIZE     = 100;

const embed = new LiveboardEmbed('#ts-embed', {
  liveboardId: '<summary-liveboard-guid>',
  customActions: [{
    id: ACTION_ID,
    name: 'View orders',
    position: CustomActionsPosition.CONTEXTMENU,        // right-click menu
    target: CustomActionTarget.VIZ,                     // per viz, so the clicked row is sent
    metadataIds: { vizIds: ['<viz-guid>'] },            // ONLY this visualization. Don't also send
                                                        // dataModelIds: the keys are OR'd (see step 2)
  }],
});

embed.on(EmbedEvent.Error, (e) => {
  // A right-click on a viz outside vizIds reports this. The item was correctly withheld; not a failure.
  if (JSON.stringify(e).includes('VIZ_ACTION_FILTER_VALIDATION')) return;
  showError(e);
});

embed.on(EmbedEvent.CustomAction, (payload) => {
  if ((payload?.id ?? payload?.data?.id) !== ACTION_ID) return;
  const scope = pointAttributes(clickedPoint(payload));  // e.g. [{ column: 'Day(Order Date)', value: 1769644800 }, …]
  openOrderList(scope);
});
embed.render();

async function openOrderList(scope) {
  let offset = 0;
  const list = document.querySelector('#order-list');
  list.replaceChildren();

  async function loadPage() {
    const r = await fetch('/api/order-detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, offset, size: PAGE_SIZE }),
    });
    const { columns, rows } = await r.json();
    rows.forEach(r => list.appendChild(orderRow(Object.fromEntries(columns.map((c, i) => [c, r[i]])))));
    offset += rows.length;
    // A SHORT page is the only reliable end-of-data signal (see "Things to watch for").
    document.querySelector('#load-more').hidden = rows.length < PAGE_SIZE;
  }
  document.querySelector('#load-more').onclick = loadPage;
  await loadPage();
}

function orderRow(row) {
  const li = document.createElement('li');
  const a  = document.createElement('a');
  a.textContent = `${row['Order Id']} · ${row['Customer Name']} · ${row['Sales Amount']}`;  // textContent, never innerHTML
  const href = resolveLink(LINK_TEMPLATE, row);
  if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener'; }
  li.appendChild(a);
  return li;
}

/** Fill {Column} placeholders; refuse anything that is not http(s). */
function resolveLink(template, row) {
  const url = template.replace(/\{([^{}]+)\}/g, (_, c) => encodeURIComponent(String(row[c.trim()] ?? '')));
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; }
  catch { return ''; }
}
```

### Backend code (Node / Express)

The backend builds the search query itself from the clicked scope. That way the browser can't choose which Model or columns are queried.

```js
const DETAIL_MODEL   = '<order-level-model-guid>';      // one row per order
const DETAIL_COLUMNS = ['Order Id', 'Order Date', 'Customer Name', 'Sales Amount'];
const SCOPE_COLUMNS  = new Set(['Order Date', 'Employee Name', 'Territory', 'Region']); // allowlist

/** MM/DD/YYYY in UTC: the date literal ThoughtSpot's search parser accepts here. */
function mdy(sec) {
  const d = new Date(sec * 1000), p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
}

function buildQuery(scope) {
  const clauses = [];
  for (const { column, value } of scope) {
    const { bucket, name } = splitBucket(column);        // same helper as the frontend
    if (!SCOPE_COLUMNS.has(name)) continue;
    const clean = String(value).replace(/'/g, '');       // search literals are single-quoted
    if (!bucket) { clauses.push(`[${name}] = '${clean}'`); continue; }
    const start = toEpochSec(value);
    if (bucket === 'day') clauses.push(`[${name}] = '${mdy(start)}'`);
    else clauses.push(`[${name}] >= '${mdy(start)}' [${name}] <= '${mdy(bucketEndSec(bucket, start))}'`);
  }
  return [DETAIL_COLUMNS.map(c => `[${c}]`).join(' '), ...clauses].join(' ');
}

app.post('/api/order-detail', async (req, res) => {
  const token = await getTokenForUser(req.user);          // the SAME per-user token your embed uses
  const size  = Math.min(Number(req.body.size) || 100, 1000);
  const r = await fetch(`${TS_HOST}/api/rest/2.0/searchdata`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query_string: buildQuery(req.body.scope || []),
      logical_table_identifier: DETAIL_MODEL,
      data_format: 'COMPACT',
      record_offset: Math.max(Number(req.body.offset) || 0, 0),
      record_size: size,
    }),
  });
  if (!r.ok) return res.status(r.status).json({ error: await r.text() });
  const content = (await r.json()).contents?.[0] ?? {};
  res.json({ columns: content.column_names ?? [], rows: content.data_rows ?? [] });
});
```

### Things to watch for

- **Carry every attribute on the row, not just one.** A table cell is the intersection of all its attribute columns (Employee × Territory × Day). Scoping to Employee alone returned roughly 10× the rows in testing, and the totals never matched.
- **Date literal format.** `[Order Date] = '01/29/2026'` works *(verified)*. `'2026-01-29'` is rejected, and `[Order Date].daily = '…'` **returns the wrong rows without an error**. The format follows the cluster's locale, so a non-US cluster may need `DD/MM/YYYY`. The single-day form is verified. **Test the week/month range form (`>=` … `<=`) on your cluster.** If it returns zero rows where you expect data, fall back to the day clause.
- **`COMPACT` rows are arrays** aligned to `column_names`, not objects. Map them before you look columns up by name.
- **Do not trust `available_data_row_count` as a total.** The API reference describes it as the total. On 26.8.0.cl it came back equal to the page size on every full page *(verified)*. Keep loading until a page comes back **shorter** than `record_size`, and page with `record_offset`, which also gets you past the 1,000-row cap per call.
- **Which measure the list is "about."** The item also shows on neighbouring cells (see step 2), so the right-clicked measure may not be the one you care about. To show a header such as "Total Sales Amount: 185,915", look up your configured measure across `selectedMeasures` and `deselectedMeasures` on the clicked point. **When it isn't there — the user clicked an unsupported cell — say so explicitly** (e.g. "configured measure not on this selection, showing X instead") rather than silently relabelling the header after whichever measure happened to be on the row. There is no button-hiding option for this case (see below); messaging is the only mitigation.
- **Sanity-check the numbers.** A count measure ("57 orders") should equal the number of detail rows. A sum measure should equal the sum of the matching detail column. That check is a quick way to confirm the scope is right.
- **The row link** is built from the row's values, so URL-encode each value and allow only `http(s)`, as `resolveLink` does above.

### Four follow-ups worth knowing

**Show/hide the action on only one or two visualizations.** Use `metadataIds.vizIds: ['<vizGuid1>', '<vizGuid2>']` on a `VIZ`-target action, and **leave `dataModelIds` out**. The keys are OR'd, so adding a column scope brings the action back on every viz that uses that column *(verified live)*. Get the GUIDs from `POST /api/rest/2.0/metadata/search` with `include_visualization_headers: true` on the Liveboard. It returns the same IDs as `metadata/liveboard/data` in about 0.3s instead of 3.9s, because it doesn't run the charts' queries.

**Field/column-level action visibility does not exist.** Confirmed live: `dataModelIds.modelColumnNames` scopes to the **visualization**, not a cell or column within it — right-clicking a neighbouring measure on the same table still shows the action. There is no SDK option (built-in or custom-action) that hides an action for one column while a sibling column on the same viz keeps it. If a specific field genuinely must never trigger it, the only mitigations are (a) put that field on its own visualization so `vizIds` can exclude it, or (b) let the action fire and handle the mismatch client-side per the "unsupported selection" messaging above.

**Hiding "Show underlying data" on only the pinned visualization.** `hiddenActions: [Action.ShowUnderlyingData]` is **embed-wide**: it hides the item on every visualization. The SDK has no per-viz version (checked through 1.49.0). ThoughtSpot does render your code-based action's menu item with the action `id` as its DOM id, in the same popover as the built-in items. So a CSS rule can hide "Show underlying data" in exactly the menus that also contain your action. Those are the menus of the visualizations you scoped the action to, and every other viz keeps the item *(verified on 26.8.0.cl: pinned table, other charts, and through the whole click → modal → close flow)*:

```js
init({
  // …
  customizations: {
    style: {
      customCSS: {
        rules_UNSTABLE: {
          // 'view-orders' = the id of your custom action
          '[data-testid="popover-container"]:has([id="view-orders"]) #context-menu-item-show-underlying-data': {
            display: 'none !important',
          },
        },
      },
    },
  },
});
```

Caveats:
- It relies on ThoughtSpot's internal DOM (`rules_UNSTABLE`, the `popover-container` test id, the `context-menu-item-show-underlying-data` id). Re-test after each cluster upgrade.
- Two approaches that look like they should work **don't** *(verified)*:
  - Keying on the tile's focus (`[id="<viz-guid>"]:focus-within`). Pressing on the menu moves focus into the popover, so the item reappears mid-click.
  - Keying on the selected-cell class (`table-module__cellSelected`). That class stays on after the menu closes, so the item stays hidden on other tiles afterwards.
- It's cosmetic, not a security control. A user who can see underlying data can still reach it by other routes (e.g. Explore), and the `CAN_DOWNLOAD_DETAILED_DATA` privilege is what actually governs it.

**KPI (single-value) visualizations.** Drill-through works the same way on a KPI tile: a click reports the number via `selectedMeasures` with no `selectedAttributes`/`deselectedAttributes` (a KPI has no row to click into, just a total). `dtClickedMeasure`-style lookup logic doesn't need to special-case this — it already searches `selectedMeasures`/`deselectedMeasures` generically. The resulting detail query carries no dimensional scope, which is correct: a KPI is already an aggregate over whatever Liveboard filters are active, so the record list should be that same unscoped (by dimension), filtered set. Both `CONTEXTMENU`/`VIZ` custom actions and plain `VizPointClick` are documented as `VIZ`-target features with no KPI carve-out — but this has not yet been verified against a live KPI-type tile the way the table/chart cases above are; confirm on your cluster before relying on it in production.

---

## Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| Left-click does nothing in the host app | You haven't subscribed to `EmbedEvent.VizPointClick`, or the `vizId` check doesn't match the clicked tile |
| Left-click no longer shows ThoughtSpot's menu | Expected while `VizPointClick` is subscribed. Right-click still opens it |
| Detail Liveboard shows all data | A table click carried its scope in `deselectedAttributes` and only `selectedAttributes` was read |
| Detail Liveboard ignores the date | The epoch was sent as a string, or the column name still had its `Day(...)` wrapper |
| Month click shows only the 1st of the month | The bucket start was sent as a single value, not a `BW_INC` range |
| "View orders" appears on too many tiles | `modelColumnNames` scopes to every viz on that column. Switch to `metadataIds.vizIds` **alone**; with both keys set they are OR'd and `vizIds` has no effect |
| Right-clicking another tile shows an error / tears down the page | `VIZ_ACTION_FILTER_VALIDATION` is informational (the action was correctly withheld). Filter it out of your `EmbedEvent.Error` handler |
| "View orders" does not appear at all | `modelColumnNames` used the Model column name, not the name the viz displays, or `target` isn't `VIZ` |
| "Show underlying data" still shows next to my custom action | Board-wide: add `Action.ShowUnderlyingData` to `hiddenActions`. Only where your action appears: use the popover `:has()` CSS rule under "Four follow-ups" |
| Clicked the wrong cell and the modal shows the wrong measure | Expected — there is no column-level scoping. Detect the mismatch (`selectedMeasures`/`deselectedMeasures` missing your configured column) and show an explicit message instead of the substituted value |
| searchdata returns 400 "Bad tokens" | A bucket wrapper (`Day(Order Date)`) was left in the query |
| searchdata returns the wrong rows | A `.daily` keyword form or a non-`MM/DD/YYYY` date literal was used |
| Paging stops after page one | `available_data_row_count` was used as the total instead of waiting for a short page |

---

## Official documentation

- `EmbedEvent.VizPointClick`: https://developers.thoughtspot.com/docs/Enumeration_EmbedEvent#_vizpointclick
- `EmbedEvent.CustomAction`: https://developers.thoughtspot.com/docs/Enumeration_EmbedEvent#_customaction
- Code-based custom actions (`position`, `target`, `metadataIds`, `dataModelIds`): https://developers.thoughtspot.com/docs/code-based-custom-action
- `HostEvent.GetFilters`: https://developers.thoughtspot.com/docs/Enumeration_HostEvent#_getfilters
- Filters overview (GetFilters response fields): https://developers.thoughtspot.com/docs/filters-overview#_getfilters_and_getparameters_events
- Runtime filters: https://developers.thoughtspot.com/docs/runtime-filters
- `LiveboardViewConfig.runtimeFilters`: https://developers.thoughtspot.com/docs/Interface_LiveboardViewConfig#_runtimefilters
- Search data API (`query_string` syntax): https://developers.thoughtspot.com/docs/fetch-data-and-report-apis#_search_data_api
- Pagination and record size limits: https://developers.thoughtspot.com/docs/fetch-data-and-report-apis#_pagination_settings_for_data_and_report_api
- Role-based access control (`CAN_DOWNLOAD_DETAILED_DATA`): https://developers.thoughtspot.com/docs/rbac
