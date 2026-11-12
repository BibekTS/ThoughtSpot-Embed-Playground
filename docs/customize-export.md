# A "Customize Export" Button on an Embedded Liveboard — REST Report API

This guide explains how to add a button to an embedded ThoughtSpot liveboard that, when clicked,
opens **your own selection screen** where the user picks the export format and options, and then
downloads the file — built through the **REST Report API** instead of ThoughtSpot's native
Download modal.

The concrete example throughout is a **"Customize Export"** button that pops a small dialog
(Format · Page layout · Orientation · a few include/exclude toggles · Footer text), then exports
the liveboard with exactly those options and the **current active filters baked in**.

The payoff over the native modal: **you control every option — and which ones the user even
sees** — and you can hide the native Download entirely so this is the only export path.

---

## 1. The idea in one picture

ThoughtSpot runs inside an iframe. A "button that opens my own dialog and exports my way" is
two halves talking across the iframe boundary, plus a REST call that renders the file:

```
  ┌─────────────────────────────┐    EmbedEvent.CustomAction    ┌────────────────────────────────┐
  │   ThoughtSpot (in iframe)   │  ───────  postMessage  ─────▶ │      Your host application     │
  │                             │                               │                                │
  │  User clicks "Customize      │      { id, data, … }          │  1. match the action id        │
  │  Export" (type = Callback)   │                               │  2. open your options dialog   │
  │                             │                               │  3. POST /report/liveboard     │
  │                             │  ◀── file (octet-stream) ──── │  4. save the returned Blob     │
  └─────────────────────────────┘                               └────────────────────────────────┘
                                          (REST, same session)
```

- **Inside ThoughtSpot:** a **Callback** custom action. Clicking it does nothing on its own —
  it emits an `EmbedEvent.CustomAction` event to the host carrying an action **id**.
- **In your host app:** you listen for that event, open your dialog, collect the user's choices,
  and call `POST /api/rest/2.0/report/liveboard`, which returns the rendered file.

The model is the same as any Callback action — **ThoughtSpot fires an event → the host does the
work** — but here the "work" is *render your own UI, then export via REST*.

### Why REST instead of the native Download modal?

The built-in Download modal exposes a fixed set of options, and the SDK can only hide the whole
Download action, not its individual sub-options. The REST Report API gives you the full
`pdf_options` surface and lets you decide which knobs to show:

| Native Download modal                         | REST Report API (`/report/liveboard`)                      |
| --------------------------------------------- | ---------------------------------------------------------- |
| Fixed set of options                          | Every option is yours: `truncate_table`, `page_size`, …     |
| Can only hide the whole action                | Show/hide/relabel any option in **your** dialog             |
| Filters = whatever is on screen               | Bake in **any** filters via `override_filters`              |
| One code path                                 | Same call powers a one-click button *and* a custom dialog   |

---

## 2. Two flavors of this button

Both fire the same `EmbedEvent.CustomAction`; the difference is what the handler does:

| Button                    | Handler does…                                            | User picks options? |
| ------------------------- | -------------------------------------------------------- | ------------------- |
| **Custom Export option**  | Exports immediately with the host's pre-set options      | No                  |
| **Customize Export**      | Opens a dialog, then exports with the user's choices      | **Yes**             |

They share one export routine — the only difference is whether an options object comes from your
config or from a dialog. This guide builds **Customize Export**; the one-click variant is the
same code minus the dialog (call the export directly).

---

## 3. Custom actions: Callback vs URL

Custom actions come in two flavors:

| Type         | What it does                                   | Runs host code? |
| ------------ | ---------------------------------------------- | --------------- |
| **URL**      | Opens a URL (optionally with row values in it) | No              |
| **Callback** | Emits `EmbedEvent.CustomAction` to the host    | **Yes**         |

Opening a dialog and calling REST is host logic, so use **Callback**.

### Two ways to create the action

1. **In the ThoughtSpot UI** — *Develop → Customizations → Custom actions → Create action.*
   Type = **Callback**, give it a label, copy the generated **action id**.

2. **Injected by the SDK** — pass a `customActions` array in the embed config at render time. The
   **label, placement, and id are controlled entirely in your code**, and it can't collide with a
   built-in action. No TS-side setup.

This guide uses the **SDK-injected** approach. If you created the action in the UI, everything
from Section 5 onward is identical — you just skip the injection and match on the id ThoughtSpot
generated.

---

## 4. Prerequisites

- The **ThoughtSpot Visual Embed SDK** loaded, and a `LiveboardEmbed` rendered. Keep a reference
  to the embed instance.
- An **authenticated ThoughtSpot session** (session cookie or trusted auth). Both the button and
  the REST call run against that session.
- The REST call must reach ThoughtSpot with credentials. **Same-origin** (or a first-party
  reverse proxy) is the simplest; from a different origin you'll need a proxy that forwards the
  bearer token (see gotcha #6).
- The **`report/liveboard` API is Liveboard-scoped** — the button belongs on liveboard-type
  embeds (`LiveboardEmbed`, a viz within one, AI Highlights). It exports the *whole liveboard*.

---

## 5. How it works, end to end

```
User clicks "Customize Export"
   │
   ▼
ThoughtSpot emits EmbedEvent.CustomAction ──postMessage──▶ host
   │
embed.on(EmbedEvent.CustomAction, payload => handle(payload))
   │
   ▼
handler:
   1. Match the action id            (payload.id ?? payload.data.id)
   2. Open your options dialog        (seed it with your default options)
   3. On submit → collect choices     ({ format, pageSize, orientation, … })
   4. Bake in the active filters      (→ override_filters)
   5. POST /api/rest/2.0/report/liveboard   → returns the file as octet-stream
   6. Save the response as a Blob     (tag it with the right MIME/extension)
```

Note what is **not** here: no `answerService`, no `fetchData`, no pagination, no row
normalization. The REST endpoint renders the entire liveboard server-side and hands you a
finished file. (That machinery is only needed when you build the output yourself from the row
data — see [callback-action.md](callback-action.md).)

---

## 6. Step-by-step implementation

### Step 1 — Embed the liveboard and keep the instance

```js
import {
  init, AuthType, EmbedEvent,
  LiveboardEmbed, CustomActionsPosition, CustomActionTarget,
} from "@thoughtspot/visual-embed-sdk";

init({ thoughtSpotHost: "https://your-instance.thoughtspot.cloud", authType: AuthType.None /* or your auth */ });

const HOST = "https://your-instance.thoughtspot.cloud";
const LIVEBOARD_ID = "<LIVEBOARD_GUID>";
```

### Step 2 — Register the button (SDK-injected)

Put the action in the Liveboard "…" (More) menu:

```js
const EXPORT_ACTION_ID = "export-customize"; // your id; the contract with the handler

const embed = new LiveboardEmbed(document.getElementById("ts-embed"), {
  liveboardId: LIVEBOARD_ID,
  frameParams: { width: "100%", height: "100%" },
  customActions: [
    {
      id: EXPORT_ACTION_ID,
      name: "Customize Export",                 // the label users see
      position: CustomActionsPosition.MENU,     // PRIMARY = header button · MENU = "…" overflow · CONTEXTMENU = right-click
      target: CustomActionTarget.LIVEBOARD,     // whole-liveboard export
    },
  ],
  // Optional: hide the native Download so your button is the only export path (full control).
  // hiddenActions: [Action.DownloadAsPdf, Action.Download],
});
```

- **`position`** — `PRIMARY` (a visible button), `MENU` (the "…" menu), or `CONTEXTMENU`.
- **`target`** — `LIVEBOARD` exports the whole board; that's what `report/liveboard` needs.
- **`id`** is the contract; the label can be anything.

### Step 3 — Listen for the event

```js
embed.on(EmbedEvent.CustomAction, (payload) => {
  const id = payload?.id ?? payload?.data?.id;   // New experience → data.id · Classic → id
  if (id !== EXPORT_ACTION_ID) return;
  openExportDialog();
});

embed.render();
```

### Step 4 — Build the options dialog (the selection screen)

This is the "customize" part: render your own UI, seeded from sensible defaults, and let the user
adjust before exporting. A dependency-free `<dialog>` works well and needs no CDN inside the
sandbox. Show the PDF-only knobs only when the format is PDF.

```js
// The host's defaults — also what seeds the dialog each time it opens.
const DEFAULT_OPTS = {
  format: "PDF",            // PDF | XLSX | CSV | PNG
  pageSize: "A4",           // A4 (page breaks) | CONTINUOUS (beta, needs enablement)
  orientation: "LANDSCAPE", // LANDSCAPE | PORTRAIT
  truncateTable: false,     // false = show ALL columns/rows (no cutoff)
  includeCoverPage: true,
  includeFilterPage: true,
  includePageNumber: true,
  includeCustomLogo: true,
  footerText: "",
};

function openExportDialog() {
  const opts = { ...DEFAULT_OPTS };            // ephemeral working copy — never mutate your saved config
  const dlg = document.createElement("dialog");
  dlg.className = "ts-export-dialog";

  const render = () => {
    const isPdf = opts.format === "PDF";
    dlg.innerHTML = `
      <form method="dialog">
        <h3>Customize Export</h3>
        <label>Format
          <select name="format">
            ${["PDF", "XLSX", "CSV", "PNG"].map(f =>
              `<option value="${f}" ${f === opts.format ? "selected" : ""}>${f}</option>`).join("")}
          </select>
        </label>
        ${isPdf ? `
          <label>Page layout
            <select name="pageSize">
              <option value="A4" ${opts.pageSize === "A4" ? "selected" : ""}>A4 pages (page breaks)</option>
              <option value="CONTINUOUS" ${opts.pageSize === "CONTINUOUS" ? "selected" : ""}>Continuous (beta)</option>
            </select>
          </label>
          <label>Orientation
            <select name="orientation">
              <option value="LANDSCAPE" ${opts.orientation === "LANDSCAPE" ? "selected" : ""}>Landscape</option>
              <option value="PORTRAIT" ${opts.orientation === "PORTRAIT" ? "selected" : ""}>Portrait</option>
            </select>
          </label>
          <label><input type="checkbox" name="truncateTable" ${opts.truncateTable ? "checked" : ""}> Truncate tables</label>
          <label><input type="checkbox" name="includeCoverPage" ${opts.includeCoverPage ? "checked" : ""}> Include cover page</label>
          <label><input type="checkbox" name="includeFilterPage" ${opts.includeFilterPage ? "checked" : ""}> Include filter page</label>
          <label><input type="checkbox" name="includePageNumber" ${opts.includePageNumber ? "checked" : ""}> Include page numbers</label>
          <label><input type="checkbox" name="includeCustomLogo" ${opts.includeCustomLogo ? "checked" : ""}> Include logo</label>
          <label>Footer text <input type="text" name="footerText" value="${opts.footerText}" placeholder="e.g. Confidential"></label>
        ` : ""}
        <menu>
          <button value="cancel" type="submit">Cancel</button>
          <button value="export" type="submit">⬇ Export</button>
        </menu>
      </form>`;

    // Re-render when the format changes so the PDF-only rows appear/disappear.
    dlg.querySelector('[name="format"]').addEventListener("change", (e) => { opts.format = e.target.value; render(); });
  };

  render();
  document.body.appendChild(dlg);
  dlg.showModal();

  dlg.addEventListener("close", async () => {
    const chosen = collectOpts(dlg, opts);     // read the fields into an options object
    dlg.remove();
    if (dlg.returnValue === "export") await exportLiveboard(chosen);
  });
}

// Read the current field values (falling back to the working copy for whatever isn't in the DOM).
function collectOpts(dlg, opts) {
  const f = dlg.querySelector("form");
  const val = (n) => f.elements[n]?.value;
  const chk = (n) => !!f.elements[n]?.checked;
  return {
    ...opts,
    format: val("format") ?? opts.format,
    pageSize: val("pageSize") ?? opts.pageSize,
    orientation: val("orientation") ?? opts.orientation,
    truncateTable: chk("truncateTable"),
    includeCoverPage: chk("includeCoverPage"),
    includeFilterPage: chk("includeFilterPage"),
    includePageNumber: chk("includePageNumber"),
    includeCustomLogo: chk("includeCustomLogo"),
    footerText: val("footerText") ?? "",
  };
}
```

> The dialog is entirely your UI, so style and localize it however you like, and only surface the
> options you want your users to touch. Hide the rest — they still go to the API as your defaults.

### Step 5 — Bake in the current active filters

Whatever filters are applied (runtime filters, or your own filter-bar selections) should carry
into the export. The REST body takes them as `override_filters`:

```js
// Return the filters you're already tracking in the host as override_filters entries.
// Each is a column + the values to keep. Shape below matches the REST API.
function activeOverrideFilters() {
  // Example: pull from wherever your app holds the current selections.
  // return [{ column_name: "Region", values: ["East", "West"] }];
  return [];
}
```

### Step 6 — Call the REST Report API and download

One function turns an options object into a request and saves the file. This is the shared
routine — a one-click "Custom Export option" button calls the exact same thing with your default
options instead of the dialog's.

```js
const REPORT_FORMATS = {
  PDF:  { mime: "application/pdf", ext: "pdf" },
  XLSX: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  CSV:  { mime: "text/csv", ext: "csv" },
  PNG:  { mime: "image/png", ext: "png" },
};

// Friendly options → the API's pdf_options shape. Only emit keys the caller set.
function buildPdfOptions(o) {
  const p = {};
  if (o.pageSize) p.page_size = o.pageSize;                 // 'A4' | 'CONTINUOUS'
  if (o.orientation) p.page_orientation = o.orientation;    // 'PORTRAIT' | 'LANDSCAPE'
  if (typeof o.truncateTable === "boolean") p.truncate_table = o.truncateTable;
  if (typeof o.includeCoverPage === "boolean") p.include_cover_page = o.includeCoverPage;
  if (typeof o.includeFilterPage === "boolean") p.include_filter_page = o.includeFilterPage;
  if (typeof o.includePageNumber === "boolean") p.include_page_number = o.includePageNumber;
  if (typeof o.includeCustomLogo === "boolean") p.include_custom_logo = o.includeCustomLogo;
  if (o.footerText) p.page_footer_text = o.footerText;
  return p;
}

async function exportLiveboard(opts) {
  const fmt = REPORT_FORMATS[opts.format] ? opts.format : "PDF";
  const meta = REPORT_FORMATS[fmt];

  const body = { metadata_identifier: LIVEBOARD_ID, file_format: fmt };

  const filters = activeOverrideFilters();
  if (filters.length) {
    body.override_filters = filters.map((f) => ({
      column_name: f.column_name,
      generic_filter: { op: "IN", values: f.values },
      negate: false,
    }));
  }

  // pdf_options only apply to PDF; other formats ignore them.
  if (fmt === "PDF") body.pdf_options = buildPdfOptions(opts);

  const res = await fetch(`${HOST}/api/rest/2.0/report/liveboard`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
      // Same-origin cookie session? Nothing more needed. Trusted auth?
      // Authorization: `Bearer ${token}`,
    },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // The 400 body carries the real reason (e.g. CONTINUOUS not enabled) — surface it.
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    console.error("Export failed:", res.status, detail);
    return;
  }

  // The endpoint returns an extensionless octet-stream; honour a real Content-Type if present
  // (a multi-viz CSV comes back as a ZIP), else tag the Blob with the format's MIME.
  const ct = res.headers.get("content-type") || "";
  const isZip = /zip/i.test(ct);
  const mime = isZip ? "application/zip" : (ct && !/octet-stream/i.test(ct) ? ct : meta.mime);
  const ext = isZip ? "zip" : meta.ext;

  const blob = new Blob([await res.blob()], { type: mime });
  download(blob, `liveboard-${LIVEBOARD_ID}.${ext}`);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
```

That's the whole feature: a menu button → your dialog → `report/liveboard` → a saved file, with
the active filters baked in and every option under your control.

---

## 7. Key things to know (the non-obvious parts)

1. **Read the action id from both places.** New experience puts it at `payload.data.id`, Classic
   at `payload.id`. Use `payload?.id ?? payload?.data?.id`.

2. **This is a Liveboard-level export — no answer session involved.** Unlike a build-your-own-PDF
   action, you never call `answerService.fetchData()`. `report/liveboard` renders the whole board
   server-side. (If you need per-viz *row data* instead of a rendered file, that's the other
   pattern — see [callback-action.md](callback-action.md).)

3. **The endpoint returns an extensionless `application/octet-stream`.** Wrap it in a Blob tagged
   with the correct MIME so the browser saves it with the right extension. A multi-viz CSV comes
   back as a **ZIP** — check the response `Content-Type`.

4. **`pdf_options` apply only to PDF.** For XLSX/CSV/PNG they're ignored — don't send them (and
   there's nothing to show in the dialog).

5. **`truncate_table: false` fixes wide-table cutoff.** This is the main reason to export via
   REST: the native modal will clip wide / cross-tab / form-report tables; `false` keeps every
   column and row. `truncate_table: true` is only accepted together with
   `visualization_identifiers` (a single-viz export); on a whole-Liveboard export the API
   answers HTTP 400 (`TruncateTables cannot be true when layout type set to PINBOARD`). The
   native `HostEvent.DownloadAsPdf` dialog takes no options from the SDK and always sends
   `truncateTables:true` in its Liveboard layout.

   **Whole-Liveboard caveat (measured):** with *no* `visualization_identifiers`, ThoughtSpot
   **ignores `truncate_table:false`** and long tables are cut (e.g. 14 of 17 rows). To get every
   row for the whole Liveboard, list every viz id (`POST /metadata/search` with
   `include_visualization_headers:true` — cheap, runs no queries) and send them all as
   `visualization_identifiers` with `truncate_table:false`. The playground does this automatically.

   | Scope | Truncate | Request | Result |
   | --- | --- | --- | --- |
   | Whole Liveboard | OFF | all viz ids + `truncate_table:false` | every row, **one visualization per page** |
   | Whole Liveboard | ON | no ids, no `truncate_table` | Liveboard grid layout, long tables may be cut |
   | Specific viz(s) | OFF / ON | those ids + `truncate_table` | OFF = all rows; ON = may be cut |

   The default (Truncate off) therefore exports a whole Liveboard as one visualization per page with every row; turn Truncate on to keep the Liveboard layout.

   The caption "All rows and columns may not be shown" is printed under tables regardless — it
   does not mean anything was truncated.

6. **Auth & CORS.** The call uses the same credentials as the rest of your app. Same-origin with a
   cookie session "just works" (`credentials: "include"`). From a **different origin**, browsers
   block the cross-site request — front it with a first-party reverse proxy (or your own backend)
   that forwards the caller's bearer token. Don't mint an admin token in the browser.

7. **`CONTINUOUS` page size is beta and needs enablement.** If the instance hasn't enabled it, the
   API returns **400**. Default to `A4` and treat Continuous as opt-in; read the 400 body to tell
   the user why.

8. **Bake filters in explicitly.** The export reflects `override_filters`, not "whatever looks
   applied." Map every active filter to `{ column_name, generic_filter: { op: "IN", values } }`.

9. **Downloads work in the iframe; `window.print()` doesn't.** Save the returned bytes as a Blob.

10. **Want a one-click variant too?** Register a second action (e.g. `id: "export"`, name
    "Custom Export option") and route it straight to `exportLiveboard(DEFAULT_OPTS)` — no dialog.
    Both buttons share Steps 5–6.

---

## 8. Implementation checklist

1. Embed the liveboard; keep the embed instance.
2. Register the Callback action in the Liveboard menu (SDK `customActions`, or Develop → Custom
   actions). Use `position: MENU`, `target: LIVEBOARD`.
3. Optionally hide the native Download (`hiddenActions`) so your button is the only export path.
4. `embed.on(EmbedEvent.CustomAction, handler)`; match `payload?.id ?? payload?.data?.id`.
5. Open your options dialog, seeded from your defaults; show PDF-only knobs only for PDF.
6. On submit, collect the choices into an options object (ephemeral — don't overwrite your config).
7. Build `override_filters` from the current active filters.
8. `POST /api/rest/2.0/report/liveboard` with `metadata_identifier`, `file_format`,
   `override_filters`, and (PDF only) `pdf_options`.
9. Save the response as a Blob with the right MIME/extension (watch for ZIP on multi-viz CSV).

---

## 9. Reference

**Event:** `EmbedEvent.CustomAction` — fired to the host when a Callback action is clicked. The
payload carries the action `id` and `data`.

**`CustomActionsPosition`:** `PRIMARY` · `MENU` · `CONTEXTMENU`
**`CustomActionTarget`:** `LIVEBOARD` · `VIZ` · `ANSWER` · `SPOTTER`

**REST endpoint:** `POST /api/rest/2.0/report/liveboard` — renders a liveboard to a file, returned
as `application/octet-stream`.

Request body:

```jsonc
{
  "metadata_identifier": "<LIVEBOARD_GUID>",
  "file_format": "PDF",            // PDF | XLSX | CSV | PNG
  "override_filters": [
    { "column_name": "Region", "generic_filter": { "op": "IN", "values": ["East", "West"] }, "negate": false }
  ],
  "pdf_options": {                 // PDF only
    "page_size": "A4",             // A4 | CONTINUOUS (beta, needs enablement)
    "page_orientation": "LANDSCAPE",
    "truncate_table": false,        // false = show ALL columns/rows
    "include_cover_page": true,
    "include_filter_page": true,
    "include_page_number": true,
    "include_custom_logo": true,
    "page_footer_text": "Confidential"
  }
}
```

**Format → MIME / extension:**

| `file_format` | MIME                                                                     | ext    |
| ------------- | ------------------------------------------------------------------------ | ------ |
| PDF           | `application/pdf`                                                         | `pdf`  |
| XLSX          | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`       | `xlsx` |
| CSV           | `text/csv` (or `application/zip` when multi-viz)                          | `csv`  |
| PNG           | `image/png`                                                              | `png`  |

**Related:** [callback-action.md](callback-action.md) — the sibling pattern for running host code
that builds the output *itself* from a visualization's row data (answer session + `fetchData` +
pagination), rather than exporting a server-rendered file.
