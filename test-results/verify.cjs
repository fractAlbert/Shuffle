// Verification driver (test tooling, not app code). See plan section 6 of issue #1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { execSync } = require('child_process');
const { chromium } = require(process.env.PW_DIR);

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'test-results');
const PAGE_URL = url.pathToFileURL(path.resolve('index.html')).href;
const BASE = '145a7ae323c788800cdc0643eccc5d73fabf4c58';
const lines = [];
const errors = [];
let failed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };

const board = (page) => page.$$eval('#board .tile', (els) => els.map((e) => (e.classList.contains('empty') ? '_' : e.textContent.trim())));
const movesOf = async (page) => Number((await page.textContent('#moves')).match(/\d+/)[0]);
const timerOf = async (page) => Number((await page.textContent('#timer')).match(/(\d+)s/)[1]);
const click = (page, i) => page.click(`#board .tile[data-index="${i}"]`);
const SOLVED = ['1', '2', '3', '4', '5', '6', '7', '8', '_'];
const shot = (page, dir, name = 'screenshot.png') => page.screenshot({ path: path.join(dir, name) });

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const tmpVideo = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-video-'));

  async function newPage(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(PAGE_URL);
    return { ctx, page };
  }

  async function run(name, fn, { video = false } = {}) {
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const log = [];
    const say = (s) => log.push(s);
    let ctx, page;
    try {
      ({ ctx, page } = await newPage(video ? { recordVideo: { dir: tmpVideo, size: { width: 1280, height: 800 } } } : {}));
      await fn({ page, dir, say });
      lines.push(`PASS ${name}`);
    } catch (e) {
      failed = true;
      lines.push(`FAIL ${name}: ${e.message}`);
    } finally {
      if (page) { try { await shot(page, dir); } catch (_) {} }
      const vid = page && video ? page.video() : null;
      if (ctx) await ctx.close();
      if (vid) fs.copyFileSync(await vid.path(), path.join(dir, 'video.webm'));
      fs.writeFileSync(path.join(dir, 'output.txt'), log.join('\n') + '\n');
    }
  }

  // single-file: AC1
  await run('single-file', async ({ say }) => {
    const sh = (c) => execSync(c, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const changed = new Set([
      ...sh(`git diff --name-only ${BASE}...HEAD`),
      ...sh('git diff --name-only HEAD'),
      ...sh('git diff --name-only --cached'),
      ...sh('git ls-files --others --exclude-standard'),
    ]);
    say('changed set: ' + [...changed].join(', '));
    const bad = [...changed].filter((f) => f !== 'index.html' && !f.startsWith('test-results/'));
    eq(bad, [], 'files outside index.html and test-results/**');
    ok(changed.has('index.html'), 'index.html not in change set');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const pats = { 'src=': /src=/, 'href= (not #)': /href=(?!["']#)/, '@import': /@import/, 'url(': /url\(/, 'type="module"': /type="module"/, 'fetch(': /fetch\(/, XMLHttpRequest: /XMLHttpRequest/ };
    for (const [k, re] of Object.entries(pats)) {
      const n = (html.match(new RegExp(re.source, 'g')) || []).length;
      say(`grep ${k}: ${n} matches`);
      eq(n, 0, `grep ${k}`);
    }
  });

  // title: AC2
  await run('title', async ({ page, say }) => {
    eq((await page.textContent('h1')).trim(), 'Shuffle', 'h1 text');
    const h = await page.locator('h1').first().boundingBox();
    const b = await page.locator('#board').boundingBox();
    say(`h1 bottom ${h.y + h.height}, board top ${b.y}`);
    ok(h.y + h.height <= b.y, 'h1 not above board');
  });

  // initial-board: AC3, AC8
  await run('initial-board', async ({ page, say }) => {
    eq(await board(page), SOLVED, 'initial board');
    const boxes = await page.$$eval('#board .tile', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
    eq(new Set(boxes.map((b) => b[0])).size, 3, 'column count');
    eq(new Set(boxes.map((b) => b[1])).size, 3, 'row count');
    eq(await page.$$eval('#board .tile.empty', (e) => e.length), 1, 'empty count');
    say('board ' + JSON.stringify(await board(page)));
  });

  await run('slide-adjacent', async ({ page, say }) => {
    await click(page, 7);
    eq(await board(page), ['1', '2', '3', '4', '5', '6', '7', '_', '8'], 'after click 1');
    eq(await movesOf(page), 1, 'moves 1');
    await click(page, 4);
    eq(await board(page), ['1', '2', '3', '4', '_', '6', '7', '5', '8'], 'after click 2');
    eq(await movesOf(page), 2, 'moves 2');
    say('ok');
  });

  await run('slide-nonadjacent', async ({ page, say }) => {
    for (const i of [0, 2, 8]) await click(page, i);
    eq(await board(page), SOLVED, 'board');
    eq(await movesOf(page), 0, 'moves');
    await sleep(1500);
    eq(await timerOf(page), 0, 'timer');
    say('ok');
  });

  await run('slide-row-wrap', async ({ page, say }) => {
    for (const i of [5, 4, 3]) await click(page, i);
    eq(await board(page), ['1', '2', '3', '_', '4', '5', '7', '8', '6'], 'after 3 moves');
    eq(await movesOf(page), 3, 'moves 3');
    await click(page, 2);
    eq(await board(page), ['1', '2', '3', '_', '4', '5', '7', '8', '6'], 'after wrap click');
    eq(await movesOf(page), 3, 'moves still 3');
    say('ok');
  });

  await run('slide-sequence', async ({ page, say }) => {
    for (const i of [7, 4, 7, 8]) { await click(page, i); say(`click ${i}: ${JSON.stringify(await board(page))}`); await sleep(400); }
    eq(await board(page), SOLVED, 'final board');
    eq(await movesOf(page), 4, 'moves');
  }, { video: true });

  await run('double-click', async ({ page, say }) => {
    await page.dblclick('#board .tile[data-index="7"]');
    eq(await board(page), ['1', '2', '3', '4', '5', '6', '7', '_', '8'], 'board');
    eq(await movesOf(page), 1, 'moves');
    say('ok');
  });

  await run('shuffle', async ({ page, say }) => {
    const seen = new Set();
    const perm = (b) => [...b].map((x) => (x === '_' ? 0 : Number(x))).sort((a, c) => a - c).join() === '0,1,2,3,4,5,6,7,8';
    for (let n = 0; n < 20; n++) {
      await page.click('#shuffle');
      const b = await board(page);
      ok(perm(b), 'not a permutation: ' + b);
      seen.add(b.join(','));
      eq(await movesOf(page), 0, 'moves after shuffle');
      eq(await timerOf(page), 0, 'timer after shuffle');
      const solved = b.join(',') === SOLVED.join(',');
      if (!solved) ok(!(await page.isVisible('#message')), 'message visible on unsolved board');
    }
    ok(seen.size >= 2, 'fewer than 2 distinct boards in 20 clicks');
    const extra = await page.evaluate(() => { const out = []; for (let i = 0; i < 500; i++) { shuffle(); out.push(tiles.slice()); } return out; });
    ok(extra.every((t) => [...t].sort((a, c) => a - c).join() === '0,1,2,3,4,5,6,7,8'), 'extra sample not permutation');
    const distinct = new Set(extra.map((t) => t.join(','))).size;
    ok(distinct >= 2, 'extra samples not distinct');
    say(`20 clicks distinct: ${seen.size}; 500 samples distinct: ${distinct}`);
  });

  await run('move-counter', async ({ page, say }) => {
    let expected = 0;
    for (const [i, legal] of [[7, true], [0, false], [4, true], [8, false], [2, false], [5, true]]) {
      await click(page, i);
      if (legal) expected++;
      eq(await movesOf(page), expected, `moves after click ${i}`);
    }
    await page.click('#shuffle');
    eq(await movesOf(page), 0, 'moves after shuffle');
    say('ok');
  });

  await run('timer', async ({ page, say }) => {
    const moveAny = async () => {
      const e = (await board(page)).indexOf('_');
      const r = Math.floor(e / 3), c = e % 3;
      const nb = [];
      if (r > 0) nb.push(e - 3);
      if (r < 2) nb.push(e + 3);
      if (c > 0) nb.push(e - 1);
      if (c < 2) nb.push(e + 1);
      await click(page, nb[0]);
    };
    await sleep(2500);
    eq(await timerOf(page), 0, 'timer before first move');
    await moveAny(); await page.click('#shuffle');
    await moveAny(); await page.click('#shuffle');
    await moveAny();
    await sleep(3200);
    const t = await timerOf(page);
    say('timer after final wait: ' + t);
    ok(t >= 2 && t <= 4, `timer ${t}, expected 3 (+-1)`);
  }, { video: true });

  await run('win-message', async ({ page, dir, say }) => {
    const msg = page.locator('#message');
    ok(await msg.isVisible(), 'message not visible at load');
    eq((await msg.textContent()).trim(), 'You solved it!', 'text at load');
    await shot(page, dir, 'screenshot.png');
    await click(page, 7);
    ok(!(await msg.isVisible()), 'message visible after click 1');
    await shot(page, dir, 'screenshot-2.png');
    await click(page, 8);
    ok(await msg.isVisible(), 'message hidden after click 2');
    eq((await msg.textContent()).trim(), 'You solved it!', 'text after click 2');
    await shot(page, dir, 'screenshot-3.png');
    say('ok');
  });

  await run('solve-timer', async ({ page, say }) => {
    await click(page, 7);
    await sleep(1200);
    await click(page, 8);
    const a = await timerOf(page);
    await sleep(2000);
    const b = await timerOf(page);
    say(`readings ${a}, ${b}`);
    eq(b, a, 'timer readings');
  });

  await run('layout', async ({ page, dir, say }) => {
    for (const [w, h, shotName] of [[1280, 800, 'screenshot.png'], [390, 844, 'screenshot-mobile.png']]) {
      await page.setViewportSize({ width: w, height: h });
      const m = await page.evaluate(() => {
        const bx = document.getElementById('board').getBoundingClientRect();
        const tiles = [...document.querySelectorAll('.tile')].map((t) => { const r = t.getBoundingClientRect(); return [r.width, r.height]; });
        const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
        return { left: bx.left, right: window.innerWidth - bx.right, tiles, emptyBg: bg('.tile.empty'), tileBg: bg('.tile:not(.empty)'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
      });
      say(`${w}x${h}: ${JSON.stringify(m)}`);
      ok(Math.abs(m.left - m.right) <= 2, `${w}: margins ${m.left} vs ${m.right}`);
      ok(m.tiles.every(([tw, th]) => Math.abs(tw - th) <= 1), `${w}: tiles not square`);
      ok(m.emptyBg !== m.tileBg, `${w}: empty bg equals tile bg`);
      ok(m.sw <= m.cw, `${w}: horizontal scroll`);
      await shot(page, dir, shotName);
    }
  });

  await run('code-shape', async ({ say }) => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const f of ['render', 'move', 'shuffle', 'checkWin']) {
      const re = new RegExp('//[^\\n]*\\r?\\n\\s*function ' + f + '\\b');
      ok(re.test(html), `function ${f} missing or has no comment above`);
      say(`function ${f}: present with comment`);
    }
  });

  await run('console', async ({ say }) => {
    say(`errors collected: ${errors.length}`);
    errors.forEach((e) => say(e));
    eq(errors, [], 'runtime errors');
  });

  await browser.close();
  fs.rmSync(tmpVideo, { recursive: true, force: true });
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  fs.writeFileSync(path.join(OUT, 'verify-output.txt'), text);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
