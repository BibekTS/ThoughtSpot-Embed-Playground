/**
 * server.js — ThoughtSpot Embed Playground token request service (Trusted Authentication)
 *
 * SECURITY MODEL
 * --------------
 * The ThoughtSpot trusted-auth `secret_key` MUST NEVER reach the browser. It lives only here,
 * in process.env (loaded from .env, which is gitignored). This server is the "token request
 * service": it holds the secret, calls ThoughtSpot's mint endpoint, and returns ONLY the
 * resulting short-lived bearer token to the browser.
 *
 * Two mint endpoints, selected by `tokenType`:
 *   • full   → /auth/token/full   — plain trusted auth (default).
 *   • custom → /auth/token/custom — ABAC via RLS formula variables. Accepts variable_values and a
 *              REQUIRED persist_option (we default to REPLACE; the API default APPEND silently
 *              accumulates entitlements across mints). NONE/RESET are invalid alongside variable_values.
 *
 *   browser ──POST /api/auth/token {username,tokenType}──▶ this server ──token/{full|custom} {secret_key}──▶ ThoughtSpot
 *   browser ◀──────────── { token } ────────────────────  this server ◀────────── { token } ──────────────  ThoughtSpot
 *
 * Fail-closed dev guards (override with env flags only when you understand them):
 *   • Username allowlist — the browser can only mint for known users (TS_USERNAME_ALLOWLIST).
 *   • JIT provisioning (auto_create) is REFUSED unless TS_ALLOW_JIT=true. Otherwise the browser
 *     could provision a brand-new user and side-step the allowlist entirely.
 *   • group_identifiers are refused unless each group is in TS_GROUP_ALLOWLIST (or it is '*').
 *     Otherwise the browser could mint a token into a privileged group (e.g. Administrator).
 *   • /api/filter-values forwards the CALLER'S OWN token — it never mints an admin token on the
 *     caller's behalf, so it cannot be used as an unauthenticated data-exfiltration proxy.
 *   • /api/spotter-mcp/* forwards the CALLER'S OWN bearer to the MCP proxy and never mints, so it
 *     is fail-closed by construction (no token → 401) and Spotter runs as the real end user.
 *   • Static serving is restricted to the frontend assets (never source, .env, docs, or bundles).
 *
 * In production you would REMOVE the body-supplied username entirely and derive it from a
 * server-verified user session (SSO/cookie), minting only for that identity. See README.
 *
 * Endpoints:
 *   GET  /api/auth/config    — non-sensitive bootstrap (never exposes the secret)
 *   POST /api/auth/token     — mint a full OR custom (ABAC) token (allowlist + JIT/group guarded, rate-limited)
 *   POST /api/writeback      — sink for the write-back custom action (stub; TS_ALLOW_DEV_PROXY)
 *   POST /api/webhook        — receiver for ThoughtSpot webhooks (demo; TS_ALLOW_WEBHOOK_SINK, HMAC-verified)
 *   GET/DELETE /api/webhook/events — read/clear the in-memory webhook inbox the UI polls
 *   POST /api/filter-values  — filter-value discovery using the CALLER'S bearer token (no minting)
 *   POST /api/ts-rest        — CORS relay for an allowlisted set of REST paths, using the CALLER'S token
 *   POST /api/spotter-mcp/chat — Spotter 3 MCP chat relay, SSE (uses the CALLER'S token)
 *   GET  /api/spotter-mcp/health — MCP connectivity + tool list (uses the CALLER'S token)
 *   (static) /js /css /vendor /config.js /  — the frontend only
 *   GET  /docs/tse-best-practices.html — the TSE best-practices compendium (single file, not the docs dir)
 */

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { boundaryOf, parseMultipart, splitMultipart } = require('./lib/multipart');

// ── Node version guard (native fetch needs Node 18+) ────────────────────────────────────────
if (typeof fetch === 'undefined') {
  console.error('[fatal] global fetch is unavailable. Use Node >= 18, or `npm i node-fetch` and wire it up.');
  process.exit(1);
}

// ── Environment ─────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const TS_HOST = (process.env.THOUGHTSPOT_HOST || '').replace(/\/+$/, ''); // strip trailing slash
const TS_SECRET_KEY = process.env.TS_SECRET_KEY || '';
const DEFAULT_USERNAME = process.env.TS_DEFAULT_USERNAME || '';
const DEFAULT_ORG_ID = process.env.TS_DEFAULT_ORG_ID || '';
const VALIDITY_DEFAULT = 300;
const VALIDITY_MIN = 30;
const VALIDITY_MAX = 3600;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// Fail-closed dev guards (see SECURITY MODEL above).
const ALLOW_JIT = truthy(process.env.TS_ALLOW_JIT);             // permit auto_create (allowlist bypass)
const ALLOW_DEV_PROXY = truthy(process.env.TS_ALLOW_DEV_PROXY); // permit the /api/writeback stub sink
// Webhook receiver demo (see /api/webhook). Fail-closed: OFF unless explicitly enabled, so it never
// becomes an open, unauthenticated data sink. When a shared secret is set we verify ThoughtSpot's
// HMAC_SHA256 signature (configured via signature_verification in webhooks/create).
const ALLOW_WEBHOOK_SINK = truthy(process.env.TS_ALLOW_WEBHOOK_SINK);
// Spotter MCP chat (the "Spotter Chat (MCP)" rail section). Like /api/filter-values it forwards
// the CALLER'S OWN bearer and never mints, so it is fail-closed by construction: no token → 401.
const SPOTTER_MCP_URL = process.env.TS_MCP_URL || '';
const SPOTTER_MCP_SOURCE = process.env.TS_MCP_DATA_SOURCE_ID || ''; // optional pinned Worksheet/Model
const WEBHOOK_SECRET = process.env.TS_WEBHOOK_SECRET || '';
const WEBHOOK_SIG_HEADER = (process.env.TS_WEBHOOK_SIG_HEADER || 'x-ts-signature').toLowerCase();
// Real scheduled-Liveboard deliveries arrive as multipart/form-data with the rendered report as a
// binary attachment — cap the whole POST so a delivery can't exhaust memory (a Liveboard PDF is a
// few MB; 30mb is generous). Override with TS_WEBHOOK_MAX_MB.
const WEBHOOK_MULTIPART_LIMIT = `${Number(process.env.TS_WEBHOOK_MAX_MB) || 30}mb`;
// '*' opts out of the group guard entirely (back to "any group"); otherwise an explicit set.
const GROUP_ALLOWLIST_RAW = (process.env.TS_GROUP_ALLOWLIST || '').split(',').map((g) => g.trim()).filter(Boolean);
const GROUP_WILDCARD = GROUP_ALLOWLIST_RAW.includes('*');
const GROUP_ALLOWLIST = new Set(GROUP_ALLOWLIST_RAW);

// Allowlist of usernames this server is willing to mint tokens for.
// Fail-closed: if the env var is empty, only the default username is allowed.
const ALLOWLIST = new Set(
  (process.env.TS_USERNAME_ALLOWLIST || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
);
if (ALLOWLIST.size === 0 && DEFAULT_USERNAME) ALLOWLIST.add(DEFAULT_USERNAME);

const secretConfigured = Boolean(TS_SECRET_KEY);

// ── Tiny in-memory fixed-window rate limiter (per IP) ─────────────────────────────────────────
// Not a substitute for a real gateway, but it stops a runaway loop or a local script from
// hammering the mint endpoint. Window + ceiling are deliberately generous for interactive use.
function rateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let rec = hits.get(ip);
    if (!rec || now > rec.resetAt) { rec = { count: 0, resetAt: now + windowMs }; hits.set(ip, rec); }
    rec.count += 1;
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}

// ── Upstream endpoint + request body (single source of truth for mint AND the redacted echo) ───
/** Map a token type to its ThoughtSpot v2 mint endpoint path. */
function tokenEndpointPath(tokenType) {
  return tokenType === 'custom'
    ? '/api/rest/2.0/auth/token/custom' // ABAC via RLS formula variables
    : '/api/rest/2.0/auth/token/full';  // plain trusted auth (default)
}

/** Build the exact body POSTed to the mint endpoint. The ONLY place the secret is added. */
function buildTokenRequestBody(params) {
  const {
    tokenType, username, validitySeconds, orgId, autoCreate, displayName, email, groups,
    userParameters, persistOption, variableValues, objects,
  } = params;
  const body = {
    username,
    secret_key: TS_SECRET_KEY,
    validity_time_in_sec: validitySeconds,
  };

  if (tokenType === 'custom') {
    // ── auth/token/custom — ABAC via RLS formula variables ──
    // org is a STRING identifier here (org_identifier), unlike /full's numeric org_id.
    if (orgId !== undefined && orgId !== null && orgId !== '') body.org_identifier = String(orgId);
    // persist_option is REQUIRED on /custom. We default to REPLACE so a stateless mint is
    // authoritative — the API default is APPEND, which silently ACCUMULATES entitlements across
    // mints (the slow-leak this whole pattern is meant to prevent).
    body.persist_option = persistOption || 'REPLACE';
    // auto_create DEFAULTS TO true on /custom, so set it explicitly — otherwise JIT would slip
    // past the ALLOW_JIT guard simply by omission.
    body.auto_create = !!autoCreate;
    if (displayName) body.display_name = displayName;
    if (email) body.email = email;
    // groups on /custom are objects: [{ identifier }] — NOT the string array /full uses.
    if (Array.isArray(groups) && groups.length) body.groups = groups.map((identifier) => ({ identifier }));
    if (Array.isArray(variableValues) && variableValues.length) {
      body.variable_values = variableValues
        .filter((v) => v && v.name)
        .map((v) => ({ name: v.name, values: Array.isArray(v.values) ? v.values : [] }));
    }
    if (Array.isArray(objects) && objects.length) {
      body.objects = objects.filter(Boolean).map((identifier) => ({ type: 'LOGICAL_TABLE', identifier }));
    }
    return body;
  }

  // ── auth/token/full (default) ──
  const org = orgId !== undefined && orgId !== null && orgId !== '' ? Number(orgId) : undefined;
  if (Number.isFinite(org)) body.org_id = org;
  if (autoCreate) body.auto_create = true;
  if (displayName) body.display_name = displayName;
  if (email) body.email = email;
  if (Array.isArray(groups) && groups.length) body.group_identifiers = groups;
  if (userParameters && typeof userParameters === 'object' && Object.keys(userParameters).length) {
    body.user_parameters = userParameters; // { runtime_filters, runtime_sorts, parameters }
  }
  return body;
}

/** Redacted copy of an upstream body for the browser-side Live Token Inspector. */
function redactBody(body) {
  return { ...body, secret_key: '***redacted***' };
}

/** Mint a token from ThoughtSpot (full or custom). Returns the parsed JSON response. Throws on failure. */
async function mintToken(params) {
  if (!secretConfigured) {
    const err = new Error('TS_SECRET_KEY not configured on server');
    err.statusCode = 503;
    throw err;
  }
  const body = buildTokenRequestBody(params);
  const resp = await fetch(`${TS_HOST}${tokenEndpointPath(params.tokenType)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!resp.ok) {
    const err = new Error(`ThoughtSpot token request failed (${resp.status})`);
    err.statusCode = resp.status;
    err.upstream = json ?? text;
    throw err;
  }
  return json;
}

// ── App ────────────────────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true); // so req.ip reflects X-Forwarded-For when fronted by a proxy
// Capture the raw request bytes so the webhook receiver can verify ThoughtSpot's HMAC_SHA256
// signature — the HMAC is computed over the exact payload bytes, not the re-serialized JSON.
app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// If you prefer to keep the static frontend on VS Code Live Server (different origin), uncomment
// the CORS block below and set `window.TS_API_BASE = 'http://localhost:3000'` in config.js.
// const cors = require('cors');
// app.use(cors({ origin: ['http://localhost:5500', 'http://localhost:5501'] }));

// ── GET /api/auth/config — non-sensitive bootstrap for the UI ────────────────────────────────
app.get('/api/auth/config', (_req, res) => {
  res.json({
    thoughtSpotHost: TS_HOST,
    defaultUsername: DEFAULT_USERNAME,
    allowlist: [...ALLOWLIST],
    orgId: DEFAULT_ORG_ID || null,
    secretConfigured,            // boolean only — the secret itself is never sent
    webhookSink: ALLOW_WEBHOOK_SINK, // is the /api/webhook demo receiver enabled? (UI decides whether to poll)
    allowJit: ALLOW_JIT,
    groupGuard: GROUP_WILDCARD ? 'any' : (GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST] : 'none'),
    validityDefault: VALIDITY_DEFAULT,
    validityMin: VALIDITY_MIN,
    validityMax: VALIDITY_MAX,
  });
});

// ── POST /api/auth/token — mint a full OR custom (ABAC) token (the secure core) ──────────────
app.post('/api/auth/token', rateLimiter({ windowMs: 60_000, max: 60 }), async (req, res) => {
  try {
    const requested = (req.body?.username || '').trim() || DEFAULT_USERNAME;
    const autoCreate = !!req.body?.autoCreate;
    const groups = Array.isArray(req.body?.groups) ? req.body.groups.filter(Boolean) : [];
    const tokenType = req.body?.tokenType === 'custom' ? 'custom' : 'full';

    if (!requested) {
      return res.status(400).json({ error: 'No username provided and TS_DEFAULT_USERNAME is not set.' });
    }

    // ── Custom-token (ABAC) validation — persist_option is required and constrained ──
    let persistOption;
    let variableValues;
    let objects;
    if (tokenType === 'custom') {
      persistOption = String(req.body?.persistOption || 'REPLACE').toUpperCase();
      if (!['REPLACE', 'APPEND', 'NONE', 'RESET'].includes(persistOption)) {
        return res.status(400).json({ error: `Invalid persist_option '${persistOption}'. Use REPLACE, APPEND, NONE, or RESET.` });
      }
      variableValues = Array.isArray(req.body?.variableValues) ? req.body.variableValues : [];
      objects = Array.isArray(req.body?.objects) ? req.body.objects.filter(Boolean) : [];
      // ThoughtSpot rejects NONE/RESET when variable_values are present (docs: getCustomAccessToken).
      const hasVars = variableValues.some((v) => v && v.name);
      if (hasVars && (persistOption === 'NONE' || persistOption === 'RESET')) {
        return res.status(400).json({
          error: `persist_option ${persistOption} cannot be combined with variable_values — ThoughtSpot rejects it. Use REPLACE or APPEND, or remove the variable values.`,
        });
      }
    }

    // JIT guard — auto_create bypasses the username allowlist (it provisions a NEW user), so it is
    // refused unless explicitly enabled. This closes the "allowlist has a JIT-shaped hole" gap.
    if (autoCreate && !ALLOW_JIT) {
      return res.status(403).json({ error: 'JIT provisioning (auto_create) is disabled. Set TS_ALLOW_JIT=true to enable it for this dev playground.' });
    }

    // Group guard — refuse minting into groups the operator has not allowlisted. '*' opts out.
    if (groups.length && !GROUP_WILDCARD) {
      const denied = groups.filter((g) => !GROUP_ALLOWLIST.has(g));
      if (denied.length) {
        return res.status(403).json({
          error: `group_identifiers not permitted: ${denied.join(', ')}. Add them to TS_GROUP_ALLOWLIST (or set it to '*').`,
          allowedGroups: GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST] : [],
        });
      }
    }

    // Allowlist safeguard — prevents browser-driven impersonation of arbitrary EXISTING users.
    if (!autoCreate && ALLOWLIST.size && !ALLOWLIST.has(requested)) {
      return res.status(403).json({
        error: `username '${requested}' is not in TS_USERNAME_ALLOWLIST`,
        allowed: [...ALLOWLIST],
      });
    }

    // Clamp validity so a UI typo can't mint a long-lived token.
    let validitySeconds = Number(req.body?.validitySeconds);
    if (!Number.isFinite(validitySeconds)) validitySeconds = VALIDITY_DEFAULT;
    validitySeconds = Math.min(VALIDITY_MAX, Math.max(VALIDITY_MIN, Math.round(validitySeconds)));

    const orgId = req.body?.orgId ?? (DEFAULT_ORG_ID || undefined);
    const params = {
      tokenType,
      username: requested,
      validitySeconds,
      orgId,
      autoCreate,
      displayName: req.body?.displayName,
      email: req.body?.email,
      groups: groups.length ? groups : undefined,
      userParameters: tokenType === 'full' ? req.body?.userParameters : undefined,
      persistOption,
      variableValues,
      objects,
    };

    let result;
    let warning;
    try {
      result = await mintToken(params);
    } catch (err) {
      // Some clusters have the token-level `user_parameters` (the "JWT Beta") path turned OFF.
      // A `full` mint that carries user_parameters then 400s with "JWT Beta endpoint is disabled".
      // Rather than dead-end the user, retry a PLAIN token so the embed can still authenticate —
      // but say clearly that the entitlements were dropped (this is a testing playground).
      const betaDisabled = err.statusCode === 400 && /JWT Beta endpoint is disabled/i.test(JSON.stringify(err.upstream || ''));
      if (betaDisabled && tokenType === 'full' && params.userParameters) {
        params.userParameters = undefined; // also fixes the echo below to reflect what we sent
        result = await mintToken(params);
        warning = 'This cluster has token-level filters (user_parameters) disabled, so a plain token was minted WITHOUT them. Apply filters via the embed’s Runtime filters panel, or switch Token type to "custom" and use variable_values for real RLS/ABAC.';
      } else {
        throw err;
      }
    }

    // Log only non-sensitive metadata.
    console.log(`[token] minted ${tokenType} for "${requested}" (validity ${validitySeconds}s, len ${result?.token?.length ?? 0})${warning ? ' [user_parameters dropped — beta path off]' : ''}`);

    res.json({
      token: result.token,
      creation_time_in_millis: result.creation_time_in_millis,
      expiration_time_in_millis: result.expiration_time_in_millis,
      valid_for_username: result.valid_for_username,
      valid_for_user_id: result.valid_for_user_id,
      scope: result.scope,
      warning, // present only when we auto-recovered from the beta-disabled 400
      // Echo is derived from the SAME body we actually sent, so the inspector can never drift.
      echo: { endpoint: tokenEndpointPath(tokenType), requestBody: redactBody(buildTokenRequestBody(params)) },
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, upstream: err.upstream });
  }
});

// ── POST /api/writeback — write-back custom-action sink (stub; opt-in) ─────────────────────────
app.post('/api/writeback', (req, res) => {
  if (!ALLOW_DEV_PROXY) {
    return res.status(403).json({ error: 'Write-back sink is disabled. Set TS_ALLOW_DEV_PROXY=true to enable this dev stub.' });
  }
  const ticketId = `TKT-${Date.now()}`;
  const receivedAt = new Date().toISOString();
  console.log(`[writeback] ${ticketId} @ ${receivedAt}:`, JSON.stringify(req.body));
  // ── Real integration would go here (Jira / ServiceNow / DB insert / etc.) ──
  res.json({ ok: true, ticketId, receivedAt, received: req.body });
});

// ── Webhook receiver — opt-in dev sink for the "receive a ThoughtSpot webhook" demo ────────────
// ThoughtSpot POSTs scheduled-report (LIVEBOARD_SCHEDULE) and KPI-monitor alert payloads here.
// Fail-closed like /api/writeback: disabled unless TS_ALLOW_WEBHOOK_SINK=true, so it never becomes
// an open, unauthenticated data sink by default. When TS_WEBHOOK_SECRET is set we verify the
// HMAC_SHA256 signature ThoughtSpot sends (configured via signature_verification in webhooks/create).
// Received events live in a small in-memory ring buffer for the UI to poll — nothing hits disk. The
// server is localhost-only; front it with real auth before exposing the tunnel anywhere lasting.
const WEBHOOK_BUFFER_MAX = 50;
const webhookEvents = []; // newest first, capped at WEBHOOK_BUFFER_MAX
// Attachment bytes live out-of-band so /api/webhook/events stays a small JSON response. Keyed by
// `${recId}/${fileId}`; entries are dropped when their event falls out of the ring buffer.
const webhookFiles = new Map(); // key -> { filename, contentType, buffer }

/** Verify ThoughtSpot's HMAC_SHA256 signature over the raw body bytes. Tolerant of hex/base64 + `sha256=` prefix. */
function verifyWebhookSignature(req, raw) {
  if (!WEBHOOK_SECRET) return { verified: false, reason: 'no shared secret configured (TS_WEBHOOK_SECRET unset)' };
  const sent = String(req.get(WEBHOOK_SIG_HEADER) || '').trim().replace(/^sha256=/i, '');
  if (!sent) return { verified: false, reason: `no signature header (${WEBHOOK_SIG_HEADER})` };
  const bytes = raw || Buffer.from(JSON.stringify(req.body || {}));
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bytes).digest();
  // ThoughtSpot's encoding (hex vs base64) can vary by config — accept either, compared in constant time.
  const ok = [digest.toString('hex'), digest.toString('base64')].some((c) => {
    try { return c.length === sent.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sent)); }
    catch { return false; }
  });
  return { verified: ok, reason: ok ? 'HMAC_SHA256 verified' : 'signature mismatch' };
}

// Fail-closed gate — refuse before buffering any (potentially large multipart) body.
function requireWebhookSink(_req, res, next) {
  if (!ALLOW_WEBHOOK_SINK) {
    return res.status(403).json({ error: 'Webhook sink is disabled. Set TS_ALLOW_WEBHOOK_SINK=true to enable this demo receiver.' });
  }
  next();
}
// Only multipart deliveries are buffered as raw bytes here; JSON deliveries were already parsed by
// the global express.json (this middleware is a no-op for them, so req.rawBody still applies).
const captureMultipart = express.raw({ type: 'multipart/form-data', limit: WEBHOOK_MULTIPART_LIMIT });

app.post('/api/webhook', requireWebhookSink, captureMultipart, (req, res) => {
  const ctype = String(req.get('content-type') || '');
  const isMultipart = /multipart\/form-data/i.test(ctype) && Buffer.isBuffer(req.body);

  const recId = `whk-${Date.now()}-${webhookEvents.length}`;
  let payload = {};
  let files = [];         // UI-facing metadata (no bytes)
  let rawBytes;

  if (isMultipart) {
    rawBytes = req.body; // express.raw gives us the exact bytes ThoughtSpot signed
    const parts = parseMultipart(req.body, boundaryOf(ctype));
    const split = splitMultipart(parts);
    payload = split.meta || {};
    files = split.files.map((f, i) => {
      const fileId = String(i);
      webhookFiles.set(`${recId}/${fileId}`, {
        filename: f.filename || `attachment-${i}`,
        contentType: f.contentType || 'application/octet-stream',
        buffer: f.data,
      });
      return {
        fileId,
        field: f.name || null,
        filename: f.filename || `attachment-${i}`,
        contentType: f.contentType || 'application/octet-stream',
        size: f.data.length,
        href: `/api/webhook/file/${encodeURIComponent(recId)}/${fileId}`,
      };
    });
  } else {
    rawBytes = req.rawBody;
    payload = req.body || {};
  }

  const sig = verifyWebhookSignature(req, rawBytes);
  // ThoughtSpot nests the meaningful payload under `data`; surface a couple of fields for the UI.
  const data = payload.data || payload;
  const rec = {
    id: recId,
    receivedAt: new Date().toISOString(),
    verified: sig.verified,
    verifyReason: sig.reason,
    notificationType: data.notificationType || payload.event || payload.eventType || null,
    delivery: isMultipart ? 'multipart' : 'json',
    files,
    payload,
  };
  webhookEvents.unshift(rec);
  // Evict overflow and free the attachment bytes of dropped events.
  if (webhookEvents.length > WEBHOOK_BUFFER_MAX) {
    webhookEvents.splice(WEBHOOK_BUFFER_MAX).forEach((old) => {
      (old.files || []).forEach((f) => webhookFiles.delete(`${old.id}/${f.fileId}`));
    });
  }
  console.log(`[webhook] received ${rec.notificationType || '(event)'} (${rec.delivery}, ${files.length} file(s)) @ ${rec.receivedAt} — ${sig.reason}`);
  res.json({ ok: true, verified: sig.verified, files: files.length });
});

// Read-back for the UI's Webhook Inbox (localhost-only; returns empty when the sink is disabled).
app.get('/api/webhook/events', (_req, res) => {
  res.json({
    enabled: ALLOW_WEBHOOK_SINK,
    secretConfigured: Boolean(WEBHOOK_SECRET),
    events: ALLOW_WEBHOOK_SINK ? webhookEvents : [],
  });
});

// Download a delivered report attachment — this is "what that recipient actually got".
app.get('/api/webhook/file/:recId/:fileId', (req, res) => {
  if (!ALLOW_WEBHOOK_SINK) return res.status(403).json({ error: 'Webhook sink is disabled.' });
  const entry = webhookFiles.get(`${req.params.recId}/${req.params.fileId}`);
  if (!entry) return res.status(404).json({ error: 'No such attachment (it may have aged out of the buffer).' });
  res.setHeader('Content-Type', entry.contentType);
  // Quote the filename and strip control/quote chars so the header can't be broken by a crafted name.
  const safeName = String(entry.filename).replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.send(entry.buffer);
});

// Clear the in-memory buffer (the UI's "Clear" button on the Webhooks tab).
app.delete('/api/webhook/events', (_req, res) => {
  if (!ALLOW_WEBHOOK_SINK) return res.status(403).json({ error: 'Webhook sink is disabled.' });
  webhookEvents.length = 0;
  webhookFiles.clear();
  res.json({ ok: true });
});

// ── POST /api/filter-values — filter-value discovery using the CALLER'S OWN token ──────────────
// Cookieless trusted-auth blocks the browser from calling TS REST cross-origin (CORS), so this
// endpoint relays the call. It uses the bearer token the CALLER already holds — it does NOT mint
// a token, so it only ever exposes data the caller could already reach. No caller token → 401.
app.post('/api/filter-values', rateLimiter({ windowMs: 60_000, max: 120 }), async (req, res) => {
  try {
    const liveboardId = (req.body?.liveboardId || '').trim();
    const column = (req.body?.column || '').trim();
    if (!liveboardId) return res.status(400).json({ error: 'liveboardId is required' });

    const auth = req.get('authorization') || '';
    const headerToken = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    const token = (headerToken || req.body?.token || '').trim();
    if (!token) {
      return res.status(401).json({ error: 'A caller bearer token is required (Authorization: Bearer <token>). This proxy never mints one for you.' });
    }

    const resp = await fetch(`${TS_HOST}/api/rest/2.0/metadata/liveboard/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ metadata_identifier: liveboardId, record_size: 10000, record_offset: 0 }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!resp.ok) return res.status(resp.status).json({ error: 'liveboard/data failed', upstream: data ?? text });

    const contents = data?.contents ?? [];
    if (!column) return res.json({ contents }); // raw passthrough when no column requested

    const content = contents.find((c) => (c.column_names ?? []).includes(column));
    if (!content) return res.json({ column, values: [] });
    const cols = content.column_names ?? [];
    const rows = content.data_rows ?? [];
    const idx = cols.indexOf(column);
    const values = [...new Set(rows.map((r) => {
      const v = r[idx];
      return v === null || v === undefined ? '{Null}' : String(v);
    }))].sort();
    res.json({ column, values });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, upstream: err.upstream });
  }
});

// ── POST /api/ts-rest — CORS relay for an allowlisted set of REST paths, using the CALLER'S token ──
// Cookieless trusted auth blocks the browser from calling ThoughtSpot REST cross-origin (CORS). The
// Personal-liveboards feature needs a few write/search endpoints, so this relay forwards them using
// the bearer token the CALLER already holds. Same security model as /api/filter-values: it NEVER mints
// a token, only forwards allowlisted paths, and is rate-limited + localhost-only. No caller token → 401.
const REST_RELAY_ALLOW = new Set([
  '/api/rest/2.0/metadata/copyobject',
  '/api/rest/2.0/metadata/search',
  '/api/rest/2.0/metadata/delete',
  '/api/rest/2.0/tags/create',
  '/api/rest/2.0/tags/assign',
  '/api/rest/2.0/auth/session/user',
  '/api/rest/2.0/auth/session/token', // introspect the CALLER'S own session token (never mints one)
  '/api/rest/2.0/schedules/create', // webhook composer → create a real Liveboard schedule (caller's token)
  '/api/rest/2.0/searchdata', // drill-through detail rows — READ-ONLY, and the caller's own token means RLS still applies
]);
app.post('/api/ts-rest', rateLimiter({ windowMs: 60_000, max: 120 }), async (req, res) => {
  try {
    const relayPath = String(req.body?.path || '');
    const method = String(req.body?.method || 'POST').toUpperCase();
    if (!REST_RELAY_ALLOW.has(relayPath)) {
      return res.status(400).json({ error: `path not allowlisted for relay: ${relayPath || '(none)'}` });
    }

    const auth = req.get('authorization') || '';
    const token = (/^Bearer\s+(.+)$/i.exec(auth)?.[1] || '').trim();
    if (!token) {
      return res.status(401).json({ error: 'A caller bearer token is required (Authorization: Bearer <token>). This proxy never mints one for you.' });
    }

    const upstream = await fetch(`${TS_HOST}${relayPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(req.body?.body ?? {}) } : {}),
    });
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, upstream: err.upstream });
  }
});

// ── /api/spotter-mcp/* — Spotter 3 MCP chat relay ─────────────────────────────────────────────
// Browser question + the CALLER'S OWN bearer ──▶ this server ──MCP (Streamable HTTP)──▶
// agent.thoughtspot.app ──▶ SSE stream back. It never mints (no token → 401, like
// /api/filter-values), so Spotter runs as the real end user and their RLS applies. The
// label-customization layer rewrites vendor terms in the prose; URLs and iframe_url are never
// touched. Implementation: lib/spotter-mcp/ (ESM — the MCP SDK is ESM-only, so the router is
// loaded with a dynamic import on first request rather than require()d).
{
  let routerPromise = null;
  const loadRouter = () =>
    (routerPromise ??= import('./lib/spotter-mcp/router.mjs')
      .then(({ createSpotterMcpRouter }) =>
        createSpotterMcpRouter({
          defaultHost: TS_HOST, // only a fallback: the caller sends the host they connected to
          ...(SPOTTER_MCP_URL ? { mcpUrl: SPOTTER_MCP_URL } : {}),
          defaultDataSourceId: SPOTTER_MCP_SOURCE,
          log: console.warn,
        }))
      .catch((err) => { routerPromise = null; throw err; }));

  app.use('/api/spotter-mcp', rateLimiter({ windowMs: 60_000, max: 120 }), (req, res, next) => {
    loadRouter().then((router) => router(req, res, next)).catch((err) => {
      console.error('[spotter-mcp] router load failed', err);
      res.status(500).json({ error: `Spotter MCP router failed to load: ${err.message}` });
    });
  });
}

// ── Static frontend — explicit allowlist of asset paths (never source, .env, docs, bundles) ────
const staticOpts = { dotfiles: 'ignore', index: false };
app.use('/js', express.static(path.join(__dirname, 'js'), staticOpts));
app.use('/css', express.static(path.join(__dirname, 'css'), staticOpts));
app.use('/vendor', express.static(path.join(__dirname, 'vendor'), staticOpts)); // self-hosted SDK (see scripts/vendor-sdk.mjs)
app.get('/config.js', (_req, res) => res.sendFile(path.join(__dirname, 'config.js')));
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// The shareable best-practices compendium — served as ONE explicit file, keeping the rest of
// docs/ (internal notes) off the wire.
app.get('/docs/tse-best-practices.html', (_req, res) =>
  res.sendFile(path.join(__dirname, 'docs', 'tse-best-practices.html')));

// Bind to localhost only. Even with the guards above, keep the dev server off the LAN; front it
// with a reverse proxy (and real auth) before exposing it anywhere.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ➜  Embed Playground ready:  http://localhost:${PORT}\n`);
  console.log(`     Open it, paste your ThoughtSpot URL, click Connect (browser-session auth).`);
  if (!secretConfigured) {
    console.log(`     Trusted Auth is OFF — that's fine for browser-session use.`);
    console.log(`     To enable it: run \`npm run setup\`, fill in .env, then restart.\n`);
  }
  console.log(`  ── config ─────────────────────────────────────────────`);
  console.log(`     ThoughtSpot host : ${TS_HOST || '(not set — only needed for Trusted Auth)'}`);
  console.log(`     Trusted-auth key : ${secretConfigured ? 'configured ✓' : 'not set (Trusted Auth disabled)'}`);
  console.log(`     Default username : ${DEFAULT_USERNAME || '(none)'}`);
  console.log(`     Allowlist        : ${[...ALLOWLIST].join(', ') || '(empty)'}`);
  console.log(`     JIT (auto_create): ${ALLOW_JIT ? 'ENABLED (TS_ALLOW_JIT)' : 'disabled (fail-closed)'}`);
  console.log(`     Group guard      : ${GROUP_WILDCARD ? 'ANY (TS_GROUP_ALLOWLIST=*)' : (GROUP_ALLOWLIST.size ? [...GROUP_ALLOWLIST].join(', ') : 'none allowed')}`);
  console.log(`     Write-back stub  : ${ALLOW_DEV_PROXY ? 'enabled' : 'disabled'}`);
  console.log(`     Webhook sink     : ${ALLOW_WEBHOOK_SINK ? `enabled${WEBHOOK_SECRET ? ' (HMAC_SHA256 verify on)' : ' (no secret — unverified)'}` : 'disabled (fail-closed)'}`);
  console.log(`     Spotter MCP chat : relays your own token (never mints)\n`);
});

module.exports = app; // exported for the smoke test
