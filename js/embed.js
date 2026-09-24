/**
 * embed.js — ThoughtSpot Visual Embed SDK wrapper
 *
 * Exported functions:
 *   initSDK(config)                                — initialises the SDK with AuthType.None
 *   doRender(section, config, callbacks, options)  — creates and renders the embed component
 */

import {
  init,
  AuthType,
  AuthStatus,
  SearchEmbed,
  SpotterEmbed,
  LiveboardEmbed,
  AppEmbed,
  EmbedEvent,
  Page,
  HostEvent,
  Action,
  RuntimeFilterOp,
  CustomActionsPosition,
  CustomActionTarget,
  startAutoMCPFrameRenderer,
// TS-SDK-VERSION: 1.49.0 — must equal ts-sdk-version.json (smoke-test asserts it; ts-watch bumps
// marker + URL + JSON together). If you switch to the self-hosted /vendor/ URL, KEEP this marker:
// it is what the pin checks read once the version is gone from the import path.
} from 'https://unpkg.com/@thoughtspot/visual-embed-sdk@1.49.0/dist/tsembed.es.js';

// Base URL for our own backend (token service, write-back, filter proxy).
// Empty string → same-origin (when the page is served by server.js). Set window.TS_API_BASE
// in config.js to an absolute URL (e.g. 'http://localhost:3000') if you keep the frontend on
// a separate origin like VS Code Live Server.
const API_BASE = (typeof window !== 'undefined' && window.TS_API_BASE) || '';

/**
 * Re-exported so the Spotter MCP chat can turn the MCP server's `tsmcp=true` marker
 * iframes into real, SDK-authenticated embeds. It is a DOM observer, not an embed
 * component, so it belongs here (next to init) rather than in doRender.
 */
export { startAutoMCPFrameRenderer };

/**
 * getAuthToken callback for trusted auth. Calls our backend token service, which holds the
 * secret and mints a short-lived bearer token. Resolves to the token STRING (required by the SDK).
 * Fires window.__onAuthToken({requestBody, response}) so the Live Token Inspector can show every
 * call — including silent autoLogin refreshes.
 */
async function fetchTrustedAuthToken(config) {
  const ta = config.trustedAuth || {};
  // Pass through the full (non-secret) claim surface so the token-claims playground
  // can mint tokens with groups, JIT provisioning, and ABAC/RLS user_parameters.
  // The server injects the secret_key; nothing sensitive is sent from the browser.
  const requestBody = {
    tokenType: ta.tokenType || undefined,
    username: ta.username || undefined,
    validitySeconds: ta.validitySeconds,
    orgId: ta.orgId ?? undefined,
    autoCreate: ta.autoCreate || undefined,
    displayName: ta.displayName || undefined,
    email: ta.email || undefined,
    groups: ta.groups && ta.groups.length ? ta.groups : undefined,
    // full path (deprecated 10.4.0.cl+)
    userParameters: ta.userParameters || undefined,
    // custom path — ABAC via RLS formula variables
    persistOption: ta.persistOption || undefined,
    variableValues: ta.variableValues && ta.variableValues.length ? ta.variableValues : undefined,
    objects: ta.objects && ta.objects.length ? ta.objects : undefined,
  };
  try {
    const resp = await fetch(`${API_BASE}${ta.tokenEndpoint || '/api/auth/token'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(requestBody),
    });
    try { window.__onApiCall?.({ scope: 'playground', method: 'POST', path: ta.tokenEndpoint || '/api/auth/token', status: resp.status }); } catch (_) {}
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.token) {
      const msg = data?.error || `Token request failed (${resp.status})`;
      if (window.__onAuthToken) window.__onAuthToken({ requestBody, error: msg, response: data });
      throw new Error(msg);
    }
    if (window.__onAuthToken) window.__onAuthToken({ requestBody, response: data });
    return data.token;
  } catch (err) {
    if (window.__onAuthToken) window.__onAuthToken({ requestBody, error: err.message });
    throw err;
  }
}

/**
 * Initialise the ThoughtSpot SDK.
 *
 * For trusted-auth modes we supply getAuthToken + autoLogin; for 'None' the call is identical
 * to the original cookie-session behaviour. initSDK is safe to call repeatedly — each call
 * rebinds a fresh getAuthToken closure to the current config.trustedAuth values.
 *
 * @param {{ thoughtSpotHost: string, authType: string, trustedAuth?: object }} config  TS_CONFIG object
 */
export function initSDK(config) {
  // No host yet (fresh boot, or auth type picked before connecting) — init() throws on an
  // empty/invalid URL, which would abort the caller. Nothing can embed without a host anyway;
  // applyConfig() re-runs with the real host on Connect.
  if (!config.thoughtSpotHost) return;
  const base = {
    thoughtSpotHost: config.thoughtSpotHost,
    ...((config._customStyles || config._customContent) && {
      customizations: {
        ...(config._customStyles && { style: config._customStyles }),
        ...(config._customContent && { content: config._customContent }), // Beta: UI-text relabels
      }
    }),
  };

  let authEE;
  if (config.authType === 'TrustedAuthTokenCookieless' || config.authType === 'TrustedAuthToken') {
    authEE = init({
      ...base,
      authType: AuthType[config.authType],
      autoLogin: config.trustedAuth?.autoLogin ?? true,
      getAuthToken: () => fetchTrustedAuthToken(config),
    });
  } else {
    authEE = init({ ...base, authType: AuthType[config.authType] ?? AuthType.None });
  }
  bindAuthStatus(authEE);
}

// init() returns the SDK's auth event emitter. AuthStatus.FAILURE fires when a session can't be
// established — the real signal for "token minted but ThoughtSpot won't log the iframe in" (which
// EmbedEvent.AuthFailure does NOT cover). Bind listeners once: initSDK re-runs on every config
// change, and the emitter is effectively a singleton, so re-.on()-ing would stack duplicate handlers.
let _boundAuthEE = null;
function bindAuthStatus(authEE) {
  if (!authEE || typeof authEE.on !== 'function' || authEE === _boundAuthEE) return;
  _boundAuthEE = authEE;
  authEE.on(AuthStatus.FAILURE, (reason) => {
    const type = typeof reason === 'string' ? reason : (reason?.type || reason?.failureType || '');
    if (window.__onAuthStatus) window.__onAuthStatus('FAILURE', type);
  });
  const onOk = () => { if (window.__onAuthStatus) window.__onAuthStatus('SUCCESS'); };
  authEE.on(AuthStatus.SDK_SUCCESS, onOk);
  authEE.on(AuthStatus.SUCCESS, onOk);
}

/**
 * Create and render a ThoughtSpot embed component into #ts-embed-container.
 *
 * @param {string} section   One of: 'search' | 'spotter' | 'liveboard' | 'viz' | 'fullapp'
 * @param {object} config    The TS_CONFIG object
 * @param {{
 *   onDone:  () => void,
 *   onError: (msg: string) => void,
 *   onEvent: (type: string, data: any) => void,
 * }} callbacks
 * @param {{
 *   hiddenActions?: string[],
 *   disabledActions?: string[],
 *   disabledActionReason?: string,
 *   customActions?: object[],
 * }} options
 * @returns {object}  The embed instance (so the caller can call .destroy() later)
 */
/** Pull the AuthFailureType (SDK | NO_COOKIE_ACCESS | EXPIRY | IDLE_SESSION_TIMEOUT | OTHER)
 * out of an EmbedEvent.AuthFailure payload, tolerating the SDK's shape variation. '' if absent. */
function _authFailureType(e) {
  const d = e?.data ?? e;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') return d.type || d.failureType || d.reason || '';
  return '';
}

/** Extract a concise, readable message from a ThoughtSpot SDK EmbedEvent.Error payload. */
function _extractErrorMessage(e) {
  // The SDK ships the error under different shapes across versions: the payload itself,
  // e.data (postMessage events surface as { type, data }), or e.error. Unwrap to the node
  // that actually holds the GraphQL detail before reading from it.
  const node = e?.data ?? e?.error ?? e ?? {};
  // GraphQL API errors ship as an array in .error or .message
  const graphqlErrors = (Array.isArray(node.error) && node.error) || (Array.isArray(node.message) && node.message) || null;
  if (graphqlErrors && graphqlErrors.length) {
    const first = graphqlErrors[0];
    const text = first?.message ?? (typeof first === 'string' ? first : JSON.stringify(first));
    const path = first?.path?.[0];
    const code = node.code ?? first?.extensions?.code;
    let out = text;
    if (path) out += ` (${path})`;
    if (code && code !== 'GRAPHQL_API_ERRORS') out = `[${code}] ${out}`;
    if (graphqlErrors.length > 1) out += ` (+${graphqlErrors.length - 1} more)`;
    // Known actionable patterns — match against the full payload so we catch nested detail.
    const raw = `${text} ${path ?? ''} ${JSON.stringify(node)}`;
    if (/does not have access|not authorized|unauthorized|insufficient privileges/i.test(raw) || code === '13058') {
      const guid = raw.match(/(?:id|guid)["':\s]+([0-9a-f-]{36})/i)?.[1] ?? '';
      return `You don't have access to this object${guid ? ' (' + guid + ')' : ''}. Ask a ThoughtSpot admin to share the Liveboard with your user or group, then reconnect. If you switched orgs, re-pick the object — GUIDs are org-specific.`;
    }
    if (/Invalid data source guid|invalid data source/i.test(raw)) {
      const guid = raw.match(/guid["':\s]+([0-9a-f-]{36})/i)?.[1] ?? '';
      return `Invalid data source GUID${guid ? ' (' + guid + ')' : ''}. GUIDs are org-specific — if you switched orgs open Settings and update the IDs.`;
    }
    if (/setMultipleParameterOverride|Invalid ContextRequest/i.test(raw)) {
      return 'Runtime parameter rejected — the parameter name does not exist on this Liveboard, or is empty. Check the Runtime parameters section.';
    }
    return out;
  }
  // No GraphQL array — fall back to any plain-string message we can find.
  const msg = [node.message, node.errorMessage, e?.message].find(m => typeof m === 'string' && m.trim());
  return msg ?? JSON.stringify(e);
}

export function doRender(section, config, callbacks, options = {}) {
  const { onDone, onError, onEvent } = callbacks;
  const { hiddenActions = [], disabledActions = [], disabledActionReason = '', customActions = [], runtimeParameters = [], flags: flagsIn = {}, spotterQuery } = options;
  // exposeTranslationIDs is a per-embed ViewConfig flag (LiveboardViewConfig/SearchBarViewConfig, SDK 1.37.0+),
  // NOT a customizations.content key — putting it in init() is silently ignored. Merge it into the flags
  // that every embed constructor spreads, so it applies across all embed types.
  // disabledActionReason is likewise a base ViewConfig option (the hover tooltip for every disabled action),
  // so fold it in here too — a fresh object each time, never mutating the caller's state.flags reference.
  const flags = {
    ...(config._exposeTranslationIDs ? { ...flagsIn, exposeTranslationIDs: true } : flagsIn),
    ...(disabledActionReason ? { disabledActionReason } : {}),
  };
  // Drop any parameter rows with an empty name — a blank entry causes ThoughtSpot's
  // Pinboard__setMultipleParameterOverride to return "Invalid ContextRequest".
  const validParams = runtimeParameters.filter(p => p.name && String(p.name).trim() !== '');
  const rtParams = validParams.length ? validParams : undefined;

  // fullHeight grows the embed to its full content height (no internal scrollbar — the host
  // scrolls). Pair it with lazyLoadFullHeight so tiles load as they scroll into view (not all at
  // once) and a minimumHeight floor so short/empty boards still fill the stage. Only applied to
  // LiveboardEmbed / AppEmbed, the two embed types that support fullHeight.
  const fhExtra = flags.fullHeight
    ? { lazyLoadFullHeight: true, minimumHeight: flags.minimumHeight || 600 }
    : {};

  let embed;
  let aiHighlightsFired = false; // 'ai-highlights' nav option fires HostEvent.AIHighlights once per render

  switch (section) {
    case 'search':
      embed = new SearchEmbed('#ts-embed-container', {
        frameParams: {},
        collapseDataSources: true,
        dataSources: [config.worksheetId],
        hiddenActions,
        disabledActions,
        ...(config.searchTokenString && {
          searchOptions: {
            searchTokenString: config.searchTokenString,
            executeSearch: config.executeSearch,
          },
        }),
        ...(rtParams && { runtimeParameters: rtParams }),
        ...flags,
      });
      break;

    case 'spotter':
      embed = new SpotterEmbed('#ts-embed-container', {
        frameParams: {},
        worksheetId: config.worksheetId,
        hiddenActions,
        disabledActions,
        ...(rtParams && { runtimeParameters: rtParams }),
        ...flags,
      });
      break;

    case 'liveboard':
    case 'liveboard-custom':
    case 'ai-highlights':
    case 'drillthrough':
      embed = new LiveboardEmbed('#ts-embed-container', {
        frameParams: {},
        liveboardV2: true,
        isLiveboardMasterpiecesEnabled: true,
        liveboardId: config.liveboardId,
        hiddenActions,
        disabledActions,
        customActions,
        ...(rtParams && { runtimeParameters: rtParams }),
        ...fhExtra,
        ...flags,
      });
      break;

    case 'viz':
      if (config.answerId) {
        // A standalone saved Answer cannot be embedded via LiveboardEmbed (per the Visual
        // Embed SDK: "You cannot embed a saved answer as an individual visualization"). It
        // loads in a SearchEmbed via the answerId prop; hideSearchBar keeps it presentation-
        // only so it reads like a single viz rather than a live search session.
        embed = new SearchEmbed('#ts-embed-container', {
          frameParams: {},
          answerId: config.answerId,
          hideSearchBar: true,
          hiddenActions,
          disabledActions,
          customActions,
          ...(rtParams && { runtimeParameters: rtParams }),
          ...flags,
        });
      } else {
        embed = new LiveboardEmbed('#ts-embed-container', {
          frameParams: {},
          liveboardV2: true,
          isLiveboardMasterpiecesEnabled: true,
          liveboardId: config.liveboardId,
          vizId: config.vizId,
          hiddenActions,
          disabledActions,
          customActions,
          ...(rtParams && { runtimeParameters: rtParams }),
          ...fhExtra,
          ...flags,
        });
      }
      break;

    case 'fullapp': {
      const appFlags = { ...flags };
      if (appFlags.pageId && typeof appFlags.pageId === 'string') {
        appFlags.pageId = Page[appFlags.pageId] ?? Page.Home;
      }
      embed = new AppEmbed('#ts-embed-container', {
        frameParams: {},
        showPrimaryNavbar: false,
        pageId: Page.Home,
        modularHomeExperience: true,
        hiddenActions,
        disabledActions,
        customActions,
        ...(rtParams && { runtimeParameters: rtParams }),
        ...(appFlags.fullHeight ? { lazyLoadFullHeight: true, minimumHeight: appFlags.minimumHeight || 600 } : {}),
        ...appFlags,
      });
      break;
    }

    default:
      onError(`Unknown section: ${section}`);
      return null;
  }

  embed
    .on(EmbedEvent.AuthInit, () => {
      onEvent('AuthInit', 'Auth initialized');
    })
    .on(EmbedEvent.EmbedListenerReady, () => {
      onDone();
      onEvent('EmbedListenerReady', 'Embed container ready');
    })
    .on(EmbedEvent.Load, () => {
      onDone();
      onEvent('Load', 'Embed loaded successfully');
      // Bridge from AI Insights: once Spotter loads, run the natural-language question.
      // We send the NL query (not the resolved search tokens, which aren't a valid
      // searchTokenString) — Spotter is the engine that turns NL into a real answer.
      if (section === 'spotter' && spotterQuery) {
        setTimeout(() => {
          try {
            embed.trigger(HostEvent.SpotterSearch, { query: spotterQuery, executeSearch: true });
            onEvent('HostEvent', `SpotterSearch: "${spotterQuery}"`);
          } catch (e) {
            onEvent('HostEvent', `✗ SpotterSearch: ${e.message}`);
          }
        }, 700);
      }
    })
    .on(EmbedEvent.LiveboardRendered, () => {
      onDone();
      onEvent('LiveboardRendered', 'Liveboard rendered');
      // AI Highlights nav option: once the board has painted, open the AI Highlights panel.
      // Fire once per embed instance — LiveboardRendered also re-fires on tab / filter changes.
      if (section === 'ai-highlights' && !aiHighlightsFired) {
        aiHighlightsFired = true;
        try {
          embed.trigger(HostEvent.AIHighlights);
          onEvent('HostEvent', 'AIHighlights triggered');
        } catch (e) {
          onEvent('HostEvent', `✗ AIHighlights: ${e.message}`);
        }
      }
    })
    .on(EmbedEvent.NoCookieAccess, () => {
      onDone();
      onError('__NO_COOKIE__');
      onEvent('NoCookieAccess', '⚠ Third-party cookies blocked — enable cookies or use a different auth type');
    })
    .on(EmbedEvent.AuthExpire, () => {
      // The token lapsed; the SDK now calls getAuthToken to refresh it. Informational only —
      // a refresh that actually fails surfaces separately as AuthFailure below.
      onEvent('AuthExpire', 'Auth token expired — refreshing via getAuthToken');
    })
    .on(EmbedEvent.AuthFailure, (e) => {
      // Terminal: the embed could not establish/keep a ThoughtSpot session (rejected or expired
      // token, blocked cookies, idle timeout). TS renders its OWN "Not logged in" page inside the
      // iframe — surface the app's styled overlay instead of leaving that bare page showing.
      onDone();
      onError('__AUTH_FAILURE__');
      const type = _authFailureType(e);
      onEvent('AuthFailure', `⚠ Auth failed${type ? ` (${type})` : ''} — the embed has no ThoughtSpot session`);
    })
    .on(EmbedEvent.Error, (e) => {
      let msg = _extractErrorMessage(e);
      onError(msg);
      onEvent('Error', msg);
    })
    .on(EmbedEvent.Data, () => {
      onEvent('Data', 'Data payload received');
    })
    .on(EmbedEvent.FilterChanged, (payload) => {
      onEvent('FilterChanged', JSON.stringify(payload?.data ?? payload, null, 2));
      // Notify app.js so the website's custom filter dropdowns can reconcile with in-TS changes.
      if (window.__onFilterChanged) window.__onFilterChanged(payload);
    })
    .on(EmbedEvent.CustomAction, (payload) => {
      onEvent('CustomAction', JSON.stringify(payload?.data ?? payload, null, 2));
      // Notify app.js to display in the custom action panel
      if (window.__onCustomAction) window.__onCustomAction(payload);
    })
    .on(EmbedEvent.VizPointClick, (payload) => {
      // A click on a data point in any viz. Carries clickedPoint.selectedAttributes[] and
      // .selectedMeasures[] ({ value, column: { name } }) — the raw payload is forwarded so
      // app.js can read those directly and turn a click into a drill-through.
      if (window.__onVizPointClick) window.__onVizPointClick(payload);
    })
    .on(EmbedEvent.Save, (payload) => {
      // Fires when a user clicks Save inside the embed. ThoughtSpot has NO server-side
      // "object saved" webhook — this client-side event is the near-real-time equivalent a
      // host app uses to react to saves (e.g. sync the new GUID/TML into its own store).
      onEvent('Save', JSON.stringify(payload?.data ?? payload, null, 2));
      if (window.__onSave) window.__onSave(payload);
    });

  embed.render();
  return embed;
}

export { HostEvent, Action, RuntimeFilterOp, CustomActionsPosition, CustomActionTarget };
