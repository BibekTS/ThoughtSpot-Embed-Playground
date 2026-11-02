#!/usr/bin/env node
// Inspect the DOM inside a real ThoughtSpot embed, headless, so rules_UNSTABLE selectors come from
// what ThoughtSpot actually renders. Needs `npm start` running on :3000 (it mints the login token).
//
//   node inspect.mjs '<playground link>' find '<query>'      [--shot out.png]
//   node inspect.mjs '<playground link>' tree '<selector>'   [--up 14] [--down 3] [--nth 0]
//   node inspect.mjs '<playground link>' measure '<selector>' [--tile '<selector>']
//
// find    : <query> is a CSS selector, or `text:<words>` to match visible text. Prints every match's
//           tag, data-testid, classes, layout styles and width, plus a suggested stable selector.
// tree    : ancestors of the nth match (up to --up levels) and its descendants (--down levels),
//           with the box-model and flex/alignment values that explain where it sits.
// measure : for each match, the horizontal offset of its text from the center of its tile
//           (closest --tile ancestor, default a Liveboard grid item). 0px = centered.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const [link, mode, query, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
if (!link || !['find', 'tree', 'measure'].includes(mode) || !query) {
  console.error("usage: inspect.mjs '<link>' find|tree|measure '<selector | text:words>' [--shot f.png] [--up N] [--down N] [--nth N] [--tile sel] [--wait ms]");
  process.exit(2);
}
const ORIGIN = new URL(link).origin;
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_PATH.'); process.exit(2); }

// The host comes from the link itself, so the login targets the same cluster the embed renders.
const state = JSON.parse(Buffer.from(link.split('#s=')[1], 'base64url').toString('utf8'));
const HOST = String(state.host || '').replace(/\/$/, '');
if (!/^https:\/\//.test(HOST)) { console.error('Link has no https host.'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  // The embed iframe is third-party; headless Chrome blocks its cookies by default.
  args: ['--disable-features=TrackingProtection3pcd,ThirdPartyStoragePartitioning', '--test-third-party-cookie-phaseout=false'],
});
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(opt('width', 1600)), height: Number(opt('height', 1000)) });

  // 1. Log this browser into ThoughtSpot, like a user who is already signed in. A trusted-auth link
  //    opened with no session stops at "Embed session not authenticated" (connect probes first).
  const mint = await fetch(`${ORIGIN}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: state.auth?.username || '' }) });
  if (!mint.ok) throw new Error(`token mint failed: HTTP ${mint.status} (is npm start running, is the user allowlisted?)`);
  const t = await mint.json();
  await page.goto(`${HOST}/callosum/v1/session/login/token?username=${encodeURIComponent(t.valid_for_username)}&auth_token=${encodeURIComponent(t.token)}&redirect_url=${encodeURIComponent(HOST + '/')}`,
    { waitUntil: 'networkidle2', timeout: 60_000 });

  // 2. Open the link, accept the "connect to this host?" prompt, wait for the embed to settle.
  page.on('pageerror', e => errors.push(`page: ${e.message}`));
  page.on('console', m => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(`console: ${m.text().slice(0, 200)}`));
  await page.goto(link, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.evaluate(() => document.getElementById('confirm-host-go')?.click());
  let frame;
  for (let i = 0; i < 60 && !frame; i++) {
    await new Promise(r => setTimeout(r, 1000));
    frame = page.frames().find(f => f.url().startsWith(HOST));
  }
  if (!frame) throw new Error('ThoughtSpot iframe never loaded — check the overlay in --shot.');
  await new Promise(r => setTimeout(r, Number(opt('wait', 15_000)))); // let tiles render

  // 3. Inspect inside the iframe.
  const out = await frame.evaluate((mode, query, o) => {
    const describe = (e) => {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      const cls = [...e.classList].join('.');
      return `${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${e.dataset.testid ? ` [data-testid="${e.dataset.testid}"]` : ''}`
        + ` | ${cs.display}${cs.display.includes('flex') ? ` dir=${cs.flexDirection} justify=${cs.justifyContent} align=${cs.alignItems}` : ''}`
        + ` text-align=${cs.textAlign} pad=${cs.paddingLeft}/${cs.paddingRight} margin=${cs.marginLeft}/${cs.marginRight} x=${r.x | 0} w=${r.width | 0}`
        + (e.children.length ? '' : ` "${e.textContent.trim().slice(0, 30)}"`);
    };
    // Prefer data-testid, then hash-free CSS-module class fragments (e.g. kpi-module__hero → [class*="hero"]).
    const suggest = (e) => e.dataset.testid ? `[data-testid="${e.dataset.testid}"]`
      : ([...e.classList].map(c => c.split('__')[1]).find(Boolean) ? `[class*="${[...e.classList].map(c => c.split('__')[1]).find(Boolean)}"]` : e.tagName.toLowerCase());
    const matches = query.startsWith('text:')
      ? [...document.querySelectorAll('body *')].filter(e => !e.children.length && e.textContent.includes(query.slice(5)))
      : [...document.querySelectorAll(query)];
    if (!matches.length) return [`no match for ${query}`];
    if (mode === 'find') return matches.slice(0, 40).map((e, i) => `#${i} ${describe(e)}\n    suggested selector: ${suggest(e)}`);
    if (mode === 'tree') {
      const e = matches[Number(o.nth)] || matches[0], lines = [];
      const ups = []; for (let p = e.parentElement, i = 1; p && i <= Number(o.up); p = p.parentElement, i++) ups.push(`up ${i}: ${describe(p)}`);
      lines.push(...ups.reverse(), `>> ${describe(e)}`);
      const down = (n, d) => [...n.children].forEach(c => { lines.push(`${'   '.repeat(d)}└ ${describe(c)}`); if (d < Number(o.down)) down(c, d + 1); });
      down(e, 1);
      return lines;
    }
    return matches.map((e) => { // measure
      const tile = e.closest(o.tile) || document.body, tr = tile.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(e); const b = range.getBoundingClientRect();
      return `tile w=${tr.width | 0} | "${e.textContent.trim().slice(0, 24)}" center offset=${(b.x + b.width / 2 - (tr.x + tr.width / 2)).toFixed(1)}px left gap=${(b.x - tr.x) | 0} right gap=${(tr.right - b.right) | 0}`;
    });
  }, mode, query, { up: opt('up', 14), down: opt('down', 3), nth: opt('nth', 0), tile: opt('tile', '[data-testid="layout-item"], .react-grid-item') });
  console.log(out.join('\n'));
  if (opt('shot')) { await page.screenshot({ path: opt('shot') }); console.log(`screenshot: ${opt('shot')}`); }
} finally {
  console.log(`JS errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
  await browser.close();
}
