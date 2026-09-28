/**
 * spotter-mcp.js — the "Spotter Chat (MCP)" panel.
 *
 * A custom DOM chat surface: questions POST to /api/spotter-mcp/chat, the server
 * relays them to ThoughtSpot's Spotter 3 MCP server and streams back SSE events
 * (session | text | answer | done | error).
 *
 * ANSWERS: an answer's `iframe_url` is NOT a ready-to-use embed URL — it carries the
 * MCP server's `tsmcp=true` marker. We drop a plain iframe with that src into the DOM
 * and the SDK's startAutoMCPFrameRenderer() (a MutationObserver on document.body)
 * replaces it in place with a fully configured embed iframe: the init()-ed host, auth
 * type, and customizations merged over the marker URL's own params. Rendering the raw
 * URL ourselves would produce an unauthenticated frame with no embed chrome.
 *
 * LIVEBOARDS: the analysis session cannot build one — that is a SEPARATE MCP tool
 * (create_dashboard). The panel collects the answers seen this session and POSTs the
 * checked ones to /api/spotter-mcp/dashboard, so "create a liveboard" works even
 * though the in-session agent (correctly) says it can't.
 *
 * STREAM SHAPE: the MCP server interleaves two lanes of prose — reasoning
 * (is_thinking) and the answer itself — and chunks them mid-sentence. Each lane
 * therefore keeps ONE live node per turn that later chunks append to, or a sentence
 * split across a lane switch would land in two different bubbles.
 *
 * Auth: the relay never mints — it forwards OUR bearer, so every turn resolves one
 * first (getToken). Resolving per turn rather than once means a lapsed token fixes
 * itself on the next question instead of dead-ending the conversation.
 *
 * All streamed text — it is ThoughtSpot/agent-authored, i.e. untrusted — is written
 * with textContent. The markdown renderer below builds ELEMENTS and sets textContent
 * on each; it never assembles an HTML string. Never innerHTML.
 */

import { startAutoMCPFrameRenderer } from './embed.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ── Minimal markdown → DOM ───────────────────────────────────────────────────
// The agent writes markdown ("## Sales Last Year", "**183.1M**"), which read as
// literal punctuation in a textContent-only bubble. This covers what Spotter
// actually emits — headings, emphasis, code, lists, rules — and nothing else:
// no raw HTML, no link hrefs, so there is no injection surface to get wrong.

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

/** Append `text` to `parent`, turning **bold** / *italic* / `code` into elements. */
function renderInline(parent, text) {
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      parent.appendChild(el('strong', null, part.slice(2, -2)));
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      parent.appendChild(el('code', null, part.slice(1, -1)));
    } else if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      parent.appendChild(el('em', null, part.slice(1, -1)));
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

/**
 * Re-render `raw` markdown into `host`, replacing its contents.
 *
 * Called on every streamed chunk with the whole accumulated text rather than
 * appending: a chunk can land mid-token (`**18` … `3.1M**`), so only a full
 * re-parse can ever close the emphasis correctly.
 */
function renderMarkdown(host, raw) {
  host.textContent = '';
  const lines = String(raw).split('\n');
  let list = null;      // the open <ul>/<ol>, if any
  let para = null;      // the open <p>, if any
  let tbody = null;     // the open <table>'s body, if any

  const closeAll = () => { list = null; para = null; tbody = null; };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    // A leading pipe is enough to call it a table row: requiring the trailing pipe
    // too would bounce a row between paragraph and table while it streams in.
    const tableRow = /^\s*\|(.*)$/.exec(line);

    if (!line.trim()) { closeAll(); continue; }

    if (tableRow) {
      list = null; para = null;
      const cells = tableRow[1].replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      // The |---|---| divider is layout noise — skip it wherever it lands.
      if (cells.every((c) => /^:?-+:?$/.test(c || '-'))) continue;
      const isHead = !tbody;
      if (isHead) {
        const table = el('table');
        host.appendChild(table);
        table.appendChild(el('thead'));
        tbody = table.appendChild(el('tbody'));
      }
      const tr = el('tr');
      for (const c of cells) {
        const cell = el(isHead ? 'th' : 'td');
        renderInline(cell, c);
        tr.appendChild(cell);
      }
      (isHead ? tbody.parentNode.querySelector('thead') : tbody).appendChild(tr);
    } else if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeAll();
      host.appendChild(el('hr'));
    } else if (heading) {
      closeAll();
      // Clamp to h4–h6: the panel already owns h3, and the agent's "##" is a
      // section label inside a message, not a document-level heading.
      const node = el(`h${Math.min(6, 3 + heading[1].length)}`);
      renderInline(node, heading[2]);
      host.appendChild(node);
    } else if (bullet || numbered) {
      const wantOrdered = Boolean(numbered);
      if (!list || (list.tagName === 'OL') !== wantOrdered) {
        list = el(wantOrdered ? 'ol' : 'ul');
        host.appendChild(list);
      }
      para = null; tbody = null;
      const li = el('li');
      renderInline(li, (bullet || numbered)[1]);
      list.appendChild(li);
    } else {
      list = null; tbody = null;
      if (!para) { para = el('p'); host.appendChild(para); }
      // A soft-wrapped markdown paragraph is one paragraph — join, don't stack.
      else para.appendChild(document.createTextNode(' '));
      renderInline(para, line);
    }
  }
}

/** Read an SSE body, invoking onEvent for each `data:` payload. */
async function readSse(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    if (signal?.aborted) { try { await reader.cancel(); } catch (_) {} return; }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch (_) {
          /* ignore keep-alives / partial frames */
        }
      }
    }
  }
}

/**
 * Mount the chat panel into `container` (replacing its contents).
 *
 * @param {HTMLElement} container
 * @param {{ apiBase?: string, tsHost?: string, dataSourceId?: string, sourceName?: string,
 *           showThinking?: boolean, frameHeight?: number|'auto', liveboardName?: string,
 *           getToken?: () => Promise<{ ok: boolean, token?: string, error?: string }>,
 *           onEvent?: (kind: string, msg: string) => void }} opts
 * @returns {{ destroy(): void }}
 */
export function renderSpotterMcpChat(container, opts = {}) {
  const {
    apiBase = '', tsHost = '', dataSourceId = '', sourceName = '',
    showThinking = true, frameHeight = 'auto', liveboardName = '',
    labels = null, streamChunks = true, pollIntervalMs = 600, systemContext = '',
  } = opts;
  const getToken = opts.getToken || (async () => ({ ok: false, error: 'No credential source configured.' }));
  const log = opts.onEvent || (() => {});

  // 'auto' grows each frame to its content (see the EMBED_HEIGHT listener below); the
  // number is both the starting height and the fallback if the app never reports one.
  const autoHeight = frameHeight === 'auto';
  const baseHeight = autoHeight ? 320 : Number(frameHeight) || 440;

  // Only accept resize messages from the cluster we're embedding.
  let tsOrigin = '';
  try { tsOrigin = new URL(/^https?:\/\//i.test(tsHost) ? tsHost : `https://${tsHost}`).origin; } catch (_) {}

  container.innerHTML = '';
  const panel = el('div', 'smcp');
  panel.id = 'spotter-mcp-panel';

  // ── Header: identity on the left, live session facts as chips on the right ──
  const head = el('div', 'smcp-head');
  const headMain = el('div', 'smcp-head-main');
  headMain.appendChild(el('div', 'smcp-title', 'Spotter Chat'));
  headMain.appendChild(el('div', 'smcp-sub', 'Spotter 3 MCP server · your own chat UI'));
  head.appendChild(headMain);

  const chips = el('div', 'smcp-chips');
  const srcChip = el('span', 'smcp-chip');
  srcChip.appendChild(el('span', 'smcp-chip-k', 'source'));
  srcChip.appendChild(el('span', 'smcp-chip-v', sourceName || dataSourceId || 'auto'));
  const sessChip = el('span', 'smcp-chip');
  sessChip.appendChild(el('span', 'smcp-chip-k', 'session'));
  const sessVal = el('span', 'smcp-chip-v mono', '—');
  sessChip.appendChild(sessVal);
  chips.append(srcChip, sessChip);
  head.appendChild(chips);
  panel.appendChild(head);

  const logEl = el('div', 'smcp-log');
  logEl.setAttribute('aria-live', 'polite');
  panel.appendChild(logEl);

  // Empty state — the panel is otherwise a blank rectangle before the first question.
  const empty = el('div', 'smcp-empty');
  empty.appendChild(el('div', 'smcp-empty-t', 'Ask a question to start an analysis session'));
  const hints = el('div', 'smcp-empty-hints');
  for (const q of ['What were total sales last year?', 'Sales by region', 'Why did revenue drop in Q3?']) {
    const b = el('button', 'smcp-hint', q);
    b.type = 'button';
    b.addEventListener('click', () => { input.value = q; form.requestSubmit(); });
    hints.appendChild(b);
  }
  empty.appendChild(hints);
  logEl.appendChild(empty);

  // ── Liveboard bar: hidden until the session produces an answer, since
  // create_dashboard has nothing to pin before that.
  const lbBar = el('div', 'smcp-lb');
  lbBar.hidden = true;
  const lbCount = el('span', 'smcp-lb-count');
  const lbTitle = el('input', 'inp smcp-lb-title');
  lbTitle.type = 'text';
  lbTitle.placeholder = 'Liveboard name';
  lbTitle.value = liveboardName;
  // create_dashboard's third argument. It becomes a note tile at the top of the
  // Liveboard, so it is worth exposing rather than silently defaulting.
  const lbDesc = el('input', 'inp smcp-lb-desc');
  lbDesc.type = 'text';
  lbDesc.placeholder = 'Note tile (optional)';
  const lbBtn = el('button', 'sec-apply smcp-lb-btn', 'Create Liveboard');
  lbBtn.type = 'button';
  const lbNote = el('span', 'smcp-lb-note');
  lbBar.append(lbCount, lbTitle, lbDesc, lbBtn, lbNote);
  panel.appendChild(lbBar);

  const form = el('form', 'smcp-composer');
  const input = el('input', 'inp smcp-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'Ask a data question — e.g. "What drove revenue last quarter?"';
  const send = el('button', 'sec-apply smcp-send', 'Ask');
  send.type = 'submit';
  const reset = el('button', 'sec-add smcp-reset', '↻ New session');
  reset.type = 'button';
  form.append(input, send, reset);
  panel.appendChild(form);
  container.appendChild(panel);

  let sessionId = null;
  let busy = false;
  const controller = new AbortController();
  // Every answer this session has produced → the create_dashboard payload.
  const sessionAnswers = new Map(); // answer_id -> { title, include: () => boolean }

  // Swap the MCP marker iframes we append for real SDK embeds. Requires init() to have
  // run (app.js does that on Connect); if the SDK isn't ready the answers still render
  // as plain frames rather than the panel failing to mount.
  let frameObserver = null;
  try {
    frameObserver = startAutoMCPFrameRenderer({ frameParams: { width: '100%', height: `${baseHeight}px` } });
  } catch (err) {
    log('MCP', `auto frame renderer unavailable: ${err.message || err}`);
  }

  /**
   * Grow an answer frame to its content.
   *
   * A KPI answer needs ~200px and a stacked bar chart ~600 — one fixed height is
   * wrong for both. The embedded app reports its own height as an EMBED_HEIGHT
   * message, but only the Liveboard/App embeds wire that up in the SDK, and
   * AutoFrameRenderer extends the base TsEmbed. So listen for the message directly
   * and match it back to the iframe by its contentWindow. Best-effort by design:
   * if the app never reports, the frame keeps its starting height.
   */
  function onFrameMessage(e) {
    if (!autoHeight) return;
    if (tsOrigin && e.origin !== tsOrigin) return;
    if (!e.data || e.data.type !== 'EMBED_HEIGHT') return;
    const px = Number(e.data.data);
    if (!Number.isFinite(px) || px <= 0) return;
    for (const f of logEl.querySelectorAll('iframe')) {
      if (f.contentWindow === e.source) {
        // Clamp: a runaway report must not push the composer off-screen, and a
        // near-zero one must not collapse the chart to an invisible strip.
        const h = `${Math.min(760, Math.max(180, Math.round(px)))}px`;
        f.style.height = h;
        // The SDK pins an inline min-height at the starting height, which silently
        // blocks every shrink — a KPI answer would stay stuck at the 320px start.
        f.style.minHeight = h;
        return;
      }
    }
  }
  window.addEventListener('message', onFrameMessage);

  const scroll = () => { logEl.scrollTop = logEl.scrollHeight; };
  const addNode = (node) => { empty.remove(); logEl.appendChild(node); scroll(); return node; };
  const addMessage = (text, kind) => addNode(el('div', `smcp-msg ${kind}`, text));

  /** The animated "…" placeholder shown between Ask and the first token. */
  function addTyping() {
    const t = el('div', 'smcp-typing');
    for (let i = 0; i < 3; i++) t.appendChild(el('span', 'smcp-dot'));
    return addNode(t);
  }

  function updateLbBar() {
    const n = sessionAnswers.size;
    lbBar.hidden = n === 0;
    lbCount.textContent = n === 1 ? '1 answer in this session' : `${n} answers in this session`;
  }

  /**
   * Render (or update) one answer. The backend relays the same answer_id twice —
   * a thinking preview then the final version — so key on it and replace in place
   * rather than appending a second card.
   */
  function renderAnswer({ answer_id, answer_title, iframe_url }, cards) {
    const title = answer_title || 'Answer';
    let card = cards.get(answer_id);
    if (!card) {
      card = el('section', 'smcp-card');
      const cardHead = el('div', 'smcp-card-head');
      cardHead.appendChild(el('h3'));
      // Per-answer opt-out: a session usually contains exploratory answers you do
      // NOT want on the Liveboard, so pinning is a choice, not all-or-nothing.
      const pick = el('label', 'smcp-pick');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = true;
      pick.append(box, el('span', null, 'Pin to Liveboard'));
      cardHead.appendChild(pick);
      card.appendChild(cardHead);
      cards.set(answer_id, card);
      addNode(card);
      if (answer_id) sessionAnswers.set(answer_id, { title, include: () => box.checked });
    }
    card.querySelector('h3').textContent = title;
    if (answer_id && sessionAnswers.has(answer_id)) sessionAnswers.get(answer_id).title = title;
    updateLbBar();
    if (!iframe_url) return card;
    // The relay supplies this URL. An iframe src is a navigation sink, so require a plain http(s)
    // scheme before it ever reaches the element — the same refusal the "Open in ThoughtSpot" link
    // below applies. `javascript:`/`data:` in an iframe src executes in THIS document's context.
    if (!/^https?:\/\//i.test(String(iframe_url))) {
      log('MCP', `✗ refused a non-http(s) answer URL for ${answer_id || 'answer'}`);
      return card;
    }

    // The auto-renderer REPLACES our iframe with its own element, whose src is the
    // rewritten embed URL — so the live element's src can never be compared against
    // iframe_url. Track the URL we asked for on the card instead, and when it
    // genuinely changes, drop in a FRESH marker iframe: mutating the swapped-in
    // embed's src would bypass the observer and strand an unauthenticated frame.
    if (card.dataset.mcpSrc === iframe_url) return card;
    card.dataset.mcpSrc = iframe_url;

    const frame = document.createElement('iframe');
    frame.title = title;
    frame.style.height = `${baseHeight}px`;
    // isFullHeightPinboard is what makes the embedded app report EMBED_HEIGHT at all.
    // The auto-renderer copies the marker URL's own params over the SDK's, so setting
    // it here is the only way to reach the final embed src.
    let src = iframe_url;
    if (autoHeight) {
      try {
        const u = new URL(iframe_url);
        u.searchParams.set('isFullHeightPinboard', 'true');
        src = u.href;
      } catch (_) { /* not a parseable URL — send it through untouched */ }
    }
    frame.src = src;
    const prev = card.querySelector('iframe');
    if (prev) prev.replaceWith(frame); else card.appendChild(frame);
    return card;
  }

  /** Pin the checked answers of this session into a new Liveboard. */
  async function createLiveboard() {
    const answers = [...sessionAnswers]
      .filter(([, a]) => a.include())
      .map(([answer_id, a]) => ({ answer_id, title: a.title }));
    if (!answers.length) {
      lbNote.textContent = 'Pick at least one answer.';
      return;
    }
    const name = lbTitle.value.trim();

    const cred = await getToken();
    if (!cred.ok || !cred.token) {
      lbNote.textContent = '';
      addMessage(cred.error || 'Connect to ThoughtSpot first.', 'error');
      return;
    }

    lbNote.textContent = 'Creating…';
    log('MCP', `POST /api/spotter-mcp/dashboard — ${answers.length} answer(s)`);

    const response = await fetch(`${apiBase}/api/spotter-mcp/dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.token}` },
      signal: controller.signal,
      body: JSON.stringify({ title: name || undefined, note: lbDesc.value.trim() || undefined, answers, tsHost }),
    });
    const data = await response.json().catch(() => null);
    lbNote.textContent = '';

    // Either identifier means it exists — create_dashboard has returned a bare
    // { link } in practice, and demanding an id reported real Liveboards as failures.
    if (!response.ok || !(data?.dashboard_id || data?.dashboard_url)) {
      const detail = data?.error || `HTTP ${response.status}`;
      addMessage(`Liveboard creation failed: ${detail}`, 'error');
      log('MCP', `✗ ${detail}`);
      return;
    }

    const done = el('div', 'smcp-msg smcp-ok');
    done.appendChild(el('span', null,
      `Created Liveboard “${name || 'Spotter session'}” with ${answers.length} visualization${answers.length === 1 ? '' : 's'}. `));
    // The URL comes from ThoughtSpot — still refuse anything that isn't plain http(s).
    let href = '';
    try {
      // Base off the NORMALISED origin, not `https://${tsHost}` — app.js passes a full
      // "https://cluster…" host, so the naive template yields "https://https://cluster…" and a
      // relative dashboard_url resolves to https://https/… (a link to nowhere). tsOrigin is ''
      // when tsHost is unparseable, and `new URL(rel, '')` throws → caught → no link, fail-closed.
      const u = new URL(data.dashboard_url, tsOrigin);
      if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href;
    } catch (_) { /* no link, just the confirmation */ }
    if (href) {
      const a = el('a', 'smcp-lb-link', 'Open in ThoughtSpot ↗');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      done.appendChild(a);
    }
    addNode(done);
    log('MCP', `liveboard ${data.dashboard_id || data.dashboard_url}`);
  }

  async function ask(question) {
    addMessage(question, 'user');
    const typing = addTyping();
    // Removed in a finally: getToken(), fetch() and readSse() can each throw (network drop, abort,
    // a relay 5xx), and every throw used to strand the three bouncing dots in the transcript for
    // the rest of the session. .remove() is idempotent, so the happy-path removals still stand.
    try {
      await askTurn(question, typing);
    } finally {
      typing.remove();
    }
  }

  async function askTurn(question, typing) {
    const cards = new Map(); // answer_id -> card element

    // One live node per lane for this turn. The wire interleaves reasoning and
    // answer prose and splits sentences across the switch, so a lane must keep
    // appending to its OWN node instead of starting a bubble on every flip.
    let lanes = { thinking: null, final: null };
    const laneNode = (thinking) => {
      const key = thinking ? 'thinking' : 'final';
      if (lanes[key]) return lanes[key];
      let body;
      if (thinking) {
        // Reasoning is context, not the answer — fold it away so it stops
        // competing with the result for attention.
        const d = el('details', 'smcp-think');
        d.appendChild(el('summary', null, 'Reasoning'));
        body = el('div', 'smcp-think-body');
        d.appendChild(body);
        addNode(d);
      } else {
        body = el('div', 'smcp-msg agent');
        addNode(body);
      }
      lanes[key] = { body, raw: '', pending: '' };
      return lanes[key];
    };

    // Typewriter pacing. The MCP server hands back everything generated since the
    // last poll in one lump (2–4s apart in practice), so painting each SSE event
    // verbatim renders whole paragraphs at once. Queue text per lane and drain a
    // few characters per frame — the drain rate scales with the backlog so the
    // transcript catches up within ~2.5s of any batch, but the paint reads as a
    // steady stream instead of lurches.
    let drainTimer = null;
    const drainStep = () => {
      drainTimer = null;
      let more = false;
      for (const lane of Object.values(lanes)) {
        if (!lane || !lane.pending) continue;
        const n = Math.min(60, Math.max(3, Math.ceil(lane.pending.length / 150)));
        lane.raw += lane.pending.slice(0, n);
        lane.pending = lane.pending.slice(n);
        renderMarkdown(lane.body, lane.raw);
        if (lane.pending) more = true;
      }
      scroll();
      if (more) drainTimer = requestAnimationFrame(drainStep);
    };
    const queueText = (lane, text) => {
      lane.pending += text;
      if (!drainTimer) drainTimer = requestAnimationFrame(drainStep);
    };
    // Emit everything still queued NOW — before an answer card lands (so the prose
    // that precedes the chart is complete when the card appends below it) and at
    // end of stream (so an aborted or finished turn never swallows held text).
    const flushLanes = () => {
      if (drainTimer) { cancelAnimationFrame(drainTimer); drainTimer = null; }
      for (const lane of Object.values(lanes)) {
        if (!lane || !lane.pending) continue;
        lane.raw += lane.pending;
        lane.pending = '';
        renderMarkdown(lane.body, lane.raw);
      }
      scroll();
    };

    // The relay forwards OUR token and never mints one, so resolve it before every turn.
    const cred = await getToken();
    if (!cred.ok || !cred.token) {
      typing.remove();
      addMessage(cred.error || 'Connect to ThoughtSpot first — this chat runs as you, using your own session.', 'error');
      return;
    }

    log('MCP', `POST /api/spotter-mcp/chat — “${question.slice(0, 60)}”`);
    const response = await fetch(`${apiBase}/api/spotter-mcp/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.token}` },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        tsHost,
        sessionId: sessionId || undefined,
        dataSourceId: dataSourceId || undefined,
        // Streaming + relabeling overrides; omitted values keep the server defaults.
        labels: labels && Object.keys(labels).length ? labels : undefined,
        streamChunks,
        pollIntervalMs,
        // Persona / standing instructions — send_session_message additional_context,
        // re-sent with EVERY turn (the session does not remember it server-side).
        systemContext: systemContext.trim() || undefined,
      }),
    });

    if (!response.ok || !response.body) {
      typing.remove();
      let detail = `HTTP ${response.status}`;
      try { const j = await response.json(); if (j && j.error) detail = j.error; } catch (_) {}
      addMessage(detail, 'error');
      log('MCP', `✗ ${detail}`);
      return;
    }

    log('MCP', 'streaming session updates (get_session_updates → SSE)');
    await readSse(response, (evt) => {
      switch (evt.type) {
        case 'session':
          sessionId = evt.sessionId; // reused on every follow-up question
          sessVal.textContent = evt.sessionId;
          if (evt.isNew) log('MCP', `new analysis session ${evt.sessionId}`);
          break;
        case 'text': {
          typing.remove();
          const thinking = Boolean(evt.thinking);
          if (thinking && !showThinking) break;
          queueText(laneNode(thinking), evt.text);
          break;
        }
        case 'answer': {
          typing.remove();
          // Each answer_id arrives TWICE (thinking preview, then final). Only the first
          // sighting is a new chart in the transcript — resetting the lanes on the repeat
          // too is what was splitting one sentence across two bubbles, because the
          // duplicate lands mid-prose.
          const isNewCard = !cards.has(evt.answer_id);
          if (isNewCard) flushLanes(); // complete the prose above before the chart lands
          renderAnswer(evt, cards);
          // Prose that follows a chart is commentary ON it — start fresh nodes so
          // it lands below the chart instead of back up in the earlier bubble.
          if (isNewCard) lanes = { thinking: null, final: null };
          log('MCP', `answer: ${evt.answer_title || evt.answer_id}`);
          break;
        }
        case 'error':
          typing.remove();
          addMessage(evt.message, 'error');
          log('MCP', `✗ ${evt.message}`);
          break;
        case 'update':
          // A session_update shape the relay didn't recognise. Don't render it — but
          // don't swallow it either: a silently-dropped update is exactly how the
          // text-chunk/text_chunk mismatch hid as "streaming looks wrong" instead of
          // showing up as a decodable event.
          log('MCP', `unhandled update type: ${evt.update?.type ?? '(none)'}`);
          break;
        default:
          break;
      }
    }, controller.signal);

    flushLanes(); // stream over (done, error, or abort) — never hold queued text
    log('MCP', 'turn complete'); // the indicator goes away in ask()'s finally
  }

  const setBusy = (v) => {
    busy = v;
    input.disabled = send.disabled = lbBtn.disabled = v;
    send.textContent = v ? '…' : 'Ask';
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question || busy) return;

    input.value = '';
    setBusy(true);
    try {
      await ask(question);
    } catch (err) {
      if (err && err.name !== 'AbortError') addMessage(String(err.message || err), 'error');
    } finally {
      setBusy(false);
      input.focus();
    }
  });

  lbBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await createLiveboard();
    } catch (err) {
      lbNote.textContent = '';
      if (err && err.name !== 'AbortError') addMessage(String(err.message || err), 'error');
    } finally {
      setBusy(false);
    }
  });

  reset.addEventListener('click', () => {
    sessionId = null;
    sessVal.textContent = '—';
    logEl.textContent = '';
    logEl.appendChild(empty);
    sessionAnswers.clear();
    lbNote.textContent = '';
    lbDesc.value = '';
    updateLbBar();
    log('MCP', 'session cleared — the next question starts a new one');
    input.focus();
  });

  input.focus();
  return {
    destroy() {
      controller.abort();
      frameObserver?.disconnect(); // stop rewriting iframes once the panel is gone
      window.removeEventListener('message', onFrameMessage);
      panel.remove();
    },
  };
}
