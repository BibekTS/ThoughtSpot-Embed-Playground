/**
 * customize.js — swappable text-customization layer.
 *
 * Rewrites vendor terms ("Spotter" -> "DataAnalyzer") in agent-authored prose,
 * word-boundary and case-preserving, and never inside URLs or markdown link
 * targets. Stream-safe: use createStreamCustomizer() for text_chunk updates,
 * which holds back a tail so a term split across two chunks is still replaced.
 *
 * Standalone module: no Express, no MCP, no I/O beyond loadLabelMap().
 */

import { readFileSync } from 'node:fs';

const PLACEHOLDER = '\u0000'; // NUL never appears in agent text — a safe mask delimiter

/** Spans that must survive substitution untouched: bare URLs and markdown link targets. */
const PROTECTED = [
  /\]\([^)\s]*\)/g,                                   // markdown link/image target: ](https://…)
  /\b(?:https?:\/\/|www\.)[^\s<>()[\]"'`]+/gi,        // bare URL
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const upperFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Read a LABEL_MAP from a JSON file so per-client maps are swappable without code changes. */
export function loadLabelMap(path) {
  const map = JSON.parse(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(map)) {
    if (typeof k !== 'string' || typeof v !== 'string' || !k) {
      throw new Error(`labels.json: entries must be non-empty string pairs (bad key: ${k})`);
    }
  }
  return map;
}

/** Match the source term's casing: SPOTTER -> DATAANALYZER, spotter -> dataAnalyzer. */
function applyCase(match, key, replacement) {
  if (match === key) return replacement;
  if (match === key.toUpperCase()) return replacement.toUpperCase();
  if (match === key.toLowerCase()) return lowerFirst(replacement);
  if (match[0] === match[0].toUpperCase()) return upperFirst(replacement);
  return lowerFirst(replacement);
}

/**
 * Build a customizer for one LABEL_MAP.
 * @returns {{ customize(text: string): string, maxKeyLength: number }}
 */
export function createCustomizer(labelMap) {
  const keys = Object.keys(labelMap ?? {}).filter(Boolean);
  const maxKeyLength = keys.reduce((n, k) => Math.max(n, k.length), 0);

  if (!keys.length) return { customize: (text) => text ?? '', maxKeyLength: 0 };

  // Longest key first, so "Liveboard Answer"-style overlaps resolve to the longer term.
  // One combined pass, so a replacement can never be re-matched by a later key.
  const byLength = [...keys].sort((a, b) => b.length - a.length);
  const lookup = new Map(byLength.map((k) => [k.toLowerCase(), labelMap[k]]));
  const termRe = new RegExp(`\\b(?:${byLength.map(escapeRe).join('|')})\\b`, 'gi');

  function customize(text) {
    if (typeof text !== 'string' || !text) return text ?? '';

    // Mask protected spans (URLs, link targets) so substitution can't reach inside them.
    const masked = [];
    let working = text;
    for (const re of PROTECTED) {
      working = working.replace(re, (span) => {
        masked.push(span);
        return `${PLACEHOLDER}${masked.length - 1}${PLACEHOLDER}`;
      });
    }

    working = working.replace(termRe, (match) => {
      const replacement = lookup.get(match.toLowerCase());
      if (replacement === undefined) return match;
      const key = byLength.find((k) => k.toLowerCase() === match.toLowerCase());
      return applyCase(match, key, replacement);
    });

    return working.replace(
      new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
      (_, i) => masked[Number(i)],
    );
  }

  return { customize, maxKeyLength };
}

const isWordChar = (ch) => ch !== undefined && /[\w-]/.test(ch);

/**
 * Pull a cut point back out of a protected span that is still being streamed.
 * Cutting inside a half-arrived URL would strip its protection and let a term
 * inside the URL be substituted.
 */
function backOffProtected(buffer, cut) {
  // Markdown link target the cut would land inside (or whose ")" has not arrived yet).
  const open = buffer.lastIndexOf('](', cut);
  if (open !== -1) {
    const close = buffer.indexOf(')', open);
    if (close === -1 || close >= cut) return open;
  }

  // Bare URL token the cut would land inside (or that whitespace has not closed yet).
  let start = cut;
  while (start > 0 && !/\s/.test(buffer[start - 1])) start--;
  const token = /^\S*/.exec(buffer.slice(start))[0];
  if (/^(?:https?:\/\/|www\.)/i.test(token) && start + token.length > cut) return start;

  return cut;
}

/**
 * Stateful customizer for a stream of text_chunk updates.
 *
 * push(chunk) appends to a buffer, emits everything up to a safe cut point, and
 * retains the tail — at least (longest LABEL_MAP key - 1) characters, extended
 * backwards to the nearest word boundary so a cut never lands mid-term. flush()
 * returns whatever is still held when the stream ends.
 */
export function createStreamCustomizer(labelMap) {
  const { customize, maxKeyLength } = createCustomizer(labelMap);
  const holdback = Math.max(maxKeyLength - 1, 0);
  let buffer = '';

  return {
    customize,
    push(chunk) {
      buffer += chunk ?? '';
      let cut = buffer.length - holdback;
      if (cut <= 0) return '';
      // Never cut inside a word: a term straddling the cut would escape substitution.
      while (cut > 0 && isWordChar(buffer[cut - 1]) && isWordChar(buffer[cut])) cut--;
      cut = backOffProtected(buffer, cut);
      if (cut <= 0) return '';
      const emit = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return customize(emit);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return customize(rest);
    },
  };
}
