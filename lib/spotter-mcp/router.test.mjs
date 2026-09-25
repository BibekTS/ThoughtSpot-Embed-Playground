import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeType, hostFromUrl, isAuthError, dashboardResult, cleanLabels, cleanContext,
} from './router.mjs';

test('cleanContext keeps prompt structure but strips control chars and bounds length', () => {
  // Newlines and tabs are meaningful in a persona prompt — they must survive.
  assert.equal(cleanContext('  Answer in French.\n\tBe brief.  '), 'Answer in French.\n\tBe brief.');
  // Other control characters (incl. NUL and ESC) are stripped.
  assert.equal(cleanContext('a\u0000b\u001bc'), 'abc');
  // Bounded so a hostile caller cannot stuff megabytes into every MCP message.
  assert.equal(cleanContext('x'.repeat(9000)).length, 4000);
  assert.equal(cleanContext(null), '');
  assert.equal(cleanContext(42), '42');
});

test('hostFromUrl still strips the protocol (regression guard for the sanitizer)', () => {
  assert.equal(hostFromUrl('https://acme.thoughtspot.cloud/'), 'acme.thoughtspot.cloud');
  assert.equal(hostFromUrl('acme.thoughtspot.cloud'), 'acme.thoughtspot.cloud');
});

test('dashboardResult reads the bare { link } the beta endpoint actually returns', () => {
  // Regression: demanding dashboard_id reported a Liveboard that WAS created as a failure.
  const out = dashboardResult({ link: 'https://acme.thoughtspot.cloud/#/pinboard/00000000-1111-2222-3333-444444444444' });
  assert.equal(out.dashboard_id, '00000000-1111-2222-3333-444444444444');
  assert.match(out.dashboard_url, /^https:\/\/acme\./);
});

test('dashboardResult still reads the documented shape', () => {
  const out = dashboardResult({ dashboard_id: 'abc123', dashboard_url: 'https://h/#/liveboard/abc123' });
  assert.equal(out.dashboard_id, 'abc123');
  assert.equal(out.dashboard_url, 'https://h/#/liveboard/abc123');
});

test('dashboardResult reports nothing usable rather than inventing a link', () => {
  assert.deepEqual(dashboardResult({}), { dashboard_id: '', dashboard_url: '' });
  // A non-http link must not become an href.
  assert.equal(dashboardResult({ link: 'javascript:alert(1)' }).dashboard_url, '');
});

test('cleanLabels bounds caller-supplied relabels and drops prototype keys', () => {
  assert.deepEqual(cleanLabels({ Liveboard: 'Dashboard' }), { Liveboard: 'Dashboard' });
  assert.equal(Object.hasOwn(cleanLabels({ __proto__: 'x', a: 'b' }) ?? {}, '__proto__'), false);
  assert.equal(Object.keys(cleanLabels(Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [`k${i}`, 'v']),
  ))).length, 50);
  assert.equal(cleanLabels(null), null);
  assert.equal(cleanLabels(['a']), null);
  assert.equal(cleanLabels({}), null);
});

test('normalizeType folds every observed spelling of the chunk update', () => {
  // The incremental-token update is documented as `text-chunk`; `text_chunk` has also
  // been seen. A mismatch here does not throw — it silently degrades the stream to
  // whole-message lumps — so pin both spellings.
  for (const t of ['text-chunk', 'text_chunk', 'TEXT-CHUNK', ' text chunk ', 'Text_Chunk']) {
    assert.equal(normalizeType(t), 'text_chunk', `${JSON.stringify(t)} should fold to text_chunk`);
  }
});

test('normalizeType leaves the other update types reachable', () => {
  assert.equal(normalizeType('text'), 'text');
  assert.equal(normalizeType('answer'), 'answer');
  assert.equal(normalizeType('Answer'), 'answer');
});

test('normalizeType is total — a missing type never throws', () => {
  assert.equal(normalizeType(undefined), '');
  assert.equal(normalizeType(null), '');
});

test('hostFromUrl reduces a pasted URL to the bare host x-ts-host wants', () => {
  assert.equal(hostFromUrl('https://acme.thoughtspot.cloud/'), 'acme.thoughtspot.cloud');
  assert.equal(hostFromUrl('https://acme.thoughtspot.cloud/#/home'), 'acme.thoughtspot.cloud');
  assert.equal(hostFromUrl('acme.thoughtspot.cloud'), 'acme.thoughtspot.cloud');
});

test('isAuthError only claims the failures a fresh token would fix', () => {
  assert.equal(isAuthError(new Error('Request failed with 401')), true);
  assert.equal(isAuthError(new Error('token expired')), true);
  assert.equal(isAuthError(new Error('ECONNREFUSED')), false);
});
