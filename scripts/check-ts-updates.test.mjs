/**
 * scripts/check-ts-updates.test.mjs — unit test for the detector's exit-code contract.
 *
 * The defect this pins down: a transient doc 5xx used to be pushed onto `changes`, so a bad minute
 * at the doc host produced "CHANGES DETECTED" (exit 10) and sent the weekly routine off to open a
 * PR about nothing. Only a genuinely gone page (404/410) is drift.
 *
 * Runs with `node --test scripts/check-ts-updates.test.mjs`. Zero dependencies: the whole network
 * is a stubbed global fetch, so the test never touches npm, GitHub or developers.thoughtspot.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './check-ts-updates.mjs';

const DOC_RE = /developers\.thoughtspot\.com/;

// Minimal Response-alike: the detector only reads .ok, .status and .text().
const res = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body });

// npm/GitHub are always soft-failed so the assertions isolate the doc branch.
function stubFetch(docStatus, docBody = '') {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (DOC_RE.test(u)) return res(docStatus, docBody);
    return res(503); // npm + GitHub → warnings, never changes
  };
  return () => { globalThis.fetch = real; };
}

// Silence the detector's human report; the test asserts on the exit code and the report text.
async function runQuiet(docStatus, docBody) {
  const restoreFetch = stubFetch(docStatus, docBody);
  const realLog = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return { code: await main(), out: lines.join('\n') };
  } finally {
    console.log = realLog;
    restoreFetch();
  }
}

test('a transient doc 5xx is a warning, not a change (exit 0)', async () => {
  const { code, out } = await runQuiet(503);
  assert.equal(code, 0, 'a 503 on a watched doc must not report drift');
  assert.match(out, /No changes detected/);
  assert.match(out, /doc fetch returned 503/);
});

test('a doc 429 is a warning, not a change (exit 0)', async () => {
  const { code } = await runQuiet(429);
  assert.equal(code, 0);
});

test('a doc 404 IS a change (exit 10)', async () => {
  const { code, out } = await runQuiet(404);
  assert.equal(code, 10, 'a gone doc page is real drift');
  assert.match(out, /DOC 404/);
});

test('a doc 410 IS a change (exit 10)', async () => {
  const { code } = await runQuiet(410);
  assert.equal(code, 10);
});
