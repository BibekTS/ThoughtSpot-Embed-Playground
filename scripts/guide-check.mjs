#!/usr/bin/env node
/**
 * guide-check — the gate for docs/tse-best-practices.html (the TSE best-practices guide).
 *
 * The guide is a single self-contained HTML page with its own inline JS (scenario picker, steppers,
 * wizards, checklists, the runtime-filter simulator, the auto-built feature index). Nothing else
 * exercises that JS, so this loads the file in headless Chrome and fails on:
 *   - any page error or console error (external font requests are stubbed, so no network needed)
 *   - malformed #guide-meta (version, lastUpdated, verifiedAgainst, changelog head must agree)
 *   - a section without a unique id, an <h2>, or a valid data-verified date
 *   - duplicate ids, or an in-page #link that points nowhere
 *   - a source link or feature badge whose source is not developers.thoughtspot.com
 *   - an interactive widget that does not render or throws when clicked
 *   - horizontal page scroll at phone width (390px)
 * Stale sections (data-verified older than meta.staleAfterDays) are reported as WARNINGS — the
 * docs-curator re-verifies them; they do not fail the gate.
 *
 * Opens the file directly (file://) — binds no port, so it is safe to run alongside the other gates.
 * Chrome resolution matches boot-check: $CHROME_PATH, then the standard install locations.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'tse-best-practices.html'));
const DOCS = 'https://developers.thoughtspot.com/';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) { console.error('guide-check: no Chrome binary found — set CHROME_PATH.'); process.exit(1); }
if (!existsSync(FILE)) { console.error(`guide-check: ${FILE} not found`); process.exit(1); }

const failures = [];
const warnings = [];
const fail = (m) => failures.push(m);
const watchdog = setTimeout(() => { console.error('guide-check: timed out'); process.exit(1); }, 90_000);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
    // Stub external fonts/styles so the gate is hermetic; anything else external is a finding.
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    errors.push(`unexpected external request: ${u}`);
    return r.respond({ status: 204, body: '' });
  });

  await page.goto(pathToFileURL(FILE).href, { waitUntil: 'load' });

  // ---- static structure ----
  const report = await page.evaluate((DOCS) => {
    const out = { errs: [], warns: [], meta: null };
    const $$ = (s) => [...document.querySelectorAll(s)];
    let meta;
    try { meta = JSON.parse(document.getElementById('guide-meta').textContent); out.meta = meta; }
    catch (e) { out.errs.push(`#guide-meta is not valid JSON: ${e.message}`); return out; }
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!/^\d+\.\d+\.\d+$/.test(meta.version || '')) out.errs.push(`meta.version "${meta.version}" is not semver`);
    if (!iso.test(meta.lastUpdated || '')) out.errs.push(`meta.lastUpdated "${meta.lastUpdated}" is not YYYY-MM-DD`);
    if (Date.parse(meta.lastUpdated) > Date.now() + 864e5) out.errs.push('meta.lastUpdated is in the future');
    if (!meta.verifiedAgainst?.sdk || !meta.verifiedAgainst?.thoughtspot) out.errs.push('meta.verifiedAgainst needs sdk and thoughtspot');
    const head = meta.changelog?.[0];
    if (!head) out.errs.push('meta.changelog is empty');
    else {
      if (head.version !== meta.version) out.errs.push(`changelog[0].version ${head.version} ≠ meta.version ${meta.version}`);
      if (head.date !== meta.lastUpdated) out.errs.push(`changelog[0].date ${head.date} ≠ meta.lastUpdated ${meta.lastUpdated}`);
      if (!head.summary || /__/.test(head.summary)) out.errs.push('changelog[0].summary is missing or still a placeholder');
    }
    if (/__[A-Z_]+__/.test(document.getElementById('guide-meta').textContent)) out.errs.push('#guide-meta still has __PLACEHOLDER__ values');

    const staleMs = (meta.staleAfterDays || 90) * 864e5;
    const secs = $$('section.sec');
    if (secs.length < 5) out.errs.push(`only ${secs.length} sections found`);
    const secIds = new Set();
    secs.forEach((s) => {
      if (!s.id) out.errs.push('a section.sec has no id');
      if (secIds.has(s.id)) out.errs.push(`duplicate section id ${s.id}`);
      secIds.add(s.id);
      if (!s.querySelector('h2')) out.errs.push(`section #${s.id} has no <h2>`);
      const v = s.dataset.verified;
      if (!iso.test(v || '')) out.errs.push(`section #${s.id} has no valid data-verified`);
      else if (Date.now() - Date.parse(v) > staleMs) out.warns.push(`section #${s.id} last verified ${v} (older than ${meta.staleAfterDays || 90} days)`);
    });

    const ids = new Map();
    $$('[id]').forEach((n) => ids.set(n.id, (ids.get(n.id) || 0) + 1));
    ids.forEach((c, id) => { if (c > 1) out.errs.push(`duplicate id "${id}" ×${c}`); });
    $$('a[href^="#"]').forEach((a) => {
      const t = a.getAttribute('href').slice(1);
      if (t && !document.getElementById(t)) out.errs.push(`broken in-page link #${t} ("${a.textContent.trim().slice(0, 40)}")`);
    });
    $$('a.src').forEach((a) => { if (!a.href.startsWith(DOCS)) out.errs.push(`source link not on ${DOCS}: ${a.href}`); });
    $$('.badge[data-feature]').forEach((b) => {
      if (!b.dataset.src) out.errs.push(`feature badge "${b.dataset.feature}" has no data-src`);
      else if (!b.dataset.src.startsWith(DOCS)) out.errs.push(`feature badge "${b.dataset.feature}" source not on ${DOCS}`);
    });
    $$('.badge.beta, .badge.ea, .badge.deprecated').forEach((b) => {
      const host = b.closest('tr, .card, .callout') || b.closest('li, p, h3, h4, div');
      if (!b.dataset.src && !host?.querySelector('a.src')) out.warns.push(`${b.className.replace('badge ', '')} badge without a nearby source: "${(host?.textContent || '').trim().slice(0, 60)}"`);
    });
    if (document.getElementById('foot-updated')?.textContent.trim() === '—') out.errs.push('footer "Last updated" did not render');
    if (document.getElementById('feature-index') && !document.querySelector('#feature-index tbody tr')) out.errs.push('feature status index rendered no rows');
    if (!document.querySelector('#nav a')) out.errs.push('sidebar nav did not render');
    $$('.wizard').forEach((w, i) => { if (!w.querySelector('.wz-opts button')) out.errs.push(`wizard #${i} rendered no options`); });
    $$('.stepper').forEach((s, i) => { if (!s.querySelector('.stepper-bar')) out.errs.push(`stepper #${i} rendered no controls`); });
    $$('.checklist-box').forEach((c) => { if (!c.querySelector('.checklist-head')) out.errs.push(`checklist ${c.dataset.checklist} did not render`); });
    out.counts = {
      sections: secs.length, wizards: $$('.wizard').length, steppers: $$('.stepper').length, checklists: $$('.checklist-box').length,
      quizzes: $$('.quiz').length, sources: $$('a.src').length, beta: $$('.badge.beta').length, ea: $$('.badge.ea').length,
      deprecated: $$('.badge.deprecated').length, features: $$('#feature-index tbody tr').length,
    };
    return out;
  }, DOCS);
  report.errs.forEach(fail);
  warnings.push(...report.warns);

  // ---- exercise every widget (a widget that never wired up must be reported, not crash the gate) ----
  await page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    for (const b of document.querySelectorAll('.scenario-btn')) { b.click(); await tick(); }
    document.querySelector('.scenario-btn[aria-pressed="true"]')?.click();
    for (const w of document.querySelectorAll('.wizard')) {
      for (let depth = 0; depth < 8; depth++) { const o = w.querySelector('.wz-opts button'); if (!o) break; o.click(); await tick(); }
      w.querySelector('.wz-reset')?.click();
    }
    for (const s of document.querySelectorAll('.stepper')) {
      const [prev, next, , all] = s.querySelectorAll('.stepper-bar button');
      if (!next) continue; // already reported as "rendered no controls"
      for (let i = 0; i < 12; i++) next.click();
      prev.click(); all.click();
    }
    document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.click());
    document.querySelectorAll('.sim-actions button').forEach((b) => b.click());
    document.querySelectorAll('.quiz .opts button').forEach((b) => b.click());
    document.querySelectorAll('.layer').forEach((b) => b.click());
    document.querySelectorAll('#feature-filter button').forEach((b) => b.click());
    const cb = document.querySelector('.checklist input'); if (cb) { cb.click(); cb.click(); }
    document.getElementById('theme-btn')?.click(); document.getElementById('theme-btn')?.click();
    document.getElementById('beta-btn')?.click();
    const si = document.getElementById('search'); if (si) { si.value = 'runtime filter'; si.dispatchEvent(new Event('input')); }
  }).catch((e) => fail(`exercising widgets threw: ${e.message.split('\n')[0]}`));
  const searchHits = await page.$$eval('#search-results a', (a) => a.length);
  if (!searchHits) fail('search for "runtime filter" returned nothing');

  // ---- phone width: no horizontal page scroll ----
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 100));
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w + 1) return null;
    const culprits = [...document.querySelectorAll('main *')].filter((n) => {
      const r = n.getBoundingClientRect(); return r.right > w + 1 && !n.closest('.fig-box, .table-wrap, pre, .tabs [role="tablist"]');
    }).slice(0, 5).map((n) => `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${[...n.classList].join('.')}`);
    return `${document.documentElement.scrollWidth}px > ${w}px (${culprits.join(', ')})`;
  });
  if (overflow) fail(`horizontal page scroll at 390px: ${overflow}`);

  errors.forEach(fail);

  const c = report.counts || {};
  console.log(`guide-check: ${path.relative(ROOT, FILE)} — v${report.meta?.version} · last updated ${report.meta?.lastUpdated} · `
    + `checked against SDK ${report.meta?.verifiedAgainst?.sdk} / ${report.meta?.verifiedAgainst?.thoughtspot}`);
  console.log(`  ${c.sections} sections · ${c.wizards} wizards · ${c.steppers} steppers · ${c.checklists} checklists · ${c.quizzes} quizzes · `
    + `${c.sources} source links · badges: ${c.beta} beta, ${c.ea} early access, ${c.deprecated} deprecated · feature index ${c.features} rows`);
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  if (failures.length) {
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    console.error(`guide-check: FAILED (${failures.length})`);
    process.exitCode = 1;
  } else {
    console.log('guide-check: OK');
  }
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
