/**
 * discovery.js — talk to the ThoughtSpot REST API to find what a tester can embed.
 *
 * Used by the connection bar: verify the session, then list worksheets, liveboards,
 * a liveboard's visualizations, and a worksheet's standalone answers. Works with the
 * browser session cookie (AuthType.None) or an optional in-memory bearer token.
 */

// In-memory only — never persisted to disk. Set by the UI for token-based discovery.
let bearerToken = '';
export function setBearerToken(t) { bearerToken = t || ''; }
export function hasBearerToken() { return !!bearerToken; }
export function getBearerToken() { return bearerToken; }

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...extra,
  };
}

async function api(host, path, options = {}) {
  const url = `${host.replace(/\/$/, '')}${path}`;
  const method = (options.method || 'GET').toUpperCase();
  try {
    const resp = await fetch(url, { credentials: 'include', ...options, headers: headers(options.headers) });
    // Report into the "APIs Used" panel (best-effort; the hook may not be wired).
    try { window.__onApiCall?.({ scope: 'TS REST', method, path, status: resp.status }); } catch (_) {}
    return resp;
  } catch (err) {
    try { window.__onApiCall?.({ scope: 'TS REST', method, path, status: 0 }); } catch (_) {}
    throw err;
  }
}

// Base for the local Node server (empty = same origin). Set window.TS_API_BASE to use Live Server.
const API_BASE = (typeof window !== 'undefined' && window.TS_API_BASE) || '';

/**
 * Call a TS REST endpoint, choosing direct-vs-relayed by auth mode.
 *   • Browser-session (no bearer token): call ThoughtSpot directly, like discoverObjects — works when
 *     the origin is on ThoughtSpot's CORS allowlist.
 *   • Trusted-auth (bearer token set): relay through the local server's /api/ts-rest, which forwards
 *     the caller's OWN token. Cookieless trusted auth blocks direct browser→TS REST (CORS), so the
 *     write/search operations behind the Personal-liveboards feature must go through the proxy.
 * Returns a normal fetch Response either way (so resp.ok / .status / .json() / .text() all work).
 *
 * @param {string} host
 * @param {string} path   TS REST path (must also be allowlisted server-side for the relay)
 * @param {{ method?: string, body?: any }} [opts]  body is a plain object (JSON-encoded here)
 */
async function apiRest(host, path, { method = 'POST', body } = {}) {
  if (!bearerToken) {
    return api(host, path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    const resp = await fetch(`${API_BASE}/api/ts-rest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({ path, method, body: body ?? {} }),
    });
    try { window.__onApiCall?.({ scope: 'server→TS', method, path, status: resp.status }); } catch (_) {}
    return resp;
  } catch (err) {
    try { window.__onApiCall?.({ scope: 'server→TS', method, path, status: 0 }); } catch (_) {}
    throw err;
  }
}

/** Pull a concise message out of a TS REST error response (mirrors downloadLiveboardReport's parser). */
async function restError(resp) {
  let detail = `HTTP ${resp.status}`;
  const raw = await resp.text().catch(() => '');
  if (raw) {
    try {
      const e = JSON.parse(raw);
      const err = e?.error ?? e;
      // .message/.debug are usually strings, but TS sometimes nests a non-string (object/array) there —
      // taking it verbatim leaks "[object Object]" into the toast. Accept only a non-empty STRING, else
      // fall back to the stringified error so the real reason always surfaces.
      const pick = [err?.message, err?.debug].find((v) => typeof v === 'string' && v.trim());
      detail = pick || (typeof err === 'string' ? err : JSON.stringify(err)) || detail;
    } catch (_) { detail = raw.slice(0, 300); }
  }
  return String(detail).slice(0, 500);
}

/**
 * Create a Liveboard schedule — the webhook composer's "Fire real delivery" flow. Relayed through
 * the local server with the caller's OWN token (never mints), so it only works with a REST-capable
 * session (trusted-auth bearer token). Returns { ok, id, name } or { ok:false, error, status }.
 */
export async function createSchedule(host, body) {
  const resp = await apiRest(host, '/api/rest/2.0/schedules/create', { method: 'POST', body });
  if (!resp.ok) return { ok: false, error: await restError(resp), status: resp.status };
  const data = await resp.json().catch(() => ({}));
  return { ok: true, id: data?.id || data?.identifier || null, name: body?.name || null };
}

/** Verify the session and return the current user + org. */
export async function discoverOrg(host) {
  try {
    const resp = await api(host, '/api/rest/2.0/auth/session/user');
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, status: resp.status };
    const data = await resp.json();
    return {
      ok: true,
      userName: data.display_name || data.name || 'User',
      orgName: data.current_org?.name || data.orgs?.[0]?.name || '',
    };
  } catch (err) {
    // fetch() threw with no HTTP status. Two very different causes look identical here:
    //   • CORS    — the host answered, but the browser blocked us from reading the
    //               cross-origin response (this origin isn't on TS's CORS allowlist).
    //   • network — the host is genuinely unreachable (offline, DNS, TLS, down).
    // Disambiguate with a no-cors probe: it returns an opaque response for any host
    // that answers and only rejects when the connection itself fails. If it resolves,
    // the host is up, so the real failure was CORS — not reachability.
    const reason = (await probeReachable(host)) ? 'cors' : 'network';
    return { ok: false, error: err.message, reason };
  }
}

/** True if the host answered at all (opaque no-cors response) — distinguishes CORS from down. */
async function probeReachable(host) {
  try {
    await fetch(`${host.replace(/\/$/, '')}/api/rest/2.0/auth/session/user`, {
      mode: 'no-cors',
      credentials: 'include',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List worksheets/models and liveboards in parallel.
 *
 * include_headers:true returns each object's metadata_header, which carries its tags — so the
 * host UI can group/filter liveboards by tag (the categorization pattern) without a separate
 * store. Pass tagFilter to push the filtering server-side via tag_identifiers instead.
 *
 * @param {string} host
 * @param {string} [tagFilter]  optional tag name; when set, liveboards are filtered by tag_identifiers
 */
export async function discoverObjects(host, tagFilter = '') {
  const search = (type, withTag = false) => api(host, '/api/rest/2.0/metadata/search', {
    method: 'POST',
    body: JSON.stringify({
      metadata: [{ type }],
      record_size: 10000,
      include_headers: true,
      ...(withTag && tagFilter ? { tag_identifiers: [tagFilter] } : {}),
      sort_options: { field_name: 'NAME', order: 'ASC' },
    }),
  });
  try {
    const [wsResp, lbResp] = await Promise.all([search('LOGICAL_TABLE'), search('LIVEBOARD', true)]);
    const pick = async (resp, kind) => {
      if (!resp.ok) return [];
      const arr = await resp.json();
      return (Array.isArray(arr) ? arr : [])
        .filter(m => m.metadata_type === kind)
        .map(m => ({
          id: m.metadata_id,
          name: m.metadata_name || 'Untitled',
          tags: (m.metadata_header?.tags || []).map(t => t?.name || t).filter(Boolean),
        }));
    };
    return {
      ok: true,
      worksheets: await pick(wsResp, 'LOGICAL_TABLE'),
      liveboards: await pick(lbResp, 'LIVEBOARD'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** List the visualizations on a liveboard. */
export async function discoverViz(host, liveboardId) {
  try {
    const resp = await api(host, '/api/rest/2.0/metadata/liveboard/data', {
      method: 'POST',
      body: JSON.stringify({ metadata_identifier: liveboardId, record_size: 1 }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    return {
      ok: true,
      visualizations: (data.contents || [])
        .filter(v => v.visualization_id)
        .map(v => ({ id: v.visualization_id, name: v.visualization_name || 'Untitled' })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List all standalone saved Answers on the instance. Answers are top-level ANSWER metadata
 * objects (like Liveboards), so we search that type directly and read the top-level results —
 * NOT a worksheet's `dependent_objects` (that field is an opaque map, not keyed by type, so the
 * old dependent-traversal silently returned nothing). Mirrors discoverObjects' single-type search.
 */
export async function discoverAnswers(host) {
  try {
    const resp = await api(host, '/api/rest/2.0/metadata/search', {
      method: 'POST',
      body: JSON.stringify({
        metadata: [{ type: 'ANSWER' }],
        record_size: 10000,
        sort_options: { field_name: 'NAME', order: 'ASC' },
      }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const arr = await resp.json();
    const answers = (Array.isArray(arr) ? arr : [])
      .filter(m => m.metadata_type === 'ANSWER')
      .map(m => ({ id: m.metadata_id, name: m.metadata_name || 'Untitled' }));
    return { ok: true, answers };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Personal liveboards (per-user editable copies) ────────────────────────────
// A "personalize" flow: copy a standard liveboard into a user-owned clone, tag it so it can be
// re-discovered later, and list a user's copies to rebuild the tab strip. All go through apiRest()
// so they work under both browser-session (direct) and trusted-auth (server relay) modes.

/** Verify the session and return the current user's identity fields (login name, GUID, display, org). */
export async function getCurrentUser(host) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/auth/session/user', { method: 'GET' });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    const d = await resp.json();
    return {
      ok: true,
      userName: d.name || '',                                  // login id → created_by_user_identifiers
      userId: d.id || '',                                      // GUID (also valid for created_by)
      displayName: d.display_name || d.name || 'User',
      orgName: d.current_org?.name || d.orgs?.[0]?.name || '',
    };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * The bearer for the CURRENT session (getCurrentUserToken, 9.4.0.cl+). It does not mint a new
 * token — it returns the one behind the session you already have, which is exactly what a
 * browser-session (cookie) connection needs when something outside the iframe wants a bearer.
 * With trusted auth we already hold one, so callers should prefer getBearerToken() first.
 */
export async function sessionToken(host) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/auth/session/token', { method: 'GET' });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    const d = await resp.json();
    if (!d?.token) return { ok: false, error: 'No token in the session-token response' };
    return { ok: true, token: d.token, expiresAt: d.expiration_time_in_millis || 0, user: d.valid_for_username || '' };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Make a full, user-owned copy of a liveboard. Returns the new liveboard GUID. (copyobject, 10.3.0.cl+) */
export async function copyLiveboard(host, sourceId, title, description = '') {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/metadata/copyobject', {
      method: 'POST',
      body: { identifier: sourceId, type: 'LIVEBOARD', title, description },
    });
    if (!resp.ok) return { ok: false, error: await restError(resp), status: resp.status };
    const d = await resp.json();
    return { ok: true, id: d.metadata_id };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Create the tag if it doesn't exist (idempotent enough for demo use). Returns true on success/exists. */
export async function ensureTag(host, tagName) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/tags/create', { method: 'POST', body: { name: tagName } });
    return resp.ok || resp.status === 409 || resp.status === 400; // 400/409 typically = already exists
  } catch (_) { return false; }
}

/**
 * The per-source scoping tag that records WHICH board a personal copy was cloned from. Keyed to the
 * source board's GUID, so it's rename-proof (renaming the board or the copy never changes it) and lets
 * discovery attribute a copy to its origin server-side — unlike a title prefix. See docs/personal-liveboards.md §5.
 */
export const sourceTag = (sourceId) => `src:${sourceId}`;

/** Ensure each tag exists, then assign them all to a liveboard in one call. Requires edit access (the owner). */
export async function assignTags(host, metadataId, tags) {
  try {
    const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
    if (!list.length) return { ok: true, status: 200, error: '' };
    for (const t of list) await ensureTag(host, t);
    const resp = await apiRest(host, '/api/rest/2.0/tags/assign', {
      method: 'POST',
      body: { metadata: [{ identifier: metadataId, type: 'LIVEBOARD' }], tag_identifiers: list },
    });
    return { ok: resp.ok, status: resp.status, error: resp.ok ? '' : await restError(resp) };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Ensure a tag exists, then assign it to a liveboard. Requires edit access (the caller owns the copy). */
export async function assignTag(host, metadataId, tag) {
  return assignTags(host, metadataId, [tag]);
}

/**
 * List the current user's personal-copy liveboards (scoped by owner + the scoping tag). The result is
 * reconciled app-side against the per-source cache/naming to attribute copies to a specific source board.
 * @param {string} host
 * @param {string} _sourceId  source board id (used app-side for reconciliation, not sent to the API)
 * @param {{ userName?: string, tag?: string }} [opts]
 */
export async function listPersonalCopies(host, _sourceId, { userName, tag } = {}) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/metadata/search', {
      method: 'POST',
      body: {
        metadata: [{ type: 'LIVEBOARD' }],
        ...(userName ? { created_by_user_identifiers: [userName] } : {}),
        ...(tag ? { tag_identifiers: [tag] } : {}),
        record_size: -1,
        record_offset: 0,
        include_headers: true,
        sort_options: { field_name: 'MODIFIED', order: 'DESC' },
      },
    });
    if (!resp.ok) return { ok: false, error: await restError(resp), status: resp.status };
    const data = await resp.json();
    const copies = (Array.isArray(data) ? data : [])
      .filter(m => m.metadata_type === 'LIVEBOARD')
      .map(m => ({
        id: m.metadata_id,
        title: m.metadata_name || 'Copy',
        // Each copy's tags (from metadata_header) let us attribute it to a source board via its src:<guid>
        // tag, instead of guessing from the title. include_headers:true (set above) makes tags available.
        tags: (m.metadata_header?.tags || []).map(t => t?.name || t).filter(Boolean),
      }));
    return { ok: true, copies };
  } catch (err) { return { ok: false, error: err.message }; }
}

/** Delete a liveboard (used to remove a personal copy). Requires the caller to own it. */
export async function deleteLiveboard(host, id) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/metadata/delete', {
      method: 'POST',
      body: { metadata: [{ identifier: id, type: 'LIVEBOARD' }] },
    });
    return { ok: resp.ok, status: resp.status, error: resp.ok ? '' : await restError(resp) };
  } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Per-format metadata for the report API. CSV with multiple vizes actually returns a ZIP
 * (one CSV per viz), so we tag it accordingly and name the download .zip in that case —
 * but a single-viz board comes back as a plain CSV. We can't know which ahead of time, so
 * we trust the response Content-Type when present and fall back to the table below.
 */
export const REPORT_FORMATS = {
  PDF:  { mime: 'application/pdf', ext: 'pdf' },
  XLSX: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  CSV:  { mime: 'text/csv', ext: 'csv' },
  PNG:  { mime: 'image/png', ext: 'png' },
};

/**
 * Map the playground's friendly export options onto the REST API's pdf_options shape.
 * Only keys with a meaningful value are emitted, so an empty exportOpts yields {} (API defaults).
 */
function buildPdfOptions(o = {}) {
  const p = {};
  if (o.pageSize) p.page_size = o.pageSize;                 // 'A4' | 'CONTINUOUS'
  if (o.orientation) p.page_orientation = o.orientation;    // 'PORTRAIT' | 'LANDSCAPE'
  if (typeof o.truncateTable === 'boolean') p.truncate_table = o.truncateTable;
  if (typeof o.includeCoverPage === 'boolean') p.include_cover_page = o.includeCoverPage;
  if (typeof o.includeFilterPage === 'boolean') p.include_filter_page = o.includeFilterPage;
  if (typeof o.includePageNumber === 'boolean') p.include_page_number = o.includePageNumber;
  if (typeof o.includeCustomLogo === 'boolean') p.include_custom_logo = o.includeCustomLogo;
  if (o.footerText) p.page_footer_text = o.footerText;
  return p;
}

/**
 * Export a liveboard via the REST report API and return it as a Blob.
 *
 * POST /api/rest/2.0/report/liveboard returns the report as an extensionless
 * application/octet-stream body — we wrap it in a Blob tagged with the format's real MIME
 * type so the browser can save it with the right extension. Uses the same auth as discovery
 * (session cookie or in-memory bearer token).
 *
 * @param {string} host          ThoughtSpot host URL
 * @param {string} liveboardId   GUID of the liveboard to export
 * @param {string} [format]      'PDF' | 'XLSX' | 'CSV' | 'PNG'  (defaults to PDF)
 * @param {Array<{column_name: string, values: string[]}>} [overrideFilters]  active filters to bake in
 * @param {object} [exportOpts]  friendly export options; mapped to pdf_options when format === 'PDF'
 * @returns {Promise<{ok:true, blob:Blob, ext:string} | {ok:false, error:string, status?:number}>}
 */
export async function downloadLiveboardReport(host, liveboardId, format = 'PDF', overrideFilters = [], exportOpts = {}) {
  const fmt = REPORT_FORMATS[format] ? format : 'PDF';
  const meta = REPORT_FORMATS[fmt];
  try {
    const body = { metadata_identifier: liveboardId, file_format: fmt };
    if (overrideFilters.length) {
      body.override_filters = overrideFilters.map(f => ({
        column_name: f.column_name,
        generic_filter: { op: 'IN', values: f.values },
        negate: false,
      }));
    }
    // PDF gets the full pdf_options surface — page size (= page-break behaviour), orientation,
    // and crucially truncate_table:false so wide/form/cross-tab tables aren't cut off. These
    // knobs are the host app's to set, which is the whole point of exporting via REST instead
    // of the native modal. (Some pdf_options are Early Access — enable on the instance if rejected.)
    if (fmt === 'PDF') body.pdf_options = buildPdfOptions(exportOpts);
    const resp = await api(host, '/api/rest/2.0/report/liveboard', {
      method: 'POST',
      headers: { Accept: 'application/octet-stream' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      // Read the body once as text, then try to parse — the 400 error object is generic, so dig
      // through .message/.debug and fall back to the raw text so the real reason surfaces. Only take a
      // non-empty STRING from message/debug — TS can nest a non-string there (→ "[object Object]").
      let detail = `HTTP ${resp.status}`;
      const raw = await resp.text().catch(() => '');
      if (raw) {
        try {
          const e = JSON.parse(raw);
          const err = e?.error ?? e;
          const pick = [err?.message, err?.debug].find((v) => typeof v === 'string' && v.trim());
          detail = pick || (typeof err === 'string' ? err : JSON.stringify(err)) || detail;
        } catch (_) { detail = raw.slice(0, 300); }
      }
      return { ok: false, error: String(detail).slice(0, 500), status: resp.status };
    }
    const raw = await resp.blob();
    // A multi-viz CSV comes back as a ZIP — honour the server's Content-Type if it tells us.
    const ct = resp.headers.get('content-type') || '';
    const isZip = /zip/i.test(ct);
    const mime = isZip ? 'application/zip' : (ct && !/octet-stream/i.test(ct) ? ct : meta.mime);
    const ext = isZip ? 'zip' : meta.ext;
    return { ok: true, blob: new Blob([raw], { type: mime }), ext };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Back-compat shim: the original PDF-only helper, now a thin wrapper over the format-aware one. */
export function downloadLiveboardPdf(host, liveboardId, overrideFilters = []) {
  return downloadLiveboardReport(host, liveboardId, 'PDF', overrideFilters);
}

// ── Spotter AI (REST) — headless insights ─────────────────────────────────────
// Both endpoints require Spotter enabled on the cluster + the CAN_USE_SPOTTER privilege, and at
// least view access to the data source. They are Beta (relevant-questions: 10.13.0.cl+, answer:
// 10.4.0.cl+). They use the same auth as discovery (session cookie or in-memory bearer token).

/** Pull a concise, actionable message out of a TS REST AI error response. */
async function aiError(resp) {
  let detail = `HTTP ${resp.status}`;
  try {
    const e = await resp.json();
    detail = e?.error?.message || (typeof e?.error === 'string' ? e.error : JSON.stringify(e?.error)) || detail;
  } catch (_) {}
  if (resp.status === 403) detail += ' — needs the CAN_USE_SPOTTER privilege and Spotter enabled on the cluster.';
  if (resp.status === 401) detail += ' — not authenticated (session expired or token rejected).';
  return detail;
}

/**
 * Suggest analytical questions for a data source (and/or liveboards/answers).
 * POST /api/rest/2.0/ai/relevant-questions/
 *
 * @param {string} host
 * @param {{ query?: string, worksheetIds?: string[], liveboardIds?: string[], limit?: number }} opts
 * @returns {Promise<{ok:true, questions:Array<{query,data_source_identifier,data_source_name}>} | {ok:false, error:string, status?:number}>}
 */
export async function aiRelevantQuestions(host, { query, worksheetIds = [], liveboardIds = [], limit = 5 } = {}) {
  const metadata_context = {};
  if (worksheetIds.length) metadata_context.data_source_identifiers = worksheetIds;
  if (liveboardIds.length) metadata_context.liveboard_identifiers = liveboardIds;
  try {
    const resp = await api(host, '/api/rest/2.0/ai/relevant-questions/', {
      method: 'POST',
      body: JSON.stringify({
        query: query || 'What are the most important insights in this data?',
        metadata_context,
        limit_relevant_questions: limit,
      }),
    });
    if (!resp.ok) return { ok: false, error: await aiError(resp), status: resp.status };
    const data = await resp.json();
    return { ok: true, questions: Array.isArray(data?.relevant_questions) ? data.relevant_questions : [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Generate a single AI answer for a natural-language query against a data source — no
 * conversation session. POST /api/rest/2.0/ai/answer/create
 *
 * @param {string} host
 * @param {{ query: string, metadataIdentifier: string }} opts
 * @returns {Promise<{ok:true, answer:{visualization_type,tokens,display_tokens,session_identifier,generation_number}} | {ok:false, error:string, status?:number}>}
 */
export async function aiSingleAnswer(host, { query, metadataIdentifier } = {}) {
  try {
    const resp = await api(host, '/api/rest/2.0/ai/answer/create', {
      method: 'POST',
      body: JSON.stringify({ query, metadata_identifier: metadataIdentifier }),
    });
    if (!resp.ok) return { ok: false, error: await aiError(resp), status: resp.status };
    return { ok: true, answer: await resp.json() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run a search-token query against a data source and return actual data rows.
 * POST /api/rest/2.0/searchdata — used to materialize a Spotter answer's tokens into a table
 * inline (GA endpoint; needs only view access to the data source, not CAN_USE_SPOTTER).
 *
 * @param {string} host
 * @param {{ queryString: string, worksheetId: string, recordSize?: number }} opts
 * @returns {Promise<{ok:true, columns:string[], rows:any[], totalRows:number, returned:number} | {ok:false, error:string, status?:number}>}
 */
export async function aiSearchData(host, { queryString, worksheetId, recordSize = 10 } = {}) {
  try {
    const resp = await api(host, '/api/rest/2.0/searchdata', {
      method: 'POST',
      body: JSON.stringify({
        query_string: queryString,
        logical_table_identifier: worksheetId,
        data_format: 'COMPACT',
        record_size: recordSize,
        record_offset: 0,
      }),
    });
    if (!resp.ok) return { ok: false, error: await aiError(resp), status: resp.status };
    const data = await resp.json();
    const content = (data?.contents || [])[0] || {};
    const rows = content.data_rows || [];
    return {
      ok: true,
      columns: content.column_names || [],
      rows,
      totalRows: content.available_data_row_count ?? rows.length,
      returned: content.returned_data_row_count ?? rows.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * One page of POST /api/rest/2.0/searchdata against an event-grain model — the detail half of the
 * drill-through demo. Differs from aiSearchData in two ways that matter:
 *   • it goes through apiRest(), so it works under cookieless trusted auth (which CORS-blocks a
 *     direct browser→TS call). The relay forwards the CALLER'S bearer, so RLS still applies.
 *   • it takes a record_offset, so the caller can page past the 1,000-row response cap.
 * `totalRows` comes from available_data_row_count — the full matching count, not the page size.
 *
 * @param {string} host
 * @param {{ queryString: string, modelId: string, offset?: number, size?: number }} opts
 * @returns {Promise<{ok:true, columns:string[], rows:any[], totalRows:number, returned:number} | {ok:false, error:string, status?:number}>}
 */
export async function searchDataPage(host, { queryString, modelId, offset = 0, size = 100 } = {}) {
  try {
    const resp = await apiRest(host, '/api/rest/2.0/searchdata', {
      method: 'POST',
      body: {
        query_string: queryString,
        logical_table_identifier: modelId,
        data_format: 'COMPACT',
        record_size: size,
        record_offset: offset,
      },
    });
    if (!resp.ok) return { ok: false, error: await restError(resp), status: resp.status };
    const data = await resp.json();
    const content = (data?.contents || [])[0] || {};
    const rows = content.data_rows || [];
    return {
      ok: true,
      columns: content.column_names || [],
      rows,
      totalRows: content.available_data_row_count ?? rows.length,
      returned: content.returned_data_row_count ?? rows.length,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Distinct column values for a liveboard column (for filter helpers). */
export async function discoverColumnValues(host, liveboardId, column) {
  try {
    const resp = await api(host, '/api/rest/2.0/metadata/liveboard/data', {
      method: 'POST',
      body: JSON.stringify({ metadata_identifier: liveboardId, record_size: 10000, record_offset: 0 }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const contents = (await resp.json()).contents ?? [];
    const allCols = new Set();
    contents.forEach(ct => (ct.column_names ?? []).forEach(cn => allCols.add(cn)));
    const columns = [...allCols].sort();
    if (!column) return { ok: true, columns, values: [] };
    const content = contents.find(ct => (ct.column_names ?? []).includes(column));
    const idx = content ? (content.column_names ?? []).indexOf(column) : -1;
    const values = content
      ? [...new Set((content.data_rows ?? []).map(r => {
          const v = r[idx];
          return v === null || v === undefined ? '{Null}' : String(v);
        }))].sort()
      : [];
    return { ok: true, columns, values };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
