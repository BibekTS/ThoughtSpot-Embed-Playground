/**
 * mcp-client.js — ThoughtSpot Spotter 3 MCP session client (Streamable HTTP).
 *
 * Mirrors the analytical-session flow of the Python reference example:
 *   create_analysis_session -> send_session_message -> poll get_session_updates
 * until is_done. No LLM in the loop: tools are called directly.
 *
 * Standalone module: no Express, no customization layer.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The analytical-session tools (create_analysis_session / send_session_message /
 * get_session_updates, plus create_dashboard) are served on api-version=beta AND on
 * dated versions >= 2026-05-01 (2026-05-01, 2026-06-01, 2026-09-01 verified). Dates
 * <= 2026-04-01 connect fine but SILENTLY list the legacy toolset (ping,
 * createLiveboard, getDataSourceSuggestions, getRelevantQuestions, getAnswer).
 * `latest` / 2026-10-01 add preview model tools on top. Verified via tools/list on
 * 2026-10-01. ThoughtSpot recommends pinning a dated version for custom apps; the
 * default stays on beta until that switch is made deliberately. Override with MCP_URL.
 */
export const DEFAULT_MCP_URL = 'https://agent.thoughtspot.app/token/mcp?api-version=beta';

export const SESSION_TOOLS = [
  'create_analysis_session',
  'send_session_message',
  'get_session_updates',
];

/**
 * Liveboard creation is NOT part of the analysis session — the in-session agent will
 * tell you it can't build one, and it's right: it's this separate tool. Answers are
 * referenced by the answer_id carried on each `answer` session_update.
 */
export const DASHBOARD_TOOL = 'create_dashboard';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** note_tile is raw HTML rendered inside a Liveboard — never interpolate a caller string unescaped. */
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Tool results come back as content blocks; Spotter returns one JSON text block. */
function parseToolResult(result, toolName) {
  const text = (result?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('');

  if (result?.isError) {
    throw new Error(`MCP tool ${toolName} failed: ${text || 'unknown error'}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** The session id has drifted in spelling across API versions; accept the known shapes. */
function pickSessionId(payload) {
  return (
    payload?.analytical_session_id ??
    payload?.session_id ??
    payload?.sessionId ??
    payload?.data?.analytical_session_id ??
    null
  );
}

export class SpotterMcpClient {
  constructor(client) {
    this.client = client;
  }

  /**
   * Connect over Streamable HTTP with the ThoughtSpot proxy headers.
   * @param {{url?: string, host: string, token: string}} opts
   */
  static async connect({ url = DEFAULT_MCP_URL, host, token }) {
    if (!host || !token) throw new Error('TS_HOST and TS_AUTH_TOKEN are required');

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-ts-host': host,
        },
      },
    });

    const client = new Client(
      { name: 'spotter-mcp-chatbot', version: '0.1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return new SpotterMcpClient(client);
  }

  async callTool(name, args = {}) {
    const result = await this.client.callTool({ name, arguments: args });
    return parseToolResult(result, name);
  }

  async listTools() {
    const { tools } = await this.client.listTools();
    return tools.map((t) => t.name);
  }

  async createAnalysisSession(dataSourceId) {
    const payload = await this.callTool(
      'create_analysis_session',
      dataSourceId ? { data_source_id: dataSourceId } : {},
    );
    const sessionId = pickSessionId(payload);
    if (!sessionId) {
      throw new Error(
        `create_analysis_session returned no session id: ${JSON.stringify(payload).slice(0, 300)}`,
      );
    }
    return sessionId;
  }

  sendSessionMessage(sessionId, message, additionalContext) {
    return this.callTool('send_session_message', {
      analytical_session_id: sessionId,
      message,
      ...(additionalContext ? { additional_context: additionalContext } : {}),
    });
  }

  getSessionUpdates(sessionId) {
    return this.callTool('get_session_updates', { analytical_session_id: sessionId });
  }

  /**
   * Pin answers into a new Liveboard.
   *
   * @param {{title: string, answers: Array<{answer_id: string, title: string}>, note?: string}} opts
   * @returns {Promise<{dashboard_id?: string, dashboard_url?: string}>}
   */
  createDashboard({ title, answers, note }) {
    // note_tile is a required argument on the tool, so always send one — a single-line
    // HTML string is what it expects, and a title header beats a schema error. The text
    // is caller-supplied and lands in a rendered tile, so it is escaped, never trusted.
    return this.callTool(DASHBOARD_TOOL, {
      title,
      answers,
      note_tile: note
        ? `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(note)}</p>`
        : `<h3>${escapeHtml(title)}</h3>`,
    });
  }

  /**
   * Ask one question and yield every session_update as it arrives.
   *
   * Yields:
   *   { type: 'session', sessionId }   — always first; new or reused
   *   { type: 'update',  update }      — a raw session_update (text_chunk | text | answer | …)
   *
   * @param {{question: string, sessionId?: string, dataSourceId?: string,
   *          additionalContext?: string, pollIntervalMs?: number, timeoutMs?: number,
   *          signal?: AbortSignal}} opts
   */
  async *ask({
    question,
    sessionId,
    dataSourceId,
    additionalContext,
    pollIntervalMs = 600,
    timeoutMs = 180_000,
    emptyDoneRetries = 3,
    signal,
  }) {
    const activeSessionId = sessionId || (await this.createAnalysisSession(dataSourceId));
    yield { type: 'session', sessionId: activeSessionId, isNew: !sessionId };

    await this.sendSessionMessage(activeSessionId, question, additionalContext);

    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    let emptyDoneChecks = 0;

    for (;;) {
      if (signal?.aborted) return;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for session updates`);
      }

      const payload = await this.getSessionUpdates(activeSessionId);
      const updates = payload?.session_updates ?? [];
      seen += updates.length;
      for (const update of updates) {
        yield { type: 'update', update };
      }

      if (payload?.is_done) {
        // The first poll can land before the agent has started, reporting done
        // with nothing produced. Re-check a few times before believing it.
        if (seen > 0 || emptyDoneChecks >= emptyDoneRetries) return;
        emptyDoneChecks++;
      }

      await sleep(pollIntervalMs);
    }
  }

  async close() {
    try {
      await this.client.close();
    } catch {
      /* best effort — throwaway harness */
    }
  }
}
