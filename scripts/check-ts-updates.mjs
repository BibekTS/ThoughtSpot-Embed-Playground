/**
 * scripts/check-ts-updates.mjs — ts-watch DETECTOR (never edits anything).
 *
 * The cheap, deterministic front half of the "keep up with ThoughtSpot" pipeline. It answers one
 * question: has anything the playground tracks drifted since the last merged watermark? It checks
 *   1. pin consistency  — ts-sdk-version.json === the version in js/embed.js (integrity failure if not)
 *   2. npm              — latest @thoughtspot/visual-embed-sdk vs our pin
 *   3. GitHub releases   — SDK release tags newer than the last processed one (soft on rate-limit)
 *   4. watched doc pages — content hash vs the watermark (detects edits on unversioned pages)
 *
 * Exit-code contract (the scheduled routine branches on this):
 *   0  → no changes; the routine stops silently (warnings, if any, are printed but non-fatal)
 *   10 → changes detected; the routine follows docs/ts-watch-playbook.md
 *   1  → an INTEGRITY error only (pin drift, unreadable pin/watermark/embed.js) — report and stop
 *
 * Transient network failures (npm 5xx, GitHub 403/429 rate-limit, doc 5xx/429, doc timeouts) are
 * WARNINGS, not errors — and they are not CHANGES either: only a 404/410 on a watched doc counts
 * as drift. They must never convert a real "drift detected" into exit 1, and a fully-failed run
 * just reports exit 0 with warnings — the weekly cadence tolerates a missed week.
 *
 * Flags:  --json  emit a machine-readable block in addition to the human summary.
 * Zero dependencies, Node ≥18 (global fetch). Matches the style of the other scripts/*.mjs.
 */

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WANT_JSON = process.argv.includes('--json');
const NPM_PKG = '@thoughtspot/visual-embed-sdk';
const FETCH_TIMEOUT_MS = 15_000;
const RELEASE_RE = /^\d+\.\d+\.\d+$/; // plain releases only — semverCmp is NOT prerelease-safe

function semverCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'ts-watch-detector' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // a hung URL must not stall the run
  });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}

// Hash the page's CONTENT, not incidental markup churn: drop scripts/styles/comments, then tags.
// Comments must go before the tag-stripper — `<[^>]+>` truncates a comment containing `>` and
// would leak its tail (often a build timestamp) into the hashed text.
function extractText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const contentHash = (html) => 'sha256:' + createHash('sha256').update(extractText(html)).digest('hex');

async function main() {
  const result = {
    pinConsistent: true,
    changes: [],           // drift the agent should act on (drives exit 10)
    warnings: [],          // transient/soft problems (never change the exit code)
    integrityErrors: [],   // pin/watermark problems (drive exit 1)
    sdk: {},
    docs: {},
  };

  // ---- 1. Pin consistency (integrity) ----------------------------------------
  let pin = null;
  try {
    pin = (await readJson('ts-sdk-version.json')).version;
    const embed = await readFile(path.join(ROOT, 'js/embed.js'), 'utf8');
    // Primary: the unpkg import URL. Fallback: the TS-SDK-VERSION marker comment — it survives
    // switching the import to the self-hosted /vendor/ URL (see scripts/vendor-sdk.mjs).
    const m = embed.match(/visual-embed-sdk@(\d+\.\d+\.\d+)/) || embed.match(/TS-SDK-VERSION:\s*(\d+\.\d+\.\d+)/);
    const embedVersion = m ? m[1] : null;
    if (!embedVersion) {
      result.pinConsistent = false;
      result.integrityErrors.push('No SDK version found in js/embed.js (neither the unpkg URL nor a "TS-SDK-VERSION: x.y.z" marker).');
    } else if (embedVersion !== pin) {
      result.pinConsistent = false;
      result.integrityErrors.push(`Pin drift: ts-sdk-version.json=${pin} but js/embed.js=${embedVersion}. Reconcile before anything else.`);
    }
    result.sdk.pinnedVersion = pin;
  } catch (e) {
    result.pinConsistent = false;
    result.integrityErrors.push('Cannot read the SDK pin: ' + e.message);
  }

  // ---- watermark (integrity: the diff baseline must be readable) -------------
  let watermark = null;
  try {
    watermark = await readJson('docs/.ts-watch.json');
  } catch (e) {
    result.integrityErrors.push('Cannot read docs/.ts-watch.json watermark: ' + e.message);
  }

  // ---- 2. npm latest (soft) ---------------------------------------------------
  if (pin) {
    try {
      const r = await fetchText(`https://registry.npmjs.org/${NPM_PKG}`);
      if (r.ok) {
        const reg = JSON.parse(r.text);
        const latest = reg['dist-tags']?.latest;
        result.sdk.npmLatest = latest;
        if (latest && !RELEASE_RE.test(latest)) {
          // semverCmp cannot rank prereleases — surface it for a human/agent decision instead.
          result.changes.push(`SDK: npm dist-tags.latest is '${latest}' (not plain x.y.z) — review manually`);
        } else if (latest && semverCmp(latest, pin) > 0) {
          const newer = Object.keys(reg.time || {})
            .filter((v) => RELEASE_RE.test(v) && semverCmp(v, pin) > 0)
            .sort(semverCmp)
            .map((v) => `${v} (${(reg.time[v] || '').slice(0, 10)})`);
          result.sdk.newerVersions = newer;
          result.changes.push(`SDK: pinned ${pin} → npm latest ${latest}${newer.length ? ` (${newer.length} newer: ${newer.join(', ')})` : ''}`);
        }
      } else {
        result.warnings.push(`npm registry returned ${r.status} — SDK check skipped this run`);
      }
    } catch (e) {
      result.warnings.push('npm check failed: ' + e.message);
    }
  }

  // ---- 3. GitHub releases (soft) ----------------------------------------------
  if (pin) {
    try {
      const r = await fetchText('https://api.github.com/repos/thoughtspot/visual-embed-sdk/releases?per_page=10');
      if (r.ok) {
        const releases = JSON.parse(r.text);
        const lastProcessed = (watermark?.sdk?.lastProcessedGithubRelease || `v${pin}`).replace(/^v/, '');
        const fresh = releases
          .map((rel) => (rel.tag_name || '').replace(/^v/, ''))
          .filter((t) => RELEASE_RE.test(t) && semverCmp(t, lastProcessed) > 0);
        result.sdk.newGithubReleases = fresh;
        if (fresh.length) result.changes.push(`GitHub: ${fresh.length} release(s) newer than v${lastProcessed}: ${fresh.join(', ')}`);
      } else if (r.status === 403 || r.status === 429) {
        result.warnings.push(`GitHub releases rate-limited (${r.status}) — skipped this run`);
      } else {
        result.warnings.push(`GitHub releases returned ${r.status} — skipped this run`);
      }
    } catch (e) {
      result.warnings.push('GitHub check failed: ' + e.message);
    }
  }

  // ---- 4. watched doc pages (soft per-URL) -------------------------------------
  const watched = watermark?.releaseNotes?.watchedUrls || [];
  const knownHashes = watermark?.releaseNotes?.contentHashes || {};
  if (watermark && watched.length === 0) {
    result.warnings.push('watchedUrls is EMPTY — doc monitoring is effectively disabled; restore at least one URL');
  }
  for (const url of watched) {
    try {
      const r = await fetchText(url);
      // Only a GONE page is drift. A 5xx/429/403 is the doc host having a bad minute — treating it
      // as a change turns every transient blip into exit 10 and sends the routine off to write a PR
      // about nothing. Soft-fail those as warnings, exactly as the npm/GitHub branches above do.
      if (!r.ok) {
        const moved = r.status === 404 || r.status === 410;
        result.docs[url] = { status: r.status, moved };
        if (moved) {
          result.changes.push(`DOC ${r.status} (moved? WebSearch for the successor page): ${url}`);
        } else {
          result.warnings.push(`doc fetch returned ${r.status} (${url}) — skipped this run`);
        }
        continue;
      }
      const h = contentHash(r.text);
      const prev = knownHashes[url];
      result.docs[url] = { status: 200, changed: prev !== h, hash: h };
      if (prev && prev !== h) result.changes.push(`DOC changed: ${url}`);
      else if (!prev) result.changes.push(`DOC new (no baseline hash yet): ${url}`);
    } catch (e) {
      result.docs[url] = { error: e.message };
      result.warnings.push(`doc fetch failed (${url}): ${e.message} — skipped this run`);
    }
  }

  // ---- report -------------------------------------------------------------------
  const out = [];
  out.push('ts-watch detector');
  out.push('=================');
  if (result.sdk.pinnedVersion) {
    out.push(`pin (ts-sdk-version.json): ${result.sdk.pinnedVersion}` + (result.pinConsistent ? '  ✓ consistent with js/embed.js' : '  ✗ INCONSISTENT'));
  }
  if (result.sdk.npmLatest) out.push(`npm latest: ${result.sdk.npmLatest}`);
  out.push('');
  if (result.changes.length) {
    out.push(`CHANGES DETECTED (${result.changes.length}):`);
    result.changes.forEach((c) => out.push('  • ' + c));
  } else {
    out.push('No changes detected.');
  }
  if (result.warnings.length) {
    out.push('');
    out.push(`Warnings (${result.warnings.length}) — non-fatal, do not affect the exit code:`);
    result.warnings.forEach((w) => out.push('  ~ ' + w));
  }
  if (result.integrityErrors.length) {
    out.push('');
    out.push(`INTEGRITY ERRORS (${result.integrityErrors.length}) — fix these before trusting any result:`);
    result.integrityErrors.forEach((e) => out.push('  ! ' + e));
  }

  console.log(out.join('\n'));
  if (WANT_JSON) console.log('\n---JSON---\n' + JSON.stringify(result, null, 2));

  // Exit-code contract: integrity beats everything; changes beat quiet; warnings never matter.
  if (result.integrityErrors.length) return 1;
  if (result.changes.length) return 10;
  return 0;
}

export { main };

// Run only when invoked as a script — importing this module (the unit test does) must not fetch.
//
// Both sides are realpath'd. Node resolves symlinks for the ESM module path in import.meta.url but
// NOT for process.argv[1], so a symlinked invocation (`node /some/link/check-ts-updates.mjs`, or a
// checkout reached through a symlinked directory) makes the two disagree — and the failure mode is
// the worst one available: the script does nothing, main() never runs, and the process exits 0.
// The weekly routine reads that as "no drift" and the detector goes quietly blind. Fail OPEN to
// running if realpath throws: a spurious run is harmless, a spurious skip is undetectable.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('ts-watch detector crashed:', e);
    process.exit(1);
  });
}
