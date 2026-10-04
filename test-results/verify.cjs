// Verification driver (test tooling, not app code). See plan section 6 of issues #1, #2, #4, #5 and #7.
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { execSync, spawnSync } = require('child_process');
if (!process.env.PW_DIR) { console.error('Set PW_DIR to the playwright package directory (see plan section 6).'); process.exit(2); }
const { chromium } = require(process.env.PW_DIR);

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'test-results');
const PAGE_URL = url.pathToFileURL(path.resolve('index.html')).href;
// Change-set base for single-file and script-unchanged; requires a fresh `git fetch origin main` first.
const BASE = execSync('git merge-base origin/main HEAD', { encoding: 'utf8' }).trim();
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

// Shuffle oracles (#4 D5): the driver's own judges of solvability, never the app's isSolvable.
const solvedOf = (n) => [...Array(n - 1).keys()].map((i) => i + 1).concat(0);
// Every board reachable from solved by legal slides, as a Set of comma-joined strings.
function reachable(rows, cols) {
  const start = solvedOf(rows * cols);
  const seen = new Set([start.join()]);
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const b = queue[q];
    const e = b.indexOf(0), r = Math.floor(e / cols), c = e % cols;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const nb = b.slice(); const t = nr * cols + nc;
      [nb[e], nb[t]] = [nb[t], nb[e]];
      const k = nb.join();
      if (!seen.has(k)) { seen.add(k); queue.push(nb); }
    }
  }
  return seen;
}
// Permutation parity (empty counted as tile n) must equal the parity of the empty space's taxicab distance from bottom-right.
function oracleSolvable(arr, rows, cols) {
  const n = rows * cols;
  const p = arr.map((v) => (v === 0 ? n : v) - 1);
  const seen = new Array(n).fill(false);
  let transpositions = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = p[j]) { seen[j] = true; len++; }
    transpositions += len - 1;
  }
  const e = arr.indexOf(0);
  const dist = (rows - 1 - Math.floor(e / cols)) + (cols - 1 - (e % cols));
  return transpositions % 2 === dist % 2;
}
// A board made by `steps` random legal slides from solved.
function randomWalk(rows, cols, steps) {
  const b = solvedOf(rows * cols);
  let e = b.length - 1;
  for (let s = 0; s < steps; s++) {
    const r = Math.floor(e / cols), c = e % cols, nb = [];
    if (r > 0) nb.push(e - cols);
    if (r < rows - 1) nb.push(e + cols);
    if (c > 0) nb.push(e - 1);
    if (c < cols - 1) nb.push(e + 1);
    const t = nb[Math.floor(Math.random() * nb.length)];
    [b[e], b[t]] = [b[t], b[e]];
    e = t;
  }
  return b;
}
// Every ordering of 0..n-1.
function permutations(n) {
  const out = [], a = [...Array(n).keys()];
  const go = (k) => {
    if (k === n) { out.push(a.slice()); return; }
    for (let i = k; i < n; i++) { [a[k], a[i]] = [a[i], a[k]]; go(k + 1); [a[k], a[i]] = [a[i], a[k]]; }
  };
  go(0);
  return out;
}
// Look helpers (#7): size matrix, viewports, computed-colour and geometry readers.
const SIZES = [[3, 3], [3, 4], [4, 3], [6, 6], [3, 6], [6, 3]];
const VIEWS = [[1280, 800], [560, 800], [390, 844], [360, 740]];
const requests = [];
// Every opaque colour (rgb() or rgba(...,1)) in an element's computed background-color and background-image; translucent overlays are ignored.
const colours = (page, sel) => page.$eval(sel, (el) => {
  const cs = getComputedStyle(el);
  const out = [];
  for (const m of (cs.backgroundColor + ' ' + cs.backgroundImage).matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/g)) {
    if (m[4] === undefined || Number(m[4]) === 1) out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  return out;
});
const rgbOf = (str) => { const m = str.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/); return [Number(m[1]), Number(m[2]), Number(m[3])]; };
const rect = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });
const style = (page, sel, prop) => page.$eval(sel, (e, p) => getComputedStyle(e)[p], prop);
const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const inside = (a, b, tol = 0.5) => a.l >= b.l - tol && a.r <= b.r + tol && a.t >= b.t - tol && a.b <= b.b + tol;
const maxc = (c) => Math.max(...c);
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const isGreen = ([r, g, b]) => g > r + 20 && g > b + 20;
const nonVacuous = (list, what, say) => { say(`${what} colours: ${JSON.stringify(list)}`); ok(list.length >= 1, `${what}: no opaque colour found (vacuous)`); };
// Size helpers (#2): drive the real selects.
const setSizeUI = async (page, r, c) => { await page.selectOption('#rows', String(r)); await page.selectOption('#cols', String(c)); };
const solvedBoard = (n) => [...Array(n - 1).keys()].map((i) => String(i + 1)).concat('_');
const REACH3 = reachable(3, 3);
const SOLVED3 = solvedOf(9).join();

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const tmpVideo = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-video-'));

  async function newPage(opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
    const page = await ctx.newPage();
    page.on('request', (r) => requests.push(r.url()));
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(PAGE_URL);
    return { ctx, page };
  }

  async function run(name, fn, { video = false, shoot = true } = {}) {
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
      // Final-state screenshot only for UI checks, and never over a shot the check saved itself.
      if (page && shoot && !fs.existsSync(path.join(dir, 'screenshot.png'))) { try { await shot(page, dir); } catch (_) {} }
      const vid = page && video ? page.video() : null;
      if (ctx) await ctx.close();
      if (vid) fs.copyFileSync(await vid.path(), path.join(dir, 'video.webm'));
      fs.writeFileSync(path.join(dir, 'output.txt'), log.join('\n') + '\n');
    }
  }

  // title: AC2 (#7): white script title and instruction note printed on the frame
  await run('title', async ({ page, dir, say }) => {
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [r, c] of [[3, 3], [6, 6]]) {
        await setSizeUI(page, r, c);
        const tag = `${w}x${h} ${r}x${c}`;
        eq(await page.$$eval('h1', (e) => e.length), 1, tag + ' h1 count');
        eq((await page.textContent('h1')).trim(), 'Shuffle', tag + ' h1 text');
        ok(await page.$eval('h1', (e) => !!e.closest('.frame')), tag + ' h1 not inside .frame');
        const fr = await rect(page, '.frame'), wl = await rect(page, '.well'), h1 = await rect(page, 'h1'), nt = await rect(page, '.note');
        say(`${tag}: h1 ${JSON.stringify(h1)} well ${JSON.stringify(wl)} note ${JSON.stringify(nt)}`);
        ok(inside(h1, fr), tag + ': h1 box not inside frame');
        ok(!overlap(h1, wl), tag + ': h1 intersects well');
        ok(h1.t <= wl.t + 8, `${tag}: h1 top ${h1.t} not in top corner (well top ${wl.t})`);
        const hc = rgbOf(await style(page, 'h1', 'color'));
        ok(hc.every((v) => v >= 230), tag + ': h1 colour ' + hc);
        eq(await style(page, 'h1', 'fontStyle'), 'italic', tag + ' h1 font-style');
        eq(await style(page, 'h1', 'whiteSpace'), 'nowrap', tag + ' h1 white-space');
        ok(await page.$eval('.note', (e) => !!e.closest('.frame')), tag + ': .note not inside .frame');
        eq((await page.textContent('.note')).trim(), 'Click a tile next to the gap to slide it.', tag + ' note text');
        const nc = rgbOf(await style(page, '.note', 'color'));
        ok(nc.every((v) => v >= 230), tag + ': note colour ' + nc);
        ok(parseFloat(await style(page, '.note', 'fontSize')) < parseFloat(await style(page, 'h1', 'fontSize')), tag + ': note font not smaller than h1');
        ok(inside(nt, fr), tag + ': note box not inside frame');
        ok(!overlap(nt, wl), tag + ': note intersects well');
        ok(!overlap(nt, h1), tag + ': note intersects h1');
        const others = await page.evaluate(() => [...document.body.querySelectorAll('*')].filter((e) => !e.closest('.frame') && e.id !== 'shuffle' && e.children.length === 0 && e.textContent.trim() === 'Shuffle' && e.getClientRects().length > 0).length);
        eq(others, 0, tag + ' other visible Shuffle text outside frame');
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await setSizeUI(page, 3, 3);
    await shot(page, dir, 'screenshot.png');
    say('ok');
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
    // Make a move and let the timer tick first, so the reset assertions can actually fail.
    await click(page, 7);
    await sleep(1200);
    ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, 'setup: expected moves 1 and timer >= 1 before shuffling');
    for (let n = 0; n < 20; n++) {
      await page.click('#shuffle');
      const b = await board(page);
      ok(perm(b), 'not a permutation: ' + b);
      seen.add(b.join(','));
      eq(await movesOf(page), 0, 'moves after shuffle');
      eq(await timerOf(page), 0, 'timer after shuffle');
      ok(!(await page.isVisible('#message')), 'message visible after shuffle');
    }
    ok(seen.size >= 2, 'fewer than 2 distinct boards in 20 clicks');
    const extra = await page.evaluate(() => { const out = []; for (let i = 0; i < 500; i++) { shuffle(); out.push(tiles.slice()); } return out; });
    ok(extra.every((t) => [...t].sort((a, c) => a - c).join() === '0,1,2,3,4,5,6,7,8'), 'extra sample not permutation');
    const distinct = new Set(extra.map((t) => t.join(','))).size;
    ok(distinct >= 2, 'extra samples not distinct');
    say(`20 clicks distinct: ${seen.size}; 500 samples distinct: ${distinct}`);
  });

  // shuffle-solvable: AC1, AC2 (#4). Every shuffle result is reachable and not solved.
  await run('shuffle-solvable', async ({ page, dir, say }) => {
    const boards = [];
    for (let n = 0; n < 20; n++) {
      await page.click('#shuffle');
      if (n === 19) await shot(page, dir, 'screenshot.png');
      boards.push((await board(page)).map((x) => (x === '_' ? 0 : Number(x))));
      ok(!(await page.isVisible('#message')), `message visible after click ${n + 1}`);
    }
    boards.push(...(await page.evaluate(() => { const out = []; for (let i = 0; i < 2000; i++) { shuffle(); out.push(tiles.slice()); } return out; })));
    let unreachable = 0, solved = 0, disagree = 0, notPerm = 0;
    for (const b of boards) {
      if ([...b].sort((a, c) => a - c).join() !== '0,1,2,3,4,5,6,7,8') notPerm++;
      const inSet = REACH3.has(b.join());
      if (!inSet) unreachable++;
      if (oracleSolvable(b, 3, 3) !== inSet) disagree++;
      if (b.join() === SOLVED3) solved++;
    }
    const distinct = new Set(boards.map((b) => b.join())).size;
    say(`boards ${boards.length} (20 clicks + 2000 calls); unreachable ${unreachable}; solved ${solved}; oracle disagreements ${disagree}; not permutations ${notPerm}; distinct ${distinct}`);
    eq(notPerm, 0, 'not permutations');
    eq(unreachable, 0, 'unreachable boards');
    eq(solved, 0, 'solved boards');
    eq(disagree, 0, 'oracle disagreements');
    ok(distinct >= 2, 'fewer than 2 distinct boards');
  });

  // shuffle-reroll: AC1, AC2 white box (#4). Forced solved and unsolvable first draws must be re-rolled.
  await run('shuffle-reroll', async ({ page, say }) => {
    const cases = { 'solved first draw': Array(8).fill(0.999), 'unsolvable first draw': Array(7).fill(0.999).concat(0) };
    const results = await page.evaluate((cases) => {
      const saved = Math.random;
      const out = {};
      try {
        for (const [name, queue] of Object.entries(cases)) {
          const q = queue.slice();
          let draws = 0;
          Math.random = () => { draws++; return q.length ? q.shift() : saved(); };
          tiles = [1, 2, 3, 4, 5, 6, 7, 8, 0];
          shuffle();
          out[name] = { draws, board: tiles.slice() };
        }
      } finally {
        Math.random = saved;
      }
      out.restored = Math.random === saved;
      return out;
    }, cases);
    for (const name of Object.keys(cases)) {
      const r = results[name];
      say(`${name}: draws ${r.draws}, board ${r.board.join()}`);
      ok(r.draws >= 16, `${name}: draws ${r.draws}, expected >= 16`);
      ok(REACH3.has(r.board.join()), `${name}: final board unreachable`);
      ok(r.board.join() !== SOLVED3, `${name}: final board solved`);
    }
    say('Math.random restored: ' + results.restored);
    ok(results.restored, 'Math.random not restored');
  }, { shoot: false });

  // shuffle-uniform: D3 (#4). Tile 1 lands in every cell equally often.
  await run('shuffle-uniform', async ({ page, say }) => {
    const counts = await page.evaluate(() => {
      const c = new Array(9).fill(0);
      for (let i = 0; i < 9000; i++) { tiles = [1, 2, 3, 4, 5, 6, 7, 8, 0]; shuffle(); c[tiles.indexOf(1)]++; }
      return c;
    });
    say('tile 1 counts by cell: ' + counts.join(' '));
    ok(counts.every((n) => n >= 750 && n <= 1250), 'a cell count is outside 750-1250');
  }, { shoot: false });

  // solvable-predicate: AC3 (#4). The app's isSolvable agrees with BFS on small boards and with random walks up to 6x6.
  await run('solvable-predicate', async ({ page, say }) => {
    const callApp = async (boards, cols) => {
      const res = [];
      for (let i = 0; i < boards.length; i += 40000) {
        res.push(...(await page.evaluate(([bs, c]) => bs.map((b) => isSolvable(b, c)), [boards.slice(i, i + 40000), cols])));
      }
      return res;
    };
    for (const [rows, cols] of [[2, 3], [3, 2], [2, 4], [4, 2], [3, 3]]) {
      const reach = reachable(rows, cols);
      const all = permutations(rows * cols);
      const app = await callApp(all, cols);
      let appBad = 0, oracleBad = 0;
      all.forEach((b, i) => { const truth = reach.has(b.join()); if (app[i] !== truth) appBad++; if (oracleSolvable(b, rows, cols) !== truth) oracleBad++; });
      say(`exhaustive ${rows}x${cols}: ${all.length} boards, ${reach.size} reachable; app mismatches ${appBad}; oracle mismatches ${oracleBad}`);
      eq(appBad, 0, `app mismatches ${rows}x${cols}`);
      eq(oracleBad, 0, `oracle mismatches ${rows}x${cols}`);
    }
    for (let rows = 3; rows <= 6; rows++) {
      for (let cols = 3; cols <= 6; cols++) {
        const good = [], bad = [];
        for (let k = 0; k < 200; k++) {
          const b = randomWalk(rows, cols, 2000);
          good.push(b);
          const f = b.slice();
          const [i, j] = f.map((v, idx) => (v !== 0 ? idx : -1)).filter((idx) => idx >= 0).slice(0, 2);
          [f[i], f[j]] = [f[j], f[i]];
          bad.push(f);
        }
        const appGood = await callApp(good, cols), appBad = await callApp(bad, cols);
        const misses = appGood.filter((x) => !x).length + appBad.filter((x) => x).length;
        const oMisses = good.filter((b) => !oracleSolvable(b, rows, cols)).length + bad.filter((b) => oracleSolvable(b, rows, cols)).length;
        say(`walk ${rows}x${cols}: 200 reachable + 200 swapped; app mismatches ${misses}; oracle mismatches ${oMisses}`);
        eq(misses, 0, `app mismatches walk ${rows}x${cols}`);
        eq(oMisses, 0, `oracle mismatches walk ${rows}x${cols}`);
      }
    }
  }, { shoot: false });

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
    ok(!(await msg.isVisible()), 'message visible at load');
    eq(await movesOf(page), 0, 'moves at load');
    await shot(page, dir, 'screenshot.png');
    await click(page, 7);
    ok(!(await msg.isVisible()), 'message visible after click 1');
    await shot(page, dir, 'screenshot-2.png');
    await click(page, 8);
    ok(await msg.isVisible(), 'message hidden after click 2');
    eq((await msg.textContent()).trim(), 'You solved it!', 'text after click 2');
    eq(await movesOf(page), 2, 'moves after solve');
    await shot(page, dir, 'screenshot-3.png');
    await click(page, 7);
    ok(!(await msg.isVisible()), 'message visible after moving away');
    eq(await movesOf(page), 3, 'moves after moving away');
    await shot(page, dir, 'screenshot-4.png');
    await click(page, 8);
    ok(await msg.isVisible(), 'message hidden after re-solve');
    eq(await movesOf(page), 4, 'moves after re-solve');
    await shot(page, dir, 'screenshot-5.png');
    say('load hidden (moves 0); solve visible (moves 2); away hidden (moves 3); re-solve visible (moves 4)');
  });

  // no-win-at-zero-moves: AC3 (#5), a solved board at Moves 0 (as after Shuffle) shows no message.
  await run('no-win-at-zero-moves', async ({ page, say }) => {
    const msg = page.locator('#message');
    await click(page, 7);
    await click(page, 8);
    ok(await msg.isVisible(), 'setup: message not visible after solving');
    await page.click('#shuffle');
    await page.evaluate(() => { tiles = [1, 2, 3, 4, 5, 6, 7, 8, 0]; render(); });
    eq(await movesOf(page), 0, 'setup: moves');
    eq(await board(page), SOLVED, 'setup: board');
    ok(!(await msg.isVisible()), 'message visible on solved board with 0 moves');
    await sleep(1500);
    eq(await timerOf(page), 0, 'timer');
    say('solved board at moves 0: message hidden, timer 0 after 1.5s');
  });

  await run('solve-timer', async ({ page, say }) => {
    await click(page, 7);
    await sleep(1200);
    await click(page, 8);
    const a = await timerOf(page);
    await sleep(2000);
    const b = await timerOf(page);
    say(`readings ${a}, ${b}`);
    ok(a >= 1, 'timer never ran before the solve');
    eq(b, a, 'timer readings');
  });

  // layout: AC5 (#7), a superset of #2's layout over SIZES x VIEWS; "board centred" became "frame centred"
  await run('layout', async ({ page, dir, say }) => {
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [r, c] of SIZES) {
        await setSizeUI(page, r, c);
        const m = await page.evaluate(() => {
          const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height }; };
          const fr = rc(document.getElementById('frame'));
          const tiles = [...document.querySelectorAll('.tile')].map(rc);
          const bg = (s) => { const cs = getComputedStyle(document.querySelector(s)); return cs.backgroundColor + '|' + cs.backgroundImage; };
          const bgColour = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
          const msg = document.getElementById('message');
          const was = msg.hidden;
          msg.hidden = false;
          const msgBox = rc(msg);
          msg.hidden = was;
          return { fr, well: rc(document.querySelector('.well')), tiles, emptyBg: bg('.tile.empty'), tileBg: bg('.tile:not(.empty)'), emptyColour: bgColour('.tile.empty'), tileColour: bgColour('.tile:not(.empty)'), board: rc(document.getElementById('board')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: window.innerHeight, size: rc(document.querySelector('.size')), status: rc(document.querySelector('.status')), shuffle: rc(document.getElementById('shuffle')), msgBox };
        });
        const tag = `${w}x${h} ${r}x${c}`;
        say(`${tag}: tile ${m.tiles[0].w.toFixed(1)}px, frame ${m.fr.l.toFixed(1)}..${m.fr.r.toFixed(1)}, cw ${m.cw}, msgBottom ${m.msgBox.b.toFixed(1)}`);
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => Math.abs(q.w - q.h) <= 1), tag + ': tiles not square');
        ok(m.tiles.every((q) => q.w >= 40), `${tag}: tile under 40px (${m.tiles[0].w})`);
        ok(m.emptyBg !== m.tileBg, tag + ': empty bg equals tile bg');
        ok(m.emptyColour !== m.tileColour, tag + ': empty background-color equals tile background-color (#2 assertion)');
        ok(Math.abs(m.fr.l - (m.cw - m.fr.r)) <= 2, `${tag}: frame margins ${m.fr.l} vs ${m.cw - m.fr.r}`);
        for (const [k, q] of [['size row', m.size], ['.status', m.status], ['#shuffle', m.shuffle], ['#message', m.msgBox]]) ok(q.l >= 0 && q.r <= m.cw, `${tag}: ${k} outside [0, clientWidth]`);
        ok(m.msgBox.b <= m.ih, `${tag}: message bottom ${m.msgBox.b} beyond viewport ${m.ih}`);
        ok(m.tiles.every((q) => q.l >= 0 && q.r <= m.cw), tag + ': tile outside [0, clientWidth]');
        ok(m.tiles.every((q) => inside(q, m.well)), tag + ': tile outside well');
        ok(inside(m.well, m.fr), tag + ': well outside frame');
        ok(Math.abs((m.board.l - m.well.l) - (m.well.r - m.board.r)) <= 1, `${tag}: board not centred in well (${(m.board.l - m.well.l).toFixed(1)} vs ${(m.well.r - m.board.r).toFixed(1)})`);
        await shot(page, dir, `${r}x${c}-${w}.png`);
      }
    }
  });

  // look: AC1, AC3, D3 (#7). Computed-style and geometry assertions on the Pussycat look.
  await run('look', async ({ page, dir, say }) => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
    ok(css.includes('container-type: inline-size'), 'style lacks container-type: inline-size');
    ok(css.includes('100cqi'), 'style lacks 100cqi');
    for (const bad of ['repeat(3', '90px', '100vw', '--rows']) ok(!css.includes(bad), 'style contains ' + bad);
    say('style greps ok: container-type, 100cqi; no repeat(3, 90px, 100vw, --rows');
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [r, c] of SIZES) {
        await setSizeUI(page, r, c);
        const tag = `${w}x${h} ${r}x${c}`;
        const frC = await colours(page, '.frame'), wlC = await colours(page, '.well'), tlC = await colours(page, '.tile:not(.empty)'), emC = await colours(page, '.tile.empty');
        nonVacuous(frC, tag + ' frame', say); nonVacuous(wlC, tag + ' well', say); nonVacuous(tlC, tag + ' tile', say); nonVacuous(emC, tag + ' empty', say);
        ok(frC.every((x) => maxc(x) <= 48), tag + ': frame not black');
        ok(parseFloat(await style(page, '.frame', 'borderTopLeftRadius')) >= 8, tag + ': frame radius < 8px');
        ok((await style(page, '.frame', 'boxShadow')).includes('inset'), tag + ': frame has no inset highlight');
        const fr = await rect(page, '.frame'), wl = await rect(page, '.well'), bd = await rect(page, '#board');
        if (w >= 560) {
          ok(fr.w - wl.w >= 100, `${tag}: frame-well width ${fr.w - wl.w} < 100`);
          const off = Math.abs((wl.l - fr.l) - (fr.r - wl.r));
          ok(off >= 60, `${tag}: well not off-centre (${off})`);
        }
        ok(wlC.every((x) => maxc(x) <= Math.min(...frC.map(maxc))), tag + ': well not darker than frame');
        ok((await style(page, '.well', 'boxShadow')).includes('inset'), tag + ': well not recessed');
        ok(inside(bd, wl), tag + ': board outside well');
        ok(tlC.every(([R, G, B]) => R >= 200 && G >= 190 && B >= 160 && R >= B), tag + ': tile not cream');
        ok((await style(page, '.tile:not(.empty)', 'boxShadow')) !== 'none', tag + ': tile has no bevel');
        ok(parseFloat(await style(page, '#board', 'columnGap')) <= 4 && parseFloat(await style(page, '#board', 'rowGap')) <= 4, tag + ': gap > 4px');
        ok(Number(await style(page, '.tile:not(.empty)', 'fontWeight')) >= 700, tag + ': tile font-weight < 700');
        ok((await style(page, '.tile:not(.empty)', 'fontFamily')).includes('Rounded'), tag + ': tile font not rounded');
        ok(emC.every((x) => maxc(x) <= 32), tag + ': empty tile not dark');
        ok((await style(page, '.tile.empty', 'boxShadow')).includes('inset'), tag + ': empty tile not recessed');
        const bdC = await colours(page, 'body'), shC = await colours(page, '#shuffle');
        nonVacuous(bdC, tag + ' body', say); nonVacuous(shC, tag + ' #shuffle', say);
        ok(bdC.every((x) => maxc(x) - Math.min(...x) <= 16 && lum(x) >= 0.40 && lum(x) <= 0.85), tag + ': body not neutral tabletop');
        ok(shC.every((x) => maxc(x) <= 64), tag + ': #shuffle not dark plastic');
        ok(rgbOf(await style(page, '#shuffle', 'color')).every((v) => v >= 230), tag + ': #shuffle text not white');
        for (const sel of ['#moves', '#timer', '#shuffle', '#rows', '#cols']) ok(!overlap(await rect(page, sel), fr), `${tag}: ${sel} intersects frame`);
        await shot(page, dir, `${r}x${c}-${w}.png`);
      }
    }
    // Real solve at 1280x800 so #message shows.
    await page.setViewportSize({ width: 1280, height: 800 });
    await setSizeUI(page, 3, 3);
    await click(page, 7);
    await click(page, 8);
    ok(await page.isVisible('#message'), 'message not visible after solve');
    const frame = await rect(page, '.frame');
    ok(!overlap(await rect(page, '#message'), frame), 'message intersects frame');
    for (const sel of ['#shuffle', '#moves', '#timer', '#message', '#rows', '#cols']) {
      const cl = [rgbOf(await style(page, sel, 'color')), ...(await colours(page, sel))];
      ok(!cl.some(isGreen), `${sel} has a green colour: ${JSON.stringify(cl)}`);
      say(`${sel} not green: ${JSON.stringify(cl)}`);
    }
    await shot(page, dir, 'solved-1280.png');
  });

  // layout-scrollbar: AC5 / D3 (#7). A classic scrollbar must not push tiles out of the well.
  {
    const name = 'layout-scrollbar';
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const log = [];
    const sb = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const [w, h] of [[360, 480], [360, 740], [560, 800]]) {
        const ctx = await sb.newContext({ viewport: { width: w, height: h } });
        const page = await ctx.newPage();
        page.on('request', (r) => requests.push(r.url()));
        page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
        await page.goto(PAGE_URL);
        await page.addStyleTag({ content: 'html{overflow-y:scroll}' });
        await setSizeUI(page, 6, 6);
        const m = await page.evaluate(() => {
          const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom }; };
          return { cw: document.documentElement.clientWidth, iw: window.innerWidth, sw: document.documentElement.scrollWidth, fr: rc(document.getElementById('frame')), well: rc(document.querySelector('.well')), tiles: [...document.querySelectorAll('.tile')].map(rc) };
        });
        const tag = `${w}x${h} 6x6`;
        log.push(`${tag}: ${JSON.stringify({ cw: m.cw, iw: m.iw, sw: m.sw, tile: (m.tiles[0].r - m.tiles[0].l).toFixed(1) })}`);
        await shot(page, dir, `6x6-${w}x${h}.png`);
        await ctx.close();
        ok(m.cw < m.iw, tag + ': no classic scrollbar; pass not meaningful');
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => inside(q, m.well)), tag + ': tile outside well');
        ok(inside(m.well, m.fr), tag + ': well outside frame');
        ok(m.fr.l >= 0 && m.fr.r <= m.cw, tag + ': frame outside [0, clientWidth]');
      }
      lines.push('PASS ' + name);
    } catch (e) {
      failed = true;
      lines.push(`FAIL ${name}: ${e.message}`);
    } finally {
      await sb.close();
      fs.writeFileSync(path.join(dir, 'output.txt'), log.join('\n') + '\n');
    }
  }

  await run('code-shape', async ({ say }) => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    for (const f of ['render', 'move', 'setSize', 'shuffle', 'isSolvable', 'isSolved', 'checkWin']) {
      const re = new RegExp('//[^\\n]*\\r?\\n\\s*function ' + f + '\\b');
      ok(re.test(html), `function ${f} missing or has no comment above`);
      say(`function ${f}: present with comment`);
    }
    ok(!/\bSIZE\b/.test(html), 'SIZE still present');
    say('SIZE: absent');
    ok(html.includes('isSolvable(tiles, cols)'), 'isSolvable(tiles, cols) missing');
    say('isSolvable(tiles, cols): present');
  }, { shoot: false });

  // size-controls: AC1 (#2)
  await run('size-controls', async ({ page, say }) => {
    for (const id of ['rows', 'cols']) {
      const info = await page.$eval('#' + id, (el) => ({ tag: el.tagName, ac: el.getAttribute('autocomplete'), opts: [...el.options].map((o) => o.value), val: el.value }));
      say(`${id}: ${JSON.stringify(info)}`);
      eq(info.tag, 'SELECT', id + ' tag');
      eq(info.ac, 'off', id + ' autocomplete');
      eq(info.opts, ['3', '4', '5', '6'], id + ' options');
      eq(info.val, '3', id + ' default');
    }
    eq(await page.getByLabel('Rows').evaluate((e) => e.id), 'rows', 'Rows label target');
    eq(await page.getByLabel('Columns').evaluate((e) => e.id), 'cols', 'Columns label target');
    await page.selectOption('#cols', '5');
    await page.goto('about:blank');
    await page.goBack();
    const vals = await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value, document.querySelectorAll('#board .tile').length]);
    say('after back/forward: ' + JSON.stringify(vals));
    eq(vals, ['3', '3', 9], 'selects and board after back/forward');
  });

  // size-all: AC2 (#2)
  await run('size-all', async ({ page, dir, say }) => {
    for (let r = 3; r <= 6; r++) {
      for (let c = 3; c <= 6; c++) {
        await setSizeUI(page, r, c);
        const boxes = await page.$$eval('#board .tile', (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y)]; }));
        eq(boxes.length, r * c, `${r}x${c} tile count`);
        eq(new Set(boxes.map((b) => b[0])).size, c, `${r}x${c} distinct x`);
        eq(new Set(boxes.map((b) => b[1])).size, r, `${r}x${c} distinct y`);
        eq(await board(page), solvedBoard(r * c), `${r}x${c} labels`);
        eq(await page.$$eval('#board .tile.empty', (e) => e.length), 1, `${r}x${c} empty count`);
        eq(await movesOf(page), 0, `${r}x${c} moves`);
        eq(await timerOf(page), 0, `${r}x${c} timer`);
        ok(!(await page.isVisible('#message')), `${r}x${c} message visible`);
        say(`${r}x${c}: ${boxes.length} tiles, ${c} columns, ${r} rows, solved, moves 0, timer 0s, message hidden`);
        if (['3x6', '6x3', '4x5', '6x6'].includes(`${r}x${c}`)) await shot(page, dir, `screenshot-${r}x${c}.png`);
      }
    }
  });

  // size-slide-3x4: AC3 (#2)
  await run('size-slide-3x4', async ({ page, say }) => {
    await setSizeUI(page, 3, 4);
    for (const i of [7, 6, 5, 4]) await click(page, i);
    const after4 = ['1', '2', '3', '4', '_', '5', '6', '7', '9', '10', '11', '8'];
    eq(await board(page), after4, 'after 4 clicks');
    eq(await movesOf(page), 4, 'moves 4');
    await click(page, 3);
    await click(page, 1);
    eq(await board(page), after4, 'after illegal clicks 3 and 1');
    eq(await movesOf(page), 4, 'moves still 4');
    await click(page, 0);
    eq(await board(page), ['_', '2', '3', '4', '1', '5', '6', '7', '9', '10', '11', '8'], 'after click 0');
    eq(await movesOf(page), 5, 'moves 5');
    say('ok');
  });

  // size-slide-4x3: AC3 (#2)
  await run('size-slide-4x3', async ({ page, say }) => {
    await setSizeUI(page, 4, 3);
    for (const i of [8, 7, 6]) await click(page, i);
    const after3 = ['1', '2', '3', '4', '5', '6', '_', '7', '8', '10', '11', '9'];
    eq(await board(page), after3, 'after 3 clicks');
    eq(await movesOf(page), 3, 'moves 3');
    await click(page, 5);
    eq(await board(page), after3, 'after illegal click 5');
    eq(await movesOf(page), 3, 'moves still 3');
    await click(page, 9);
    eq(await board(page), ['1', '2', '3', '4', '5', '6', '10', '7', '8', '_', '11', '9'], 'after click 9');
    eq(await movesOf(page), 4, 'moves 4');
    say('ok');
  });

  // size-shuffle: AC4 (#2)
  await run('size-shuffle', async ({ page, dir, say }) => {
    for (const [r, c] of [[3, 4], [5, 3], [6, 6]]) {
      await setSizeUI(page, r, c);
      await click(page, r * c - 1 - c);
      await sleep(1200);
      ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, `${r}x${c} setup: expected moves 1 and timer >= 1`);
      const seen = new Set();
      const expectSorted = [...Array(r * c).keys()].join();
      for (let n = 0; n < 10; n++) {
        await page.click('#shuffle');
        const b = await board(page);
        eq(b.map((x) => (x === '_' ? 0 : Number(x))).sort((a, d) => a - d).join(), expectSorted, `${r}x${c} permutation`);
        seen.add(b.join());
        const boxes = await page.$$eval('#board .tile', (els) => els.map((e) => { const q = e.getBoundingClientRect(); return [Math.round(q.x), Math.round(q.y)]; }));
        eq(new Set(boxes.map((q) => q[0])).size, c, `${r}x${c} column count`);
        eq(new Set(boxes.map((q) => q[1])).size, r, `${r}x${c} row count`);
        eq(await movesOf(page), 0, `${r}x${c} moves after shuffle`);
        eq(await timerOf(page), 0, `${r}x${c} timer after shuffle`);
        ok(!(await page.isVisible('#message')), `${r}x${c} message visible after shuffle`);
      }
      ok(seen.size >= 2, `${r}x${c}: fewer than 2 distinct boards`);
      say(`${r}x${c}: 10 shuffles, ${seen.size} distinct`);
    }
    await shot(page, dir, 'screenshot.png');
  });

  // size-solvable: path A, #4 V1 at other sizes (#2). Judged by the driver's oracleSolvable, never the app's isSolvable.
  await run('size-solvable', async ({ page, say }) => {
    for (const [r, c] of [[3, 4], [4, 3], [4, 6], [6, 4], [6, 6]]) {
      await setSizeUI(page, r, c);
      const boards = await page.evaluate(() => { const out = []; for (let i = 0; i < 500; i++) { shuffle(); out.push(tiles.slice()); } return out; });
      const solved = solvedOf(r * c).join();
      const bad = boards.filter((b) => !oracleSolvable(b, r, c)).length;
      const solvedCount = boards.filter((b) => b.join() === solved).length;
      const wrongLen = boards.filter((b) => b.length !== r * c).length;
      say(`${r}x${c}: 500 samples; oracle-unsolvable ${bad}; solved ${solvedCount}; wrong length ${wrongLen}`);
      eq(wrongLen, 0, `${r}x${c} wrong length`);
      eq(bad, 0, `${r}x${c} unsolvable samples`);
      eq(solvedCount, 0, `${r}x${c} solved samples`);
    }
  }, { shoot: false });

  // size-uniform: path A, #4 V3 at 3x4 (#2)
  await run('size-uniform', async ({ page, say }) => {
    await setSizeUI(page, 3, 4);
    const counts = await page.evaluate(() => {
      const cnt = new Array(12).fill(0);
      for (let i = 0; i < 12000; i++) { tiles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0]; shuffle(); cnt[tiles.indexOf(1)]++; }
      return cnt;
    });
    say('tile 1 counts by cell: ' + counts.join(' '));
    ok(counts.every((n) => n >= 750 && n <= 1250), 'a cell count is outside 750-1250');
  }, { shoot: false });

  // size-reroll: path A, #4 V4 at 3x4 (#2). Forced solved and unsolvable first draws must be re-rolled.
  await run('size-reroll', async ({ page, say }) => {
    await setSizeUI(page, 3, 4);
    const cases = { 'solved first draw': Array(11).fill(0.999), 'unsolvable first draw': Array(10).fill(0.999).concat(0) };
    const results = await page.evaluate((cases) => {
      const saved = Math.random;
      const out = {};
      try {
        for (const [name, queue] of Object.entries(cases)) {
          const q = queue.slice();
          let draws = 0;
          Math.random = () => { draws++; return q.length ? q.shift() : saved(); };
          tiles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0];
          shuffle();
          out[name] = { draws, board: tiles.slice() };
        }
      } finally {
        Math.random = saved;
      }
      out.restored = Math.random === saved;
      return out;
    }, cases);
    for (const name of Object.keys(cases)) {
      const r = results[name];
      say(`${name}: draws ${r.draws}, board ${r.board.join()}`);
      ok(r.draws >= 22, `${name}: draws ${r.draws}, expected >= 22`);
      ok(oracleSolvable(r.board, 3, 4), `${name}: final board unsolvable`);
      ok(r.board.join() !== solvedOf(12).join(), `${name}: final board solved`);
    }
    say('Math.random restored: ' + results.restored);
    ok(results.restored, 'Math.random not restored');
  }, { shoot: false });

  // size-win: AC5 (#2)
  await run('size-win', async ({ page, dir, say }) => {
    const msg = page.locator('#message');
    for (const [r, c, a, b] of [[3, 4, 7, 11], [6, 6, 34, 35]]) {
      await setSizeUI(page, r, c);
      await click(page, a);
      ok(!(await msg.isVisible()), `${r}x${c}: message visible after first click`);
      await click(page, b);
      ok(await msg.isVisible(), `${r}x${c}: message hidden after second click`);
      eq((await msg.textContent()).trim(), 'You solved it!', `${r}x${c} text`);
      const t1 = await timerOf(page);
      await sleep(1500);
      const t2 = await timerOf(page);
      eq(t2, t1, `${r}x${c} timer frozen`);
      say(`${r}x${c}: hidden after click ${a}, visible after click ${b}; timer readings ${t1}, ${t2}`);
      await shot(page, dir, `screenshot-${r}x${c}.png`);
    }
  });

  // size-reset: D2 (#2). A size change starts a new game at once.
  await run('size-reset', async ({ page, say }) => {
    const msg = page.locator('#message');
    await click(page, 7);
    await sleep(1200);
    ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, '(a) setup: moves 1 and timer >= 1');
    await page.selectOption('#cols', '5');
    eq(await board(page), solvedBoard(15), '(a) board');
    eq(await movesOf(page), 0, '(a) moves');
    eq(await timerOf(page), 0, '(a) timer');
    ok(!(await msg.isVisible()), '(a) message visible');
    say('(a) 3x5 solved, moves 0, timer 0s, message hidden');
    await sleep(1500);
    eq(await timerOf(page), 0, '(b) timer leaked');
    say('(b) timer still 0s after 1.5s');
    await click(page, 9);
    eq(await movesOf(page), 1, '(c) moves');
    await sleep(1200);
    ok((await timerOf(page)) >= 1, '(c) timer not running');
    say('(c) click 9 legal at stride 5: moves 1, timer ' + (await timerOf(page)));
    const fresh = await newPage();
    try {
      const p2 = fresh.page;
      await click(p2, 7);
      await sleep(1200);
      await click(p2, 8);
      ok(await p2.locator('#message').isVisible(), '(d) setup: message not visible when solved');
      await p2.selectOption('#rows', '4');
      ok(!(await p2.locator('#message').isVisible()), '(d) message visible after resize');
      eq(await board(p2), solvedBoard(12), '(d) board');
      await click(p2, 8);
      await sleep(1200);
      ok((await timerOf(p2)) >= 1, '(d) timer frozen after resize');
      say('(d) message hidden after resize; timer ' + (await timerOf(p2)) + ' after move');
    } finally {
      await fresh.ctx.close();
    }
  }, { video: true });

  // single-file: AC1 (runs near the end so the change set includes the evidence written by the other checks)
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
    const pats = { 'src=': /src=/, 'href= (not #)': /href=(?!["']#)/, '@import': /@import/, 'url(': /url\(/, 'type="module"': /type="module"/, 'fetch(': /fetch\(/, XMLHttpRequest: /XMLHttpRequest/, '@font-face': /@font-face/, '<link': /<link/ };
    for (const [k, re] of Object.entries(pats)) {
      const n = (html.match(new RegExp(re.source, 'g')) || []).length;
      say(`grep ${k}: ${n} matches`);
      eq(n, 0, `grep ${k}`);
    }
  }, { shoot: false });

  // script-unchanged: D6, AC4 (#7). The <script> text is the merge base's, apart from the allowed presentation-only lines.
  await run('script-unchanged', async ({ say }) => {
    const scripts = (h) => [...h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const baseHtml = execSync(`git show ${BASE}:index.html`, { encoding: 'utf8', maxBuffer: 1 << 26 });
    const nowHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const a = scripts(baseHtml), b = scripts(nowHtml);
    eq(b.length, a.length, 'script element count');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-script-'));
    const fa = path.join(tmp, 'base.js'), fb = path.join(tmp, 'now.js');
    fs.writeFileSync(fa, a.join('\n').replace(/\r\n/g, '\n'));
    fs.writeFileSync(fb, b.join('\n').replace(/\r\n/g, '\n'));
    const diff = spawnSync('git', ['diff', '--no-index', '-U0', fa, fb], { encoding: 'utf8', maxBuffer: 1 << 26 });
    ok(diff.status === 0 || diff.status === 1, `git diff --no-index failed with status ${diff.status}`);
    const d = diff.stdout;
    fs.rmSync(tmp, { recursive: true, force: true });
    const changed = d.split(/\r?\n/).filter((l) => l && !/^(diff |index |--- |\+\+\+ |@@|\\ )/.test(l));
    say(`script elements: ${a.length}; changed lines: ${changed.length}`);
    changed.forEach((l) => say('changed: ' + l));
    const addOk = /^\+\s*board\.style\.setProperty\('--cols', cols\);\s*$/;
    const delOk = /^-\s*[\w.]+\.style\.(width|height|fontSize|gridTemplateColumns|gridTemplateRows)\s*=\s*[^;]+;\s*$/;
    for (const l of changed) ok((l[0] === '+' && addOk.test(l)) || (l[0] === '-' && delOk.test(l)), 'disallowed script change: ' + l);
    const markup = nowHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const handlers = (markup.match(/<[^>]*\son[a-z]+\s*=/gi) || []).length;
    say('inline handlers in markup: ' + handlers);
    eq(handlers, 0, 'inline on*= handlers');
  }, { shoot: false });

  // no-external-requests: AC6 (#7). Every request over every page the driver opened is index.html itself.
  await run('no-external-requests', async ({ say }) => {
    const uniq = [...new Set(requests.map((u) => u.split('?')[0].split('#')[0]))];
    say('requests: ' + requests.length + '; distinct urls: ' + JSON.stringify(uniq));
    ok(requests.length > 0, 'no requests captured');
    eq(uniq.filter((u) => u !== PAGE_URL), [], 'urls other than index.html');
  }, { shoot: false });

  await run('console', async ({ say }) => {
    say(`errors collected: ${errors.length}`);
    errors.forEach((e) => say(e));
    eq(errors, [], 'runtime errors');
  }, { shoot: false });

  await browser.close();
  fs.rmSync(tmpVideo, { recursive: true, force: true });
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  fs.writeFileSync(path.join(OUT, 'verify-output.txt'), text);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
