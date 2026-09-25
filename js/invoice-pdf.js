/**
 * invoice-pdf.js — host-side handler for the "Download invoice pdf" callback custom action.
 *
 * Rewritten 2026-07-01 to match the updated BYOC Muze chart, which now renders REGIONAL SALES
 * STATEMENTS from live ThoughtSpot data (no baked sample data): rows grouped by Region → one
 * printable statement per region, with "Employee · Product" line items and a Total Sales Amount
 * total. `buildStatementsPdf()` + `pickCol()` + the grouping/doc logic are copied from the chart
 * (`misc/invoice_muze copy/invoice.js`); the ONLY change is the data source — here it comes from
 * `answerService.fetchData()` (paginated), not the chart's `getDataFromSearchQuery()`.
 *
 * (Filename kept as invoice-pdf.js so the app-injected action id/import don't churn; the content
 * is sales statements now that the chart pivoted from invoices to regional sales.)
 */

/* PAGE BREAK OPTIONS — keep in sync with the chart. 1in = 72pt in PDF space. */
const PAGE_SIZE = 'letter'; // 'letter' | 'a4'
const PAGE_ORIENTATION = 'portrait'; // 'portrait' | 'landscape'
const PAGE_MARGIN_IN = 0.5; // printable margin, in inches

// Format a number as USD; non-numeric values pass through unchanged.
function fmtUSD(v) {
  const n = Number(v);
  if (!isFinite(n) || v === '' || v == null) return String(v == null ? '' : v);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/* ------------------------------------------------------------
   DATA: paginate answerService, normalize to row objects, and
   capture the column schema (name + type) for column resolution.
------------------------------------------------------------ */

// Upper bound on rows pulled into a single client-side PDF — a guard against a viz with millions
// of rows, not a business rule. Paging stops here and the export says so.
const MAX_PDF_ROWS = 50_000;

// Pull every row from the viz behind the action. Returns { rows, schema }.
// answerService.fetchData(offset, size) → { columns, data } (column-oriented `columnDataLite`).
export async function fetchAllRows(answerService, pageSize = 1000) {
  let offset = 0;
  let all = [];
  let schema = null;
  for (;;) {
    const res = await answerService.fetchData(offset, pageSize);
    if (!schema) schema = extractSchema(res);
    const rows = normalizeRows(res);
    all = all.concat(rows);
    // An EMPTY page is end-of-data. Checked on its own because `rows.length < pageSize` cannot
    // catch it if a caller passes a non-positive pageSize — the loop would then re-fetch the same
    // offset forever against a viz that answers past-the-end with `[]`.
    if (rows.length === 0) break;
    if (rows.length < pageSize) break; // last (partial) page
    if (all.length >= MAX_PDF_ROWS) {
      // Ceiling, not a silent truncation: a runaway viz would otherwise pull the whole table into
      // memory and hang the tab building a PDF nobody can read.
      console.warn(`[invoice-pdf] row ceiling reached (${MAX_PDF_ROWS.toLocaleString()} rows) — the PDF covers the first ${all.length.toLocaleString()} rows only.`);
      break;
    }
    offset += pageSize;
  }
  return { rows: all, schema: schema || [] };
}

// Column schema from a fetchData response. Confirmed shape: columns = [{ column: { id, name, type, dataType } }].
function extractSchema(res) {
  return ((res && res.columns) || []).map((c) => {
    const col = c.column || c;
    return { name: col.name || col.id || col.columnId, type: col.type, dataType: col.dataType };
  });
}

function firstArray(candidates) {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

// Unwrap a single data cell: primitive, { value }, { v }, or date { epochRange: { startEpoch } }.
function cellValue(v) {
  if (v == null || typeof v !== 'object') return v;
  if ('value' in v) return v.value;
  if ('v' in v) return v.v;
  if (v.epochRange) return v.epochRange.startEpoch ?? v.epochRange.endEpoch ?? '';
  return v;
}

// Turn a fetchData() response into an array of plain objects keyed by column display name.
function normalizeRows(res) {
  if (!res || typeof res !== 'object') return [];

  const cols = res.columns || [];
  const nameByIdx = [];
  const nameById = {};
  cols.forEach((c, i) => {
    const col = c.column || c;
    const cid = col.id || col.columnId || c.id || c.columnId;
    const nm = col.name || c.name;
    nameByIdx[i] = nm || cid || `col${i}`;
    if (cid) nameById[cid] = nm || cid;
  });

  const d = res.data || {};
  const lite = firstArray([
    d.columnDataLite,
    d.data && d.data.columnDataLite,
    Array.isArray(d) && d,
    d.data && Array.isArray(d.data) && d.data,
  ]);

  // A column entry's values may be a real array OR a JSON-stringified array (TS returns e.g.
  // dataValue: "[8.04505969823E7]" for some viz types) — parse both to an array.
  const valuesOf = (c) => {
    const raw = c.dataValue ?? c.values ?? c.data;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s.startsWith('[') || s.startsWith('{')) {
        try { const p = JSON.parse(s); return Array.isArray(p) ? p : [p]; } catch (_) {}
      }
      return [raw];
    }
    return raw == null ? [] : [raw];
  };
  const looksColumnEntry = (c) => c && typeof c === 'object' && ('columnId' in c || 'dataValue' in c || 'values' in c || 'data' in c);
  const isColumnOriented = Array.isArray(lite) && lite.length > 0 && looksColumnEntry(lite[0]);

  let out = [];
  if (isColumnOriented) {
    const keyOf = (c, idx) => (c.columnId && (nameById[c.columnId] || c.columnId)) || nameByIdx[idx] || `col${idx}`;
    const n = lite.reduce((m, c) => Math.max(m, valuesOf(c).length), 0);
    for (let i = 0; i < n; i++) {
      const row = {};
      lite.forEach((c, idx) => { row[keyOf(c, idx)] = cellValue(valuesOf(c)[i]); });
      out.push(row);
    }
  } else {
    const grid = firstArray([Array.isArray(d) && d, d.dataRows, d.rows, d.data && Array.isArray(d.data) && d.data]);
    if (Array.isArray(grid)) {
      out = grid.map((arr) => {
        const row = {};
        (Array.isArray(arr) ? arr : []).forEach((val, i) => { row[nameByIdx[i] || `col${i}`] = cellValue(val); });
        return row;
      });
    } else {
      console.warn('[invoice-pdf] normalizeRows: unexpected shape — inspect res.data', d);
    }
  }

  return out;
}

/* ------------------------------------------------------------
   COLUMN RESOLUTION + GROUP ROWS BY REGION → statement docs.
   (Copied from the chart; live TS column names vary in case /
   punctuation / aggregation prefixes, so resolve fuzzily.)
------------------------------------------------------------ */
function pickCol(schemaNames, candidates) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const c of candidates) if (schemaNames.includes(c)) return c;          // exact
  for (const c of candidates) {                                               // normalized ==
    const nc = norm(c);
    const hit = schemaNames.find((n) => norm(n) === nc);
    if (hit) return hit;
  }
  for (const c of candidates) {                                               // contains
    const nc = norm(c);
    const hit = schemaNames.find((n) => norm(n).includes(nc) || nc.includes(norm(n)));
    if (hit) return hit;
  }
  return null;
}

const isMeasure = (t) => String(t).toUpperCase() === 'MEASURE';
const isDimension = (t) => { const u = String(t).toUpperCase(); return u === 'ATTRIBUTE' || u === 'DIMENSION'; };

// Group normalized rows into printable statement "docs" (one per region).
export function groupStatements(rows, schema = []) {
  const schemaNames = schema.length ? schema.map((c) => c.name) : Object.keys(rows[0] || {});

  const COL_REGION = pickCol(schemaNames, ['Region']);
  const COL_COUNTRY = pickCol(schemaNames, ['Country']);
  const COL_EMP = pickCol(schemaNames, ['Employee Name', 'Employee']);
  const COL_PRODUCT = pickCol(schemaNames, ['Product']);
  const COL_AMOUNT = pickCol(schemaNames, ['Total Sales Amount', 'Sales Amount', 'Net Amount (USD)', 'Amount']);

  // Hard fallbacks so it still renders if expected names are absent: group on the first
  // dimension, sum the first measure.
  const firstMeasure = (schema.find((c) => isMeasure(c.type)) || {}).name;
  const firstDimension = (schema.find((c) => isDimension(c.type)) || {}).name;
  const GROUP = COL_REGION || firstDimension || schemaNames[0];
  const AMOUNT = COL_AMOUNT || firstMeasure || schemaNames[schemaNames.length - 1];
  const DESC_LABEL = [COL_EMP && 'Employee', COL_PRODUCT && 'Product'].filter(Boolean).join(' · ') || 'Description';

  const getVal = (row, colName) => { if (!colName) return ''; const v = row[colName]; return v == null ? '' : v; };

  // A Map, NOT a plain object: the key is live TS row data, so a group value of `__proto__`,
  // `constructor` or `toString` against `{}` either hits an inherited truthy member (skipping the
  // init) or throws on assignment — aborting the whole export over one row's text.
  const statements = new Map();
  rows.forEach((r) => {
    const key = String(getVal(r, GROUP) || '—');
    if (!statements.has(key)) {
      statements.set(key, { region: key, country: getVal(r, COL_COUNTRY), employees: new Set(), products: new Set(), items: [] });
    }
    const s = statements.get(key);
    const emp = COL_EMP ? String(getVal(r, COL_EMP)) : '';
    const prod = COL_PRODUCT ? String(getVal(r, COL_PRODUCT)) : '';
    if (emp) s.employees.add(emp);
    if (prod) s.products.add(prod);
    s.items.push({ descr: [emp, prod].filter(Boolean).join(' · ') || 'Line item', amt: getVal(r, AMOUNT) });
  });

  // Normalize a grouped statement into the generic "document" shape the PDF builder consumes.
  return [...statements.values()].map((s) => {
    return {
      heading: s.region,
      sub: [COL_COUNTRY ? String(s.country || '') : ''].filter(Boolean),
      meta: [
        ['Line Items', String(s.items.length)],
        ...(COL_EMP ? [['Employees', String(s.employees.size)]] : []),
        ...(COL_PRODUCT ? [['Products', String(s.products.size)]] : []),
      ],
      items: s.items,
      descLabel: DESC_LABEL,
      amountLabel: AMOUNT,
      footerLeft: ['Generated from ThoughtSpot search data'],
      footerRight: `* Amounts reflect ${AMOUNT}`,
    };
  });
}

/* ------------------------------------------------------------
   PDF BUILDER — copied verbatim from the chart. Pure-JS, no CDN:
   one region per page, long regions flow onto extra pages.
------------------------------------------------------------ */
function buildStatementsPdf(list) {
  const PT = 72; // points per inch
  const SIZES_PT = { letter: [612, 792], a4: [595.28, 841.89] };
  let [pw, ph] = SIZES_PT[PAGE_SIZE] || SIZES_PT.letter;
  if (PAGE_ORIENTATION === 'landscape') [pw, ph] = [ph, pw];
  const M = PAGE_MARGIN_IN * PT;
  const RX = pw - M;             // right edge of the printable area
  const rowH = 20;               // per line-item row height
  const tableTop = M + 100;      // where the line-item header sits
  const footerReserve = 96;      // vertical space kept for total + footer
  const bottomLimit = ph - M - footerReserve;
  const rowsCap = Math.max(1, Math.floor((bottomLimit - (tableTop + 10)) / rowH));

  // Text widths via canvas. Helvetica metrics ≈ PDF base Helvetica, and the
  // metric ratio is size-unit agnostic, so px width == pt width at equal size.
  const mctx = document.createElement('canvas').getContext('2d');
  const fontCss = (size, w) =>
    `${w === 'b' ? 'bold ' : w === 'i' ? 'italic ' : ''}${size}px Helvetica, Arial, sans-serif`;
  const widthOf = (s, size, w) => { mctx.font = fontCss(size, w); return mctx.measureText(String(s)).width; };

  // Encode JS string -> WinAnsi bytes with PDF string escaping (ASCII output).
  const WINANSI = { 0x2014: 0x97, 0x2013: 0x96, 0x2018: 0x91, 0x2019: 0x92,
                    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2026: 0x85 };
  const enc = (s) => {
    let out = '';
    for (const ch of String(s)) {
      let c = ch.codePointAt(0);
      if (WINANSI[c] != null) c = WINANSI[c];
      if (c > 0xff) c = 0x3f;                                  // '?' for unencodable
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c); // ( ) \
      else if (c < 0x20) out += ' ';
      else if (c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0'); // octal for >126
      else out += String.fromCharCode(c);
    }
    return out;
  };
  const fit = (s, maxW, size, w) => {
    s = String(s);
    if (widthOf(s, size, w) <= maxW) return s;
    while (s.length > 1 && widthOf(s + '…', size, w) > maxW) s = s.slice(0, -1);
    return s + '…';
  };

  // Each statement produces 1+ page streams (chunked by rowsCap).
  const streams = [];
  list.forEach((doc) => {
    const chunks = [];
    for (let i = 0; i < doc.items.length; i += rowsCap) chunks.push(doc.items.slice(i, i + rowsCap));
    if (!chunks.length) chunks.push([]);

    let running = 0;
    chunks.forEach((chunk, ci) => {
      const isLast = ci === chunks.length - 1;
      const ops = [];
      // y is measured from the TOP; PDF y-up conversion is (ph - y).
      const text = (x, y, s, size, w, col) => {
        const f = w === 'b' ? 'F2' : w === 'i' ? 'F3' : 'F1';
        const c = col || [0.07, 0.07, 0.07];
        ops.push(`${c[0]} ${c[1]} ${c[2]} rg BT /${f} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(ph - y).toFixed(2)} Tm (${enc(s)}) Tj ET`);
      };
      const rtext = (xr, y, s, size, w, col) => text(xr - widthOf(s, size, w), y, s, size, w, col);
      const hline = (x1, x2, y, g, lw) =>
        ops.push(`${g} ${g} ${g} RG ${lw.toFixed(2)} w ${x1.toFixed(2)} ${(ph - y).toFixed(2)} m ${x2.toFixed(2)} ${(ph - y).toFixed(2)} l S`);

      // ---- header (region + meta) ----
      const y = M + 6;
      text(M, y, 'Sales Statement', 9, 'b');
      text(M, y + 15, doc.heading + (ci > 0 ? '  (cont.)' : ''), 13, 'b');
      let sy = y + 30;
      doc.sub.forEach((line) => { if (line) { text(M, sy, line, 9, 'n'); sy += 13; } });

      let my = y;
      doc.meta.forEach(([l, v]) => {
        const lw = widthOf(l + ' ', 9, 'b'), vw = widthOf(String(v), 9, 'n');
        const x = RX - lw - vw;
        text(x, my, l, 9, 'b');
        text(x + lw, my, String(v), 9, 'n');
        my += 13;
      });

      // ---- line-item table ----
      let ty = tableTop;
      text(M, ty, doc.descLabel, 11, 'b');
      rtext(RX, ty, doc.amountLabel, 11, 'b');
      hline(M, RX, ty + 6, 0.47, 1);
      const descMaxW = (RX - 120) - M;
      chunk.forEach((it) => {
        running += Number(it.amt) || 0;
        ty += rowH;
        text(M, ty - 4, fit(it.descr, descMaxW, 11, 'n'), 11, 'n');
        rtext(RX, ty - 4, fmtUSD(it.amt), 11, 'n');
        hline(M, RX, ty + 6, 0.87, 0.7);
      });

      // ---- total row (only on the final page of a region) ----
      if (isLast) {
        ty += 24;
        hline(M, RX, ty - 14, 0.47, 1);
        text(M, ty - 4, 'Total', 11, 'b');
        rtext(RX, ty - 4, fmtUSD(running), 11, 'b');
      }

      // ---- footer pinned near the bottom ----
      const fy = ph - M - 40;
      let fyy = fy;
      doc.footerLeft.forEach((line) => { text(M, fyy, line, 9, 'n'); fyy += 12; });
      rtext(RX, fy, doc.footerRight, 9, 'i', [0.2, 0.2, 0.2]);

      streams.push(ops.join('\n'));
    });
  });

  // ---- assemble objects: 1 catalog, 2 pages, 3-5 fonts, then content+page pairs ----
  const n = streams.length;
  const cStart = 6, pStart = cStart + n, last = pStart + n - 1;
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${pStart + i} 0 R`).join(' ')}] /Count ${n} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`;
  for (let i = 0; i < n; i++) {
    objs[cStart + i] = `<< /Length ${streams[i].length} >>\nstream\n${streams[i]}\nendstream`;
    objs[pStart + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${cStart + i} 0 R >>`;
  }

  // ---- serialize with xref (everything is ASCII, so byte offset == string length) ----
  let pdf = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i <= last; i++) { off[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= last; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

// Build the multi-page PDF from statement docs and trigger a Blob download.
export function downloadStatementsPdf(docs) {
  const pdf = buildStatementsPdf(docs);
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sales-statements.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
