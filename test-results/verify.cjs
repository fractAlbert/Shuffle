// Verification driver (test tooling, not app code). See plan section 6 of issues #1, #4 and #5.
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { execSync } = require('child_process');
if (!process.env.PW_DIR) { console.error('Set PW_DIR to the playwright package directory (see plan section 6).'); process.exit(2); }
const { chromium } = require(process.env.PW_DIR);

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'test-results');
const PAGE_URL = url.pathToFileURL(path.resolve('index.html')).href;
// Change-set base for single-file; requires a fresh `git fetch origin main` first.
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
const REACH3 = reachable(3, 3);
const SOLVED3 = solvedOf(9).join();

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
    for (const f of ['render', 'move', 'shuffle', 'isSolvable', 'isSolved', 'checkWin']) {
      const re = new RegExp('//[^\\n]*\\r?\\n\\s*function ' + f + '\\b');
      ok(re.test(html), `function ${f} missing or has no comment above`);
      say(`function ${f}: present with comment`);
    }
  }, { shoot: false });

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
    const pats = { 'src=': /src=/, 'href= (not #)': /href=(?!["']#)/, '@import': /@import/, 'url(': /url\(/, 'type="module"': /type="module"/, 'fetch(': /fetch\(/, XMLHttpRequest: /XMLHttpRequest/ };
    for (const [k, re] of Object.entries(pats)) {
      const n = (html.match(new RegExp(re.source, 'g')) || []).length;
      say(`grep ${k}: ${n} matches`);
      eq(n, 0, `grep ${k}`);
    }
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
