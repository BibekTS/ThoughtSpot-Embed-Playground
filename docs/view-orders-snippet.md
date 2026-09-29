# "View orders" on one visualization: embed snippet

This snippet adds a **View orders** item to the right-click menu of the visualizations you choose, and to no others. It also:

- hides **Show underlying data** in those same menus, while every other visualization keeps it
- shows a clear message when a user right-clicks a cell the drill-down doesn't support, such as an Employee Name
- ignores the harmless error ThoughtSpot sends when someone right-clicks a visualization that doesn't have the action

Tested on ThoughtSpot 26.8.0.cl with Visual Embed SDK 1.49.0. Code-based custom actions need SDK 1.43.0+ and ThoughtSpot 10.14.0.cl+.

## Embed code

```js
import {
  init, LiveboardEmbed, AuthType, EmbedEvent,
  CustomActionsPosition, CustomActionTarget,
} from '@thoughtspot/visual-embed-sdk';

const ACTION_ID      = 'view-orders';
const PINNED_VIZ_IDS = ['<viz-guid>'];          // the visualization(s) that should offer the action
const MEASURE        = 'Total Sales Amount';    // the measure the drill-down is about (display name)

init({
  thoughtSpotHost: 'https://<your-instance>.thoughtspot.cloud',
  authType: AuthType.TrustedAuthTokenCookieless,
  getAuthToken: () => fetch('/api/ts-token', { method: 'POST' }).then(r => r.json()).then(d => d.token),
  customizations: {
    style: {
      customCSS: {
        rules_UNSTABLE: {
          // Hide "Show underlying data" only in menus that also contain our action.
          // Every other visualization keeps it.
          [`[data-testid="popover-container"]:has([id="${ACTION_ID}"]) #context-menu-item-show-underlying-data`]: {
            display: 'none !important',
          },
        },
      },
    },
  },
});

const embed = new LiveboardEmbed('#ts-embed', {
  liveboardId: '<liveboard-guid>',
  customActions: [{
    id: ACTION_ID,
    name: 'View orders',
    position: CustomActionsPosition.CONTEXTMENU,   // right-click menu
    target: CustomActionTarget.VIZ,                // sends the clicked row in the payload
    metadataIds: { vizIds: PINNED_VIZ_IDS },       // ONLY these visualizations.
    // Do NOT also set dataModelIds: the two scopes are OR'd, and the column
    // scope would put the action back on every viz that uses that column.
  }],
});

// Right-clicking a viz outside vizIds fires this. It means the action was
// correctly withheld, not that something broke.
embed.on(EmbedEvent.Error, (e) => {
  if (JSON.stringify(e).includes('VIZ_ACTION_FILTER_VALIDATION')) return;
  console.error('ThoughtSpot embed error', e);
});

embed.on(EmbedEvent.CustomAction, (payload) => {
  const data = payload?.data ?? payload;
  if (data?.id !== ACTION_ID) return;

  const point = clickedPoint(data);
  const name  = (x) => x?.column?.name ?? x?.columnName;
  const value = (x) => x?.value ?? x?.dataValue;

  // The action can't be scoped to a single column; it shows on every cell of
  // the pinned viz. `selected*` is the cell that was right-clicked and
  // `deselected*` is the rest of the row, so check selectedMeasures ONLY.
  // (A right-click on "Jae Pak" puts every measure in deselectedMeasures.)
  const measure = (point?.selectedMeasures ?? []).find(m => name(m) === MEASURE);
  if (!measure || value(measure) == null || value(measure) === '{Null}') {
    showMessage(`This value has no order drill-down. Right-click a "${MEASURE}" value to view orders.`);
    return;
  }

  // Table clicks put the row's attributes in deselectedAttributes; chart
  // clicks use selectedAttributes. Read both, or a table click has no scope.
  const attrs = point.selectedAttributes?.length ? point.selectedAttributes : (point.deselectedAttributes ?? []);
  const scope = attrs
    .filter(a => value(a) != null && value(a) !== '{Null}')
    .map(a => ({ column: name(a), value: value(a) }));

  openOrderList(scope, { label: MEASURE, value: value(measure) });  // your code: call Cube / searchdata
});

embed.render();

// The clicked point arrives in different shapes depending on the surface.
function clickedPoint(data) {
  const cmp = data?.contextMenuPoints;
  return data?.clickedPoint
      ?? (Array.isArray(cmp) ? cmp[0] : cmp?.clickedPoint)
      ?? data?.selectedPoints?.[0];
}
```

`showMessage` and `openOrderList` are placeholders for your own UI and data calls.

## Showing a message on cells without a drill-down

ThoughtSpot can't hide a custom action on individual cells. **View orders** appears on every cell of the pinned visualization, including Employee Name and Territory. The handler can tell which cell was clicked, though, so it opens the order list for a **Total Sales Amount** value and shows a message for any other cell.

### How it works

The `CustomAction` payload splits the clicked row into two groups:

- `selectedAttributes` / `selectedMeasures`: **the cell the user right-clicked**
- `deselectedAttributes` / `deselectedMeasures`: **the rest of that row**

These are the payloads we captured on ThoughtSpot 26.8.0.cl by right-clicking two cells in the same row of the *Employee Quota Achievement* table:

| Right-clicked cell | `selectedAttributes` | `selectedMeasures` | `deselectedMeasures` |
|---|---|---|---|
| **Total Sales Amount** | *(empty)* | `Total Sales Amount` | Quota, Quota % |
| **Employee Name** | `Employee Name` | *(empty)* | Total Sales Amount, Quota, Quota % |

So the check is: **is our measure in `selectedMeasures`, and does it have a value?** If so, open the orders. Otherwise, show the message.

```js
const measure = (point?.selectedMeasures ?? []).find(m => name(m) === MEASURE);
if (!measure || value(measure) == null || value(measure) === '{Null}') {
  showMessage(`This value has no order drill-down. Right-click a "${MEASURE}" value to view orders.`);
  return;
}
```

With this check:

- Right-clicking **Employee Name**, **Territory**, **Total Sales Amount Quota** or **Quota %** shows the message.
- Right-clicking an empty (`{Null}`) Total Sales Amount cell also shows the message, because there are no orders to list.
- Right-clicking a **Total Sales Amount** value opens the order list for that row.

**Don't check `deselectedMeasures` as well.** When the user right-clicks "Jae Pak", Total Sales Amount is in `deselectedMeasures`, so a check that includes it would open the order list for a name click. An earlier version of this snippet had that bug.

Charts work the same way. A bar or point click puts the measure in `selectedMeasures`, so the check passes.

### A simple `showMessage`

Any toast or banner in your app will do. If you don't have one, this is a minimal version:

```js
function showMessage(text) {
  const el = document.createElement('div');
  el.textContent = text;   // textContent, not innerHTML: the text can include column names
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
    + 'background:#1d232f;color:#fff;padding:10px 16px;border-radius:6px;z-index:9999;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
```

## Getting the visualization GUIDs

This call is fast and doesn't run any chart queries:

```http
POST /api/rest/2.0/metadata/search
Content-Type: application/json

{
  "metadata": [{ "type": "LIVEBOARD", "identifier": "<liveboard-guid>" }],
  "include_visualization_headers": true
}
```

Each entry in `visualization_headers` has an `id` and a `name`. Put the `id` values in `PINNED_VIZ_IDS`.

## Notes

- **Use `metadataIds.vizIds` on its own.** ThoughtSpot combines `vizIds` and `dataModelIds` with OR. If you set both, the column scope brings the action back on every visualization that uses that column.
- **Per-column hiding isn't supported.** A custom action applies to a whole visualization, including cells in other columns. The handler shows a message instead (see [Showing a message on cells without a drill-down](#showing-a-message-on-cells-without-a-drill-down)).
- **The CSS rule may break on upgrade.** `rules_UNSTABLE` relies on ThoughtSpot's internal page structure, so re-test it after each upgrade.
- **Hiding the menu item doesn't block the data.** Users can still reach underlying data other ways. The **Can download detailed data** privilege is what actually controls access.
- **KPI tiles are untested.** The same handler should work on a KPI tile, since it reads `selectedMeasures` for any chart type, but we haven't checked it on a live KPI tile yet.
