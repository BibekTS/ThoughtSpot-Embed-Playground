#!/usr/bin/env node
// Inspect the DOM inside a real ThoughtSpot embed, headless: every embed frame (incl. nested
// custom-chart iframes) and open shadow roots. Modes find|tree|measure, --click/--hover steps:
// usage and output are documented in SKILL.md next to this file. Needs `npm start` on :3000 and
// only logs in to that server's own THOUGHTSPOT_HOST.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const [link, mode, query, ...rest] = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(2); };
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = rest[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`--${name} needs a value.`);
  return v;
};
// --click / --hover are repeatable and ordered, so collect them as a list of steps.
const steps = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--click' || rest[i] === '--hover') {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${rest[i]} needs a value.`);
    steps.push({ action: rest[i].slice(2), target: v }); i++;
  }
}
if (!link || !['find', 'tree', 'measure'].includes(mode) || !query) fail("usage: inspect.mjs '<link>' find|tree|measure '<selector | text:words>' [--click '<q>'] [--hover '<q>'] (repeatable, in order) [--step-wait ms] [--props a,b] [--shot f.png] [--up N] [--down N] [--nth N] [--tile sel] [--wait ms] [--server http://localhost:3000]");
// The token service is always the local server (--server), never the link's own origin: a link on
// another origin must not receive the mint request or be loaded with a live session.
const ORIGIN = new URL(opt('server', 'http://localhost:3000')).origin;
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(p => existsSync(p));
if (!CHROME) fail('No Chrome found; set CHROME_PATH.');

let state, linkUrl;
try {
  linkUrl = new URL(link);
  state = JSON.parse(Buffer.from(link.split('#s=')[1] || '', 'base64url').toString('utf8'));
} catch { fail('Not a playground link (expected http://localhost:3000/#s=…).'); }
if (!state || typeof state !== 'object') fail('Not a playground link (expected http://localhost:3000/#s=…).');
if (linkUrl.origin !== ORIGIN) fail(`Link origin ${linkUrl.origin} is not the playground server ${ORIGIN} (pass --server to change it).`);
let HOST;
try { HOST = new URL(state.host).origin; } catch { fail('Link has no valid ThoughtSpot host.'); }
if (!HOST.startsWith('https://')) fail('Link host must be https.');
for (const n of ['up', 'down', 'nth', 'wait', 'step-wait', 'width', 'height']) {
  if (opt(n) !== undefined && !/^\d+$/.test(opt(n))) fail(`--${n} must be a whole number.`);
}

// A shared link chooses its own host, so only log in to the cluster this server mints for. The
// script skips the playground's "connect to this host?" prompt, so this check stands in for it.
const cfgResp = await fetch(`${ORIGIN}/api/auth/config`).catch(() => null);
if (!cfgResp?.ok) fail(`Cannot reach ${ORIGIN}/api/auth/config — is npm start running?`);
const serverHost = (await cfgResp.json()).thoughtSpotHost;
let serverOrigin = '';
try { serverOrigin = new URL(serverHost).origin; } catch { /* reported below */ }
if (HOST !== serverOrigin) fail(`Link host ${HOST} is not the server's THOUGHTSPOT_HOST (${serverOrigin || 'unset'}); refusing to mint a token for it.`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  // The embed iframe is third-party; headless Chrome blocks its cookies by default. Site isolation is
  // off so nested cross-origin frames (custom charts) render in-process: with it on, headless
  // screenshots of those frames come back blank or stale (they showed a tooltip the DOM had removed).
  args: ['--disable-features=TrackingProtection3pcd,ThirdPartyStoragePartitioning,site-per-process,IsolateOrigins',
    '--disable-site-isolation-trials', '--test-third-party-cookie-phaseout=false'],
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
  try {
    await page.goto(`${HOST}/callosum/v1/session/login/token?username=${encodeURIComponent(t.valid_for_username)}&auth_token=${encodeURIComponent(t.token)}&redirect_url=${encodeURIComponent(HOST + '/')}`,
      { waitUntil: 'networkidle2', timeout: 60_000 });
  } catch (e) {
    // puppeteer errors quote the full URL; never let the token reach the terminal or a transcript.
    throw new Error(`ThoughtSpot token login failed: ${String(e.message).split(t.token).join('<redacted>').replace(/auth_token=[^&\s]+/g, 'auth_token=<redacted>')}`);
  }

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

  // 3. Inspect. Runs in every frame inside the embed: the ThoughtSpot iframe plus anything nested in
  //    it (custom charts), descending into open shadow roots (ThoughtSpot re-draws custom-chart
  //    tooltips in one). The same function also locates --click/--hover targets.
  const inEmbed = (f) => { for (let p = f; p; p = p.parentFrame()) if (p.url().startsWith(HOST)) return true; return false; };
  const frameLabel = (f) => (f.url().startsWith(HOST) ? 'ts' : (() => { try { return new URL(f.url()).host; } catch { return 'frame'; } })());
  const inFrame = (op, query, o) => {
    // Deep query: the document plus every open shadow root, recursively.
    const deepAll = (root, sel) => {
      const out = [...root.querySelectorAll(sel)];
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) out.push(...deepAll(e.shadowRoot, sel));
      return out;
    };
    const up = (e) => e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
    const LABEL_ATTRS = ['aria-label', 'title', 'alt', 'placeholder', 'data-tooltip'];
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pseudo = (e, p) => { const c = getComputedStyle(e, p).content; return c && c !== 'none' && c !== 'normal' ? c.slice(0, 40) : ''; };
    // Where an element's icon comes from — what you must override to change it.
    const icon = (e) => {
      const cs = getComputedStyle(e), bits = [];
      const use = e.tagName.toLowerCase() === 'svg' ? e.querySelector('use') : (e.tagName.toLowerCase() === 'use' ? e : null);
      if (use) bits.push(`svg-use=${use.getAttribute('href') || use.getAttribute('xlink:href')}`);
      else if (e.tagName.toLowerCase() === 'svg') bits.push(`inline-svg(${e.children.length} children)`);
      if (e.tagName === 'IMG') bits.push(`img=${(e.getAttribute('src') || '').slice(0, 60)}`);
      if (cs.backgroundImage !== 'none') bits.push(`bg-image=${cs.backgroundImage.slice(0, 60)}`);
      const mask = cs.maskImage || cs.webkitMaskImage; if (mask && mask !== 'none') bits.push(`mask=${mask.slice(0, 60)}`);
      const b = pseudo(e, '::before'), a = pseudo(e, '::after');
      if (b) bits.push(`::before=${b}`); if (a) bits.push(`::after=${a}`);
      return bits.length ? ` icon{${bits.join(' ')}}` : '';
    };
    const describe = (e) => {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      const cls = [...e.classList].join('.');
      const lab = LABEL_ATTRS.map(a => e.getAttribute(a) ? ` ${a}="${e.getAttribute(a).slice(0, 40)}"` : '').join('');
      const look = o.props ? ' ' + o.props.split(',').map(p => `${p.trim()}=${cs.getPropertyValue(p.trim())}`).join(' ')
        : ` color=${cs.color} bg=${cs.backgroundColor}${['svg', 'path', 'rect', 'text', 'tspan', 'circle', 'use'].includes(e.tagName.toLowerCase()) ? ` fill=${cs.fill}` : ''}`;
      return `${e.getRootNode() instanceof ShadowRoot ? '(shadow) ' : ''}${e.tagName.toLowerCase()}${cls ? '.' + cls : ''}${e.dataset?.testid ? ` [data-testid="${e.dataset.testid}"]` : ''}${lab}`
        + ` | ${cs.display}${cs.display.includes('flex') ? ` dir=${cs.flexDirection} justify=${cs.justifyContent} align=${cs.alignItems}` : ''}`
        + ` text-align=${cs.textAlign} pad=${cs.paddingLeft}/${cs.paddingRight} margin=${cs.marginLeft}/${cs.marginRight} x=${r.x | 0} y=${r.y | 0} w=${r.width | 0} h=${r.height | 0}`
        + look + icon(e)
        + (e.children.length ? '' : ` "${e.textContent.trim().slice(0, 30)}"`);
    };
    // Prefer data-testid on the element or its nearest ancestor (so an icon inside a test-hooked button
    // gets `[data-testid="x"] svg`), then a hash-free CSS-module fragment, then aria-label, then class.
    const cssStr = (v) => v.replace(/["\\]/g, '\\$&');
    const own = (e) => {
      if (e.dataset?.testid) return `[data-testid="${cssStr(e.dataset.testid)}"]`;
      const frag = [...e.classList].map(c => c.split('__')[1]).find(Boolean);
      if (frag) return `[class*="${frag}"]`;
      if (e.getAttribute('aria-label')) return `${e.tagName.toLowerCase()}[aria-label="${cssStr(e.getAttribute('aria-label'))}"]`;
      return '';
    };
    const suggest = (e) => {
      const mine = own(e); if (mine && e.dataset?.testid) return mine;
      for (let p = up(e), i = 0; p && i < 4; p = up(p), i++) if (p.dataset?.testid) return `[data-testid="${cssStr(p.dataset.testid)}"] ${mine || e.tagName.toLowerCase()}`;
      return mine || (e.classList[0] ? `.${e.classList[0]}` : e.tagName.toLowerCase());
    };
    let matches;
    if (query.startsWith('text:')) {
      // Own text node (catches SVG <tspan>/<text> and mixed content) or an accessible-label attribute.
      // '*', not 'body *': a shadow root has no <body>, and its copy of a tooltip must match too.
      const words = query.slice(5);
      matches = deepAll(document, '*').filter(e => !['STYLE', 'SCRIPT', 'TITLE', 'HEAD'].includes(e.tagName)
        && ([...e.childNodes].some(n => n.nodeType === 3 && n.textContent.includes(words))
          || LABEL_ATTRS.some(a => (e.getAttribute(a) || '').includes(words))));
    } else {
      try { matches = deepAll(document, query); } catch { return { error: `invalid selector: ${query}` }; }
    }
    if (op === 'locate') {
      // rank 0 = owns the text (what a user sees), rank 1 = only an aria-label/title hit. The caller
      // compares ranks across frames, so a chart's "…Southwest." aria-label never beats a real label.
      const ownsText = (e) => !query.startsWith('text:') || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.includes(query.slice(5)));
      const vis = matches.filter(visible);
      const e = vis.find(ownsText) || vis[0];
      if (!e) return { count: 0 };
      const r = e.getBoundingClientRect();
      return { count: 1, rank: ownsText(e) ? 0 : 1, x: r.x + r.width / 2, y: r.y + r.height / 2, what: describe(e).slice(0, 120) };
    }
    if (!matches.length) return { count: 0 };
    // Nearest ancestor test hooks: a generic hook on the element (e.g. every menu label's
    // "menu-item-label-testid") is useless for targeting ONE item; its row's "download" is not.
    const hooks = (e) => { const out = []; for (let p = up(e), i = 0; p && i < 8 && out.length < 3; p = up(p), i++) if (p.dataset?.testid) out.push(`[data-testid="${p.dataset.testid}"]`); return out.length ? `\n    ancestor hooks: ${out.join(' < ')}` : ''; };
    // Documented --ts-var-* variables that already style this element: ThoughtSpot's own rules that
    // match it and read a variable. If the property you want is here, set the variable (stable,
    // documented) instead of writing rules_UNSTABLE. CDN sheets that block cssRules are skipped.
    let varRules;
    const tsVars = (e) => {
      if (!varRules) {
        varRules = [];
        const walk = (list) => { for (const r of list) { if (r.selectorText) { if (r.cssText.includes('--ts-var-')) varRules.push(r); } else if (r.cssRules) walk(r.cssRules); } };
        for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { /* cross-origin sheet */ } }
      }
      const seen = new Map();
      for (const r of varRules) {
        let hit = false; try { hit = e.matches(r.selectorText); } catch { /* selector this browser rejects */ }
        if (!hit) continue;
        for (let i = 0; i < r.style.length; i++) {
          const prop = r.style[i];
          for (const m of r.style.getPropertyValue(prop).matchAll(/var\((--ts-var-[\w-]+)/g)) if (!seen.has(m[1])) seen.set(m[1], prop);
        }
      }
      return seen.size ? `\n    ts-vars: ${[...seen].slice(0, 10).map(([v, p]) => `${p}←${v}`).join('  ')}${seen.size > 10 ? `  (+${seen.size - 10} more)` : ''}` : '';
    };
    if (op === 'find') return { count: matches.length, lines: matches.slice(0, 40).map((e, i) => `#${i} ${visible(e) ? '' : '(not rendered) '}${describe(e)}\n    suggested selector: ${suggest(e)}${hooks(e)}${tsVars(e)}`) };
    if (op === 'tree') {
      const e = matches[Number(o.nth)] || matches[0], lines = [];
      const ups = []; for (let p = up(e), i = 1; p && i <= Number(o.up); p = up(p), i++) ups.push(`up ${i}: ${describe(p)}`);
      lines.push(...ups.reverse(), `>> ${describe(e)}`);
      const down = (n, d) => [...(n.shadowRoot ? n.shadowRoot.children : []), ...n.children].forEach(c => { lines.push(`${'   '.repeat(d)}└ ${describe(c)}`); if (d < Number(o.down)) down(c, d + 1); });
      down(e, 1);
      return { count: matches.length, lines };
    }
    let tileOk = true; try { document.querySelector(o.tile); } catch { tileOk = false; }
    if (!tileOk) return { error: `invalid --tile selector: ${o.tile}` };
    return { count: matches.length, lines: matches.map((e) => { // measure
      const tile = e.closest(o.tile) || document.body, tr = tile.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(e); const b = range.getBoundingClientRect();
      return `tile w=${tr.width | 0} | "${e.textContent.trim().slice(0, 24)}" center offset=${(b.x + b.width / 2 - (tr.x + tr.width / 2)).toFixed(1)}px left gap=${(b.x - tr.x) | 0} right gap=${(tr.right - b.right) | 0}`;
    }) };
  };
  const embedFrames = () => page.frames().filter(f => !f.isDetached() && inEmbed(f));
  const o = { up: opt('up', 14), down: opt('down', 3), nth: opt('nth', 0), props: opt('props', ''), tile: opt('tile', '[data-testid="layout-item"], .react-grid-item') };

  // 3a. --click / --hover steps, in order. Targets are searched in every embed frame; the first
  //     visible match wins. Frame coordinates are shifted to page coordinates for the real mouse.
  for (const s of steps) {
    let hit;
    for (const f of embedFrames()) {
      const r = await f.evaluate(inFrame, 'locate', s.target, o).catch(() => ({ count: 0 }));
      if (r.error) throw new Error(r.error);
      if (r.count && (!hit || r.rank < hit.r.rank)) hit = { f, r }; // best rank wins; frame order breaks ties
    }
    if (!hit) throw new Error(`--${s.action} target not found or not visible in any embed frame: ${s.target}`);
    let x = hit.r.x, y = hit.r.y;
    if (hit.f !== page.mainFrame()) { const box = await (await hit.f.frameElement()).boundingBox(); x += box.x; y += box.y; }
    await page.mouse.move(x, y, { steps: 8 });
    if (s.action === 'click') await page.mouse.click(x, y);
    await new Promise(r => setTimeout(r, Number(opt('step-wait', 2000))));
    console.log(`${s.action} ${s.target} → [${frameLabel(hit.f)}] ${hit.r.what}`);
  }

  // 3b. The query itself, in every embed frame.
  let found = 0;
  for (const f of embedFrames()) {
    const r = await f.evaluate(inFrame, mode, query, o).catch(e => ({ error: `${frameLabel(f)}: ${e.message}` }));
    if (r.error) { console.log(r.error); continue; }
    if (!r.count) continue;
    found += r.count;
    console.log(`── frame [${frameLabel(f)}] ${r.count} match(es)`);
    console.log(r.lines.join('\n'));
    if (mode === 'tree') break; // tree: the first frame with a match only
  }
  if (!found) console.log(`no match for ${query} in ${embedFrames().length} embed frame(s)`);
  if (opt('shot')) { await page.screenshot({ path: opt('shot') }); console.log(`screenshot: ${opt('shot')}`); }
} catch (e) {
  // One clean line instead of a stack. Login errors are already token-redacted above.
  console.error(`error: ${e.message}`);
  process.exitCode = 2;
} finally {
  console.log(`JS errors: ${errors.length ? '\n  ' + errors.join('\n  ') : 'none'}`);
  await browser.close();
}
