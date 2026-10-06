// Verification driver (test tooling, not app code). See plan section 6 of issues #1, #2, #3, #4, #5, #7, #13, #14, #15 and #17.
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const net = require('net');
const http = require('http');
const { execSync, spawnSync, spawn } = require('child_process');
if (!process.env.PW_DIR) { console.error('Set PW_DIR to the playwright package directory (see plan section 6).'); process.exit(2); }
const { chromium } = require(process.env.PW_DIR);

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'test-results');
const PAGE_URL = url.pathToFileURL(path.resolve('index.html')).href;
// Change-set base for single-file and logic-unchanged; requires a fresh `git fetch origin main` first.
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
// Click that skips Playwright's enabled check, for locked tiles (aria-disabled): the page itself must ignore it.
const fclick = (page, i) => page.click(`#board .tile[data-index="${i}"]`, { force: true });
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
const SIZES = [[3, 3], [3, 4], [4, 3], [6, 6], [3, 6], [6, 3], [10, 10], [3, 10], [10, 3]];
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
// Size helper (#3 D7): size changes only through the real New flow, which always starts a new numbers game, even at the same size.
const setSizeUI = async (page, r, c) => {
  await page.click('#new');
  await page.selectOption('#rows', String(r));
  await page.selectOption('#cols', String(c));
  await page.check('#kind-numbers');
  await page.click('#new-start');
  await page.waitForFunction(() => !document.getElementById('new-dialog').open);
};
const solvedBoard = (n) => [...Array(n - 1).keys()].map((i) => String(i + 1)).concat('_');
const REACH3 = reachable(3, 3);
const SOLVED3 = solvedOf(9).join();

// ---- #3 helpers. The crop oracle below is written from plan D3/D9 text, never from the app's code. ----
const FIX = {};
const FIXDIR = path.join(OUT, 'image-fixtures');
// Deterministic gradient fixtures (D9): pixel (x, y) is R = round(255x/(W-1)), G = round(255y/(H-1)), B = 128.
async function makeFixtures(browser) {
  fs.mkdirSync(FIXDIR, { recursive: true });
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  for (const [name, W, H] of [['landscape.png', 600, 400], ['portrait.png', 400, 600]]) {
    const b64 = await pg.evaluate(([W, H]) => {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const d = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x);
        d.data[i] = Math.round(255 * x / (W - 1)); d.data[i + 1] = Math.round(255 * y / (H - 1)); d.data[i + 2] = 128; d.data[i + 3] = 255;
      }
      g.putImageData(d, 0, 0);
      return cv.toDataURL('image/png').split(',')[1];
    }, [W, H]);
    const buffer = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(FIXDIR, name), buffer);
    FIX[name] = { name, mimeType: 'image/png', buffer, W, H };
  }
  const notes = Buffer.from('hello');
  fs.writeFileSync(path.join(FIXDIR, 'notes.txt'), notes);
  FIX['notes.txt'] = { name: 'notes.txt', mimeType: 'text/plain', buffer: notes, W: 0, H: 0 };
  await ctx.close();
}
// Board labels of an image puzzle: the number in each tile's aria-label, or _ for the empty tile.
const imgBoard = (page) => page.$$eval('#board .tile', (els) => els.map((e) => (e.classList.contains('empty') ? '_' : (e.getAttribute('aria-label') || e.textContent).replace(/^Tile\s+/, '').trim())));
// Centre pixel (64, 64) of each image tile's canvas, with its value and board index.
const pieceSample = (page) => page.$$eval('#board .tile.image', (els) => els.map((e) => {
  const d = e.querySelector('canvas').getContext('2d').getImageData(64, 64, 1, 1).data;
  return { v: Number(e.getAttribute('aria-label').replace('Tile ', '')), i: Number(e.dataset.index), rgb: [d[0], d[1], d[2]] };
}));
// 5x5 grid of [R, G] samples inside each image tile's canvas (grid[yi][xi]).
const pieceGrid = (page) => page.$$eval('#board .tile.image', (els) => els.map((e) => {
  const g = e.querySelector('canvas').getContext('2d');
  const ps = [13, 38, 64, 90, 115];
  return ps.map((y) => ps.map((x) => { const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1]]; }));
}));
// Crop oracle (D3): cover base, zoom z, centre clamped so the crop stays inside the image.
function cropOracle(W, H, rows, cols, z, cx, cy) {
  const A = cols / rows;
  let bw, bh;
  if (W / H >= A) { bh = H; bw = H * A; } else { bw = W; bh = W / A; }
  const cw = bw / z, ch = bh / z;
  const ccx = Math.min(Math.max(cx, cw / 2), W - cw / 2);
  const ccy = Math.min(Math.max(cy, ch / 2), H - ch / 2);
  return { sx: ccx - cw / 2, sy: ccy - ch / 2, cw, ch, cx: ccx, cy: ccy };
}
// Source point expected at the centre of piece v (D9).
const homeOf = (o, rows, cols, v) => { const col = (v - 1) % cols, row = Math.floor((v - 1) / cols); return { x: o.sx + (col + 0.5) * o.cw / cols, y: o.sy + (row + 0.5) * o.ch / rows }; };
// Source point a gradient pixel colour decodes to (D9).
const decodeRgb = (rgb, W, H) => ({ x: rgb[0] * (W - 1) / 255, y: rgb[1] * (H - 1) / 255 });
// Throw unless the colour decodes to the wanted source point within the D9 tolerance; return the error.
function expectPoint(rgb, fx, want, what) {
  const got = decodeRgb(rgb, fx.W, fx.H);
  const tx = 2 * (fx.W - 1) / 255 + 1, ty = 2 * (fx.H - 1) / 255 + 1;
  const ex = Math.abs(got.x - want.x), ey = Math.abs(got.y - want.y);
  ok(ex <= tx && ey <= ty, `${what}: decoded (${got.x.toFixed(1)}, ${got.y.toFixed(1)}), expected (${want.x.toFixed(1)}, ${want.y.toFixed(1)}), tolerance (${tx.toFixed(1)}, ${ty.toFixed(1)})`);
  return Math.max(ex, ey);
}
// Piece oracle: every image tile samples to the home cell of the value in its aria-label under crop o.
async function expectPieces(page, fx, rows, cols, o, tag) {
  const ps = await pieceSample(page);
  let worst = 0;
  for (const p of ps) worst = Math.max(worst, expectPoint(p.rgb, fx, homeOf(o, rows, cols, p.v), `${tag} piece ${p.v}`));
  return { count: ps.length, worst };
}
// Preview readout of #crop-view in backing-store px: cell-centre pixels and cut-line pixels.
const previewSample = (page, rows, cols) => page.$eval('#crop-view', (cv, [rows, cols]) => {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const g = cv.getContext('2d');
  const px = (x, y) => Array.from(g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  const cells = [], vlines = [], hlines = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) cells.push({ v: row * cols + col + 1, rgb: px((col + 0.5) * r.width * dpr / cols, (row + 0.5) * r.height * dpr / rows) });
  for (let k = 1; k < cols; k++) vlines.push(px(Math.round(k * r.width * dpr / cols), 0.5 * r.height * dpr / rows));
  for (let k = 1; k < rows; k++) hlines.push(px(0.5 * r.width * dpr / cols, Math.round(k * r.height * dpr / rows)));
  return { cells, vlines, hlines, w: r.width, h: r.height, bw: cv.width, bh: cv.height, dpr };
}, [rows, cols]);
// New -> Image -> file -> Start; waits for the crop dialog.
const newImageUI = async (page, r, c, fixName = 'landscape.png') => {
  const fx = FIX[fixName];
  await page.click('#new');
  await page.selectOption('#rows', String(r));
  await page.selectOption('#cols', String(c));
  await page.setInputFiles('#image-file', { name: fx.name, mimeType: fx.mimeType, buffer: fx.buffer });
  await page.click('#new-start');
  await page.waitForSelector('#crop-dialog[open]');
};
const cropDoneUI = async (page) => { await page.click('#crop-done'); await page.waitForFunction(() => !document.getElementById('crop-dialog').open); };
const isOpen = (page, id) => page.$eval('#' + id, (e) => e.open);
// Drag on the crop view from its centre by (dx, dy) CSS px.
const dragView = async (page, dx, dy) => {
  const r = await rect(page, '#crop-view');
  const x = r.l + r.w / 2, y = r.t + r.h / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
};
const setZoom = (page, z) => page.$eval('#crop-zoom', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, z);
// With the crop dialog open: the preview and then the cut pieces must both match the oracle crop. Finishes with Done.
async function expectCrop(page, fx, r, c, z, cx, cy, tag, say) {
  const o = cropOracle(fx.W, fx.H, r, c, z, cx, cy);
  ok(Math.abs(o.cx - cx) < 1e-6 && Math.abs(o.cy - cy) < 1e-6, `${tag}: oracle centre (${o.cx}, ${o.cy}) differs from the plan's (${cx}, ${cy})`);
  const pv = await previewSample(page, r, c);
  let worstPrev = 0;
  for (const cell of pv.cells) worstPrev = Math.max(worstPrev, expectPoint(cell.rgb, fx, homeOf(o, r, c, cell.v), `${tag} preview cell ${cell.v}`));
  for (const px of [...pv.vlines, ...pv.hlines]) ok(px[0] >= 250 && px[1] >= 250 && px[2] >= 250, `${tag}: cut line pixel not white: ${px}`);
  await cropDoneUI(page);
  const pc = await expectPieces(page, fx, r, c, o, tag);
  say(`${tag}: crop sx ${o.sx.toFixed(1)} sy ${o.sy.toFixed(1)} cw ${o.cw.toFixed(1)} ch ${o.ch.toFixed(1)}; preview error ${worstPrev.toFixed(2)}px; ${pc.count} pieces, worst error ${pc.worst.toFixed(2)}px`);
}

// ---- #13 helpers. The real `python -m http.server` serves the repo root and the fixture roots; a canned Node server is used only for hostile, delayed and redirecting listings. ----
// Expectations below come from plan #13 sections 2 (D2, D7) and 6, never from the app's code.
const R1 = /\.(jpe?g|png|webp|gif|avif)$/i;
const stemOf = (f) => f.replace(/\.[^.]+$/, '');
const driverOrigins = new Set();
const pyServers = [];
const cannedServers = [];
const expectedConsole = [];
let tmpRoot = null;
// Register a console error that a check provokes on purpose: its location URL and the start of its text.
const expectConsole = (u, prefix = 'Failed to load resource: the server responded with a status of 404') => expectedConsole.push({ url: u, prefix });
const httpGet = (u) => new Promise((resolve, reject) => {
  http.get(u, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
// Start python -m http.server over root on a free port; ready only when the root-specific probe holds (10 s limit).
async function serve(root, probe) {
  const port = await freePort();
  const proc = spawn(process.env.PYTHON || 'python', ['-u', '-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', root], { stdio: ['ignore', 'ignore', 'pipe'] });
  const srv = { root, port, origin: `http://127.0.0.1:${port}`, proc, stderr: '', log: [], exited: false };
  srv.exitP = new Promise((resolve) => proc.once('exit', () => { srv.exited = true; resolve(); }));
  let pending = '';
  proc.stderr.on('data', (d) => {
    srv.stderr += d;
    pending += d;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop();
    for (const ln of parts) { const m = ln.match(/"GET (\S+) HTTP\/[\d.]+" (\d+)/); if (m) srv.log.push({ path: m[1], code: Number(m[2]) }); }
  });
  srv.stop = () => { if (!srv.exited) proc.kill(); return srv.exitP; };
  pyServers.push(srv);
  driverOrigins.add(srv.origin);
  const t0 = Date.now();
  for (;;) {
    let good = false;
    try { good = await probe(srv.origin); } catch (_) { good = false; }
    if (good) return srv;
    if (Date.now() - t0 > 10000) { await srv.stop(); throw new Error(`server for ${root} not ready within 10 s; stderr: ${srv.stderr.slice(-400)}`); }
    await sleep(150);
  }
}
// The canned server: working-tree index.html, a scripted /images/ (cs.listing(n) gives status, body, delay, headers), /images/ok.png, 404 otherwise.
async function canned(okBytes) {
  const cs = { requests: [], count: 0, listing: () => ({ status: 404, body: '' }) };
  cs.server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    cs.requests.push(p);
    if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(ROOT, 'index.html'))); return; }
    if (p === '/images/') {
      const r = cs.listing(++cs.count);
      setTimeout(() => { res.writeHead(r.status || 200, { 'Content-Type': 'text/html; charset=utf-8', ...(r.headers || {}) }); res.end(r.body || ''); }, r.delay || 0);
      return;
    }
    if (p === '/images/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(okBytes); return; }
    if (p === '/settings.json') {
      const r = cs.settings ? cs.settings() : {};
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(r.body !== undefined ? r.body : fs.readFileSync(path.join(ROOT, 'settings.json'))); }, r.delay || 0);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => cs.server.listen(0, '127.0.0.1', resolve));
  cs.origin = `http://127.0.0.1:${cs.server.address().port}`;
  driverOrigins.add(cs.origin);
  cannedServers.push(cs);
  return cs;
}
// A directory-listing page with one link per href.
const listingPage = (hrefs) => '<!DOCTYPE html><html><body><ul>' + hrefs.map((h) => `<li><a href="${h}">${h}</a></li>`).join('') + '</ul></body></html>';
// Stop every server (awaiting each exit), then remove the temp roots.
async function stopAll() {
  for (const c of cannedServers) { if (c.server.closeAllConnections) c.server.closeAllConnections(); await new Promise((resolve) => c.server.close(resolve)); }
  cannedServers.length = 0;
  await Promise.all(pyServers.map((s) => s.stop()));
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 }); tmpRoot = null; }
}
// Last resort on any exit, including a crash: kill survivors and remove the temp root.
process.on('exit', () => {
  for (const s of pyServers) { try { s.proc.kill(); } catch (_) { /* already gone */ } }
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* best effort */ } }
});
const presetRowVisible = (pg) => pg.waitForSelector('#preset-row', { state: 'visible' });
const presetOptions = (pg) => pg.$$eval('#preset option', (opts) => opts.map((o) => ({ text: o.textContent, value: o.value })).filter((o) => o.value !== ''));
const presetNames = async (pg) => (await presetOptions(pg)).map((o) => o.text);
const countLog = (srv, p) => srv.log.filter((e) => e.path === p).length;
// Open New on an HTTP page, wait for the Picture row, set the size, pick the preset by its label and Start; waits for the crop dialog.
const newPresetUI = async (pg, r, c, label) => {
  await pg.click('#new');
  await presetRowVisible(pg);
  await pg.selectOption('#rows', String(r));
  await pg.selectOption('#cols', String(c));
  await pg.selectOption('#preset', { label });
  await pg.click('#new-start');
  await pg.waitForSelector('#crop-dialog[open]');
};

// ---- #14 helpers. Expectations come from plan #14 sections 2 and 6, never from the app's code. ----
const seq = (a, b) => [...Array(b - a + 1).keys()].map((i) => i + a);
const SHIPPED_TEXT = '{\n  "grid": {\n    "rows": { "min": 3, "max": 10 },\n    "columns": { "min": 3, "max": 10 }\n  }\n}\n';
const S_EDIT = '{"grid":{"rows":{"min":4,"max":8},"columns":{"min":3,"max":12}}}';
const S_BAD = '{ "grid": { "rows": ';
const S_VALUES = '{"grid":{"rows":{"min":"4","max":8},"columns":{"min":9,"max":4}},"theme":"dark"}';
const S_NEAR = '{"grid":{"rows":{"min":5,"max":7},"columns":{"min":4,"max":4}}}';
const NO_PRESETS = 'No preset pictures found.';
// The Rows and Columns options of the New dialog, as numbers.
const optionsOf = (page) => page.evaluate(() => ({ rows: [...document.getElementById('rows').options].map((o) => Number(o.value)), cols: [...document.getElementById('cols').options].map((o) => Number(o.value)) }));
// Wait for the app's settings load to finish, whether it applied a range or fell back.
const ready = (page) => page.evaluate(() => settingsReady);
// The driver's own board after a click list from solved: a click slides only when its tile is orthogonally adjacent to the empty cell. Never the app's move.
function slideOracle(r, c, clicks) {
  const t = solvedOf(r * c);
  let e = t.length - 1, moves = 0;
  for (const i of clicks) {
    const dr = Math.abs(Math.floor(i / c) - Math.floor(e / c)), dc = Math.abs((i % c) - (e % c));
    if (dr + dc !== 1) continue;
    [t[i], t[e]] = [t[e], t[i]];
    e = i;
    moves++;
  }
  return { tiles: t.map((v) => (v === 0 ? '_' : String(v))), moves };
}
// A fixture root under the temp dir: a byte copy of index.html, an empty images/ and, unless body is null, a settings.json written verbatim.
function settingsRoot(name, body) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(ROOT, 'index.html')));
  if (body !== null) fs.writeFileSync(path.join(dir, 'settings.json'), body);
  return dir;
}
// Root-specific readiness: settings.json answers with exactly these bytes, or (null) 404 together with an empty images/ listing.
const settingsProbe = (body) => async (o) => {
  const r = await httpGet(o + '/settings.json');
  if (body !== null) return r.status === 200 && r.body === body;
  const i = await httpGet(o + '/images/');
  return r.status === 404 && i.status === 200 && !i.body.includes('<li>');
};
// Tile count and distinct column and row positions of the board on the page.
async function gridOf(pg, r, c, tag) {
  const boxes = await pg.$$eval('#board .tile', (els) => els.map((e) => { const q = e.getBoundingClientRect(); return [Math.round(q.x), Math.round(q.y)]; }));
  eq(boxes.length, r * c, tag + ' tile count');
  eq(new Set(boxes.map((b) => b[0])).size, c, tag + ' distinct x');
  eq(new Set(boxes.map((b) => b[1])).size, r, tag + ' distinct y');
}
// Tile boxes, the well, scroll widths and the bottom of #message (shown for the measurement) of the page.
const fitMetrics = (page) => page.evaluate(() => {
  const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height }; };
  const msg = document.getElementById('message');
  const was = msg.hidden;
  msg.hidden = false;
  const msgB = rc(msg).b;
  msg.hidden = was;
  return { tiles: [...document.querySelectorAll('.tile')].map(rc), well: rc(document.querySelector('.well')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: window.innerHeight, msgB };
});
// Throw unless the board fits: no horizontal scroll, square tiles of at least floor px, inside the well, #message inside the viewport.
function expectFits(m, tag, floor) {
  ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
  ok(m.tiles.every((q) => Math.abs(q.w - q.h) <= 1), tag + ': tiles not square');
  ok(m.tiles.every((q) => q.w >= floor), `${tag}: tile under ${floor}px (${m.tiles[0].w.toFixed(1)})`);
  ok(m.tiles.every((q) => inside(q, m.well)), tag + ': tile outside well');
  ok(m.msgB <= m.ih, `${tag}: message bottom ${m.msgB} beyond viewport ${m.ih}`);
}

// ---- #15 helpers. Expectations come from plan #15 sections 2, 5 and 6, never from the app's code. ----
const S_FLIP = '{"grid":{"rows":{"min":3,"max":12},"columns":{"min":3,"max":12}}}';
const TIMES = '×';
const pairs = (lo, hi) => seq(lo, hi).flatMap((r) => seq(lo, hi).map((c) => [r, c]));
// Click Flip, then wait until the plate and the button show the state the click asked for and no animation is running.
const flipUI = async (page) => {
  const want = (await page.getAttribute('#flip', 'aria-pressed')) !== 'true';
  await page.click('#flip');
  await page.waitForFunction((w) => {
    const p = document.getElementById('plate');
    return p.classList.contains('flipped') === w && document.getElementById('flip').getAttribute('aria-pressed') === String(w) && p.getAnimations().length === 0;
  }, want);
};
// Boxes of the back and its parts, the caption text, the cells, scroll widths and the bottom of #message (shown for the measurement).
const backGeom = (page) => page.evaluate(() => {
  const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height }; };
  const pic = document.getElementById('back-picture'), grid = document.getElementById('back-grid');
  const showsPicture = getComputedStyle(pic).display !== 'none';
  const showsGrid = getComputedStyle(grid).display !== 'none';
  const msg = document.getElementById('message');
  const was = msg.hidden;
  msg.hidden = false;
  const msgB = rc(msg).b;
  msg.hidden = was;
  const cells = [...grid.children];
  return {
    back: rc(document.getElementById('back')), frame: rc(document.getElementById('frame')),
    panel: rc(showsPicture ? pic : grid), showsPicture, showsGrid,
    caption: rc(document.getElementById('back-caption')), capText: document.getElementById('back-caption').textContent,
    maker: rc(document.querySelector('.back-maker')), mark: rc(document.querySelector('.back-mark')),
    cells: showsGrid ? cells.map((e) => e.textContent || '_') : [],
    empties: showsGrid ? cells.filter((e) => e.classList.contains('empty')).length : 0,
    emptyLast: showsGrid && cells.length > 0 && cells[cells.length - 1].classList.contains('empty'),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: window.innerHeight, msgB,
  };
});
// Throw unless the back of an r x c puzzle is laid out as plan #15 D2 and D5 say.
function expectBackLayout(g, r, c, tag) {
  const near = (a, b) => Math.abs(a - b) <= 0.5;
  ok(near(g.back.l, g.frame.l) && near(g.back.r, g.frame.r) && near(g.back.t, g.frame.t) && near(g.back.b, g.frame.b), `${tag}: back ${JSON.stringify(g.back)} differs from frame ${JSON.stringify(g.frame)}`);
  for (const k of ['panel', 'caption', 'maker', 'mark']) ok(inside(g[k], g.back), `${tag}: ${k} ${JSON.stringify(g[k])} outside the back ${JSON.stringify(g.back)}`);
  for (const k of ['caption', 'maker', 'mark']) ok(!overlap(g.panel, g[k]), `${tag}: panel overlaps ${k}`);
  ok(!overlap(g.maker, g.mark), tag + ': maker overlaps mark');
  ok(!overlap(g.maker, g.caption), tag + ': maker overlaps caption');
  ok(g.caption.t >= g.panel.b - 0.5, `${tag}: caption top ${g.caption.t} above panel bottom ${g.panel.b}`);
  ok(g.capText.trim().length > 0, tag + ': caption text is empty');
  ok(g.caption.h >= 10, `${tag}: caption ${g.caption.h}px tall, less than one line`);
  const cc = (g.caption.l + g.caption.r) / 2, pc = (g.panel.l + g.panel.r) / 2;
  ok(Math.abs(cc - pc) <= 2, `${tag}: caption centre ${cc} vs panel centre ${pc}`);
  ok(Math.abs(g.panel.w / c - g.panel.h / r) <= 1, `${tag}: panel ${g.panel.w}x${g.panel.h} not at ${c}:${r}`);
  ok(g.sw <= g.cw, `${tag}: horizontal scroll ${g.sw} > ${g.cw}`);
  ok(g.msgB <= g.ih, `${tag}: message bottom ${g.msgB} beyond viewport ${g.ih}`);
}
// Read the whole backing store of #back-picture: sizes, non-grey pixel count, samples at the given fractions, and the largest step across every internal cut.
const backPixels = (page, rows, cols, fracs) => page.evaluate(([rows, cols, fracs]) => {
  const cv = document.getElementById('back-picture');
  const W = cv.width, H = cv.height;
  const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
  const px = (x, y) => { const i = 4 * (y * W + x); return [d[i], d[i + 1], d[i + 2]]; };
  let nonGrey = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) nonGrey++;
  const samples = fracs.map(([fx, fy]) => {
    const x = Math.min(W - 1, Math.floor(fx * W)), y = Math.min(H - 1, Math.floor(fy * H));
    return { fx: (x + 0.5) / W, fy: (y + 0.5) / H, rgb: px(x, y) };
  });
  let stepX = 0, stepY = 0;
  for (let k = 1; k < cols; k++) { const xk = Math.round(k * W / cols); for (let y = 0; y < H; y++) stepX = Math.max(stepX, Math.abs(px(xk - 1, y)[0] - px(xk, y)[0])); }
  for (let k = 1; k < rows; k++) { const yk = Math.round(k * H / rows); for (let x = 0; x < W; x++) stepY = Math.max(stepY, Math.abs(px(x, yk - 1)[0] - px(x, yk)[0])); }
  return { W, H, cssW: parseFloat(cv.style.width), cssH: parseFloat(cv.style.height), dpr: window.devicePixelRatio, nonGrey, samples, stepX, stepY };
}, [rows, cols, fracs]);
// Luma the greyscale back must show at fraction (fxF, fyF) of the crop o of fixture fx: the gradient colour R = 255x/(W-1), G = 255y/(H-1), B = 128 (#3 D9), through Rec. 601.
function lumaOracle(fx, o, fxF, fyF) {
  const x = o.sx + fxF * o.cw, y = o.sy + fyF * o.ch;
  const R = 255 * x / (fx.W - 1), G = 255 * y / (fx.H - 1);
  return 0.299 * R + 0.587 * G + 0.114 * 128;
}
// Screenshot clip, decoded in the page (no request): bright (R > 180) pixel counts per x-band, and the non-grey pixel count inside grey.
// A band is [name, x0, x1] in clip px (a negative x counts from the right edge); bands count only y in [radius, H - radius].
async function shotStats(page, clip, bands, grey, radius = 14) {
  const b64 = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async ([b64, bands, grey, radius]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const W = bmp.width, H = bmp.height;
    const g = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const out = { W, H, bright: {}, nonGrey: 0 };
    for (const [name, a, b] of bands) {
      const x0 = a < 0 ? W + a : a, x1 = b < 0 ? W + b : b;
      let n = 0;
      for (let y = radius; y <= H - radius; y++) for (let x = x0; x < x1; x++) if (d[4 * (y * W + x)] > 180) n++;
      out.bright[name] = n;
    }
    for (let y = Math.max(0, Math.floor(grey.y)); y < Math.min(H, Math.ceil(grey.y + grey.h)); y++) {
      for (let x = Math.max(0, Math.floor(grey.x)); x < Math.min(W, Math.ceil(grey.x + grey.w)); x++) {
        const i = 4 * (y * W + x);
        if (Math.abs(d[i] - d[i + 1]) > 3 || Math.abs(d[i + 1] - d[i + 2]) > 3) out.nonGrey++;
      }
    }
    return out;
  }, [b64, bands, grey, radius]);
}
// Rendered proof of the back: bright pixels in the right and left bands, and non-grey pixels inside the panel (inset 2px).
async function backShot(page, g) {
  const clip = { x: g.back.l, y: g.back.t, width: g.back.w, height: g.back.h };
  const grey = { x: g.panel.l - g.back.l + 2, y: g.panel.t - g.back.t + 2, w: g.panel.w - 4, h: g.panel.h - 4 };
  return shotStats(page, clip, [['right', -24, -4], ['left', 4, 12]], grey);
}
// With the back showing an image puzzle: layout, grey pixels, luma against the oracle at 30 points and the last cell, and no seams.
async function expectBackImage(page, fx, o, r, c, tag, say, dprWant = 1) {
  const g = await backGeom(page);
  ok(g.showsPicture && !g.showsGrid, tag + ': picture not shown, or grid still shown');
  expectBackLayout(g, r, c, tag);
  const fracs = [];
  for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const fxx of [0.1, 0.3, 0.5, 0.7, 0.9, 0.97]) fracs.push([fxx, fy]);
  fracs.push([(c - 0.5) / c, (r - 0.5) / r]);
  const p = await backPixels(page, r, c, fracs);
  eq(p.dpr, dprWant, tag + ' devicePixelRatio');
  eq([p.W, p.H], [Math.round(p.cssW * p.dpr), Math.round(p.cssH * p.dpr)], tag + ' backing store against css size');
  ok(Math.abs(p.cssW / c - p.cssH / r) <= 1, `${tag}: canvas ${p.cssW}x${p.cssH} not at ${c}:${r}`);
  eq(p.nonGrey, 0, tag + ' non-grey pixels');
  let worst = 0;
  for (const s of p.samples) {
    const want = lumaOracle(fx, o, s.fx, s.fy);
    const err = Math.abs(s.rgb[0] - want);
    worst = Math.max(worst, err);
    ok(err <= 3, `${tag}: sample (${s.fx.toFixed(3)}, ${s.fy.toFixed(3)}) is ${s.rgb} but the oracle luma is ${want.toFixed(1)}`);
  }
  ok(p.stepX <= 3 && p.stepY <= 3, `${tag}: seam, largest step across a cut ${p.stepX}/${p.stepY}`);
  say(`${tag}: canvas ${p.cssW}x${p.cssH} css, ${p.W}x${p.H} store at dpr ${p.dpr}; 0 non-grey; ${p.samples.length} samples, worst luma error ${worst.toFixed(2)}; cut steps ${p.stepX}/${p.stepY}`);
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const tmpVideo = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-video-'));
  await makeFixtures(browser);

  async function newPage(opts = {}, pageUrl = PAGE_URL) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
    const page = await ctx.newPage();
    page.on('request', (r) => requests.push(r.url()));
    page.on('pageerror', (e) => errors.push({ text: 'pageerror: ' + e.message, url: '' }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ text: 'console: ' + m.text(), url: m.location().url }); });
    await page.goto(pageUrl);
    return { ctx, page };
  }

  async function run(name, fn, { video = false, shoot = true, url: pageUrl = PAGE_URL } = {}) {
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const log = [];
    const say = (s) => log.push(s);
    let ctx, page;
    try {
      ({ ctx, page } = await newPage(video ? { recordVideo: { dir: tmpVideo, size: { width: 1280, height: 800 } } } : {}, pageUrl));
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
      for (const [r, c] of [[3, 3], [6, 6], [10, 10]]) {
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
    await fclick(page, 5);
    ok(await msg.isVisible(), 'message hidden after a further click');
    eq(await board(page), SOLVED, 'board after a further click');
    eq(await movesOf(page), 2, 'moves after a further click');
    await shot(page, dir, 'screenshot-4.png');
    await fclick(page, 7);
    eq(await board(page), SOLVED, 'board after click 7 on the solved board');
    ok(await msg.isVisible(), 'message hidden after click 7 on the solved board');
    eq(await movesOf(page), 2, 'moves after click 7 on the solved board');
    await shot(page, dir, 'screenshot-5.png');
    say('load hidden (moves 0); solve visible (moves 2); further clicks ignored, message stays (moves 2)');
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
          return { fr, well: rc(document.querySelector('.well')), tiles, emptyBg: bg('.tile.empty'), tileBg: bg('.tile:not(.empty)'), emptyColour: bgColour('.tile.empty'), tileColour: bgColour('.tile:not(.empty)'), board: rc(document.getElementById('board')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: window.innerHeight, actions: rc(document.querySelector('.actions')), status: rc(document.querySelector('.status')), shuffle: rc(document.getElementById('shuffle')), flip: rc(document.getElementById('flip')), msgBox };
        });
        const tag = `${w}x${h} ${r}x${c}`;
        say(`${tag}: tile ${m.tiles[0].w.toFixed(1)}px, frame ${m.fr.l.toFixed(1)}..${m.fr.r.toFixed(1)}, cw ${m.cw}, msgBottom ${m.msgBox.b.toFixed(1)}`);
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => Math.abs(q.w - q.h) <= 1), tag + ': tiles not square');
        ok(m.tiles.every((q) => q.w >= (r <= 6 && c <= 6 ? 40 : 24)), `${tag}: tile under the floor (${m.tiles[0].w})`);
        ok(m.tiles.every((q) => q.w <= 64.01), `${tag}: tile over 64px (${m.tiles[0].w})`);
        ok(m.emptyBg !== m.tileBg, tag + ': empty bg equals tile bg');
        ok(m.emptyColour !== m.tileColour, tag + ': empty background-color equals tile background-color (#2 assertion)');
        ok(Math.abs(m.fr.l - (m.cw - m.fr.r)) <= 2, `${tag}: frame margins ${m.fr.l} vs ${m.cw - m.fr.r}`);
        for (const [k, q] of [['.actions', m.actions], ['.status', m.status], ['#shuffle', m.shuffle], ['#flip', m.flip], ['#message', m.msgBox]]) ok(q.l >= 0 && q.r <= m.cw, `${tag}: ${k} outside [0, clientWidth]`);
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
    for (const bad of ['repeat(3', '90px', '100vw']) ok(!css.includes(bad), 'style contains ' + bad);
    ok(css.includes('100svh'), 'style lacks 100svh');
    say('style greps ok: container-type, 100cqi, 100svh; no repeat(3, 90px, 100vw');
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
        const nwC = await colours(page, '#new');
        nonVacuous(nwC, tag + ' #new', say);
        ok(nwC.every((x) => maxc(x) <= 64), tag + ': #new not dark plastic');
        ok(rgbOf(await style(page, '#new', 'color')).every((v) => v >= 230), tag + ': #new text not white');
        const flC = await colours(page, '#flip');
        nonVacuous(flC, tag + ' #flip', say);
        ok(flC.every((x) => maxc(x) <= 64), tag + ': #flip not dark plastic');
        ok(rgbOf(await style(page, '#flip', 'color')).every((v) => v >= 230), tag + ': #flip text not white');
        for (const sel of ['#moves', '#timer', '#shuffle', '#new', '#flip']) ok(!overlap(await rect(page, sel), fr), `${tag}: ${sel} intersects frame`);
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
    for (const sel of ['#shuffle', '#moves', '#timer', '#message', '#new']) {
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
        page.on('pageerror', (e) => errors.push({ text: 'pageerror: ' + e.message, url: '' }));
        page.on('console', (m) => { if (m.type() === 'error') errors.push({ text: 'console: ' + m.text(), url: m.location().url }); });
        await page.goto(PAGE_URL);
        await page.addStyleTag({ content: 'html{overflow-y:scroll}' });
        for (const [r, c] of [[6, 6], [10, 10]]) {
        await setSizeUI(page, r, c);
        const m = await page.evaluate(() => {
          const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom }; };
          return { cw: document.documentElement.clientWidth, iw: window.innerWidth, sw: document.documentElement.scrollWidth, fr: rc(document.getElementById('frame')), well: rc(document.querySelector('.well')), tiles: [...document.querySelectorAll('.tile')].map(rc) };
        });
        const tag = `${w}x${h} ${r}x${c}`;
        log.push(`${tag}: ${JSON.stringify({ cw: m.cw, iw: m.iw, sw: m.sw, tile: (m.tiles[0].r - m.tiles[0].l).toFixed(1) })}`);
        await shot(page, dir, `${r}x${c}-${w}x${h}.png`);
        ok(m.cw < m.iw, tag + ': no classic scrollbar; pass not meaningful');
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => inside(q, m.well)), tag + ': tile outside well');
        ok(inside(m.well, m.fr), tag + ': well outside frame');
        ok(m.fr.l >= 0 && m.fr.r <= m.cw, tag + ': frame outside [0, clientWidth]');
        ok(m.tiles.every((q) => q.r - q.l >= 23.95), `${tag}: tile under 24px (${(m.tiles[0].r - m.tiles[0].l).toFixed(1)})`);
        }
        await ctx.close();
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
    for (const f of ['render', 'move', 'setSize', 'shuffle', 'isSolvable', 'isSolved', 'checkWin', 'openNew', 'startNew', 'onDecoded', 'onRejected', 'cropRect', 'openCrop', 'drawCrop', 'moveCrop', 'cutImage', 'cropDone', 'loadPresets', 'parseListing', 'onListed', 'gridRange', 'applyRange', 'loadSettings', 'flip', 'drawBack', 'greyscale', 'isLocked']) {
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
      eq(info.opts, seq(3, 10).map(String), id + ' options');
      eq(info.val, '3', id + ' default');
    }
    eq(await page.getByLabel('Rows').evaluate((e) => e.id), 'rows', 'Rows label target');
    eq(await page.getByLabel('Columns').evaluate((e) => e.id), 'cols', 'Columns label target');
    // #3 C6: the size lives only in the New dialog.
    ok(await page.$eval('#rows', (e) => !!e.closest('#new-dialog')) && await page.$eval('#cols', (e) => !!e.closest('#new-dialog')), 'selects not inside #new-dialog');
    ok(!(await page.isVisible('#rows')) && !(await page.isVisible('#cols')), 'a size select is visible at load');
    const sizeBoxes = await page.$$eval('.size', (els) => els.map((e) => ({ inDialog: !!e.closest('#new-dialog'), boxes: e.getClientRects().length })));
    say('.size elements: ' + JSON.stringify(sizeBoxes));
    ok(sizeBoxes.length >= 1 && sizeBoxes.every((s) => s.inDialog && s.boxes === 0), '.size has a box outside the dialog');
    await page.click('#new');
    await page.selectOption('#rows', '4');
    eq(await page.$$eval('#board .tile', (e) => e.length), 9, 'board changed by the Rows select alone');
    await page.selectOption('#cols', '5');
    eq(await page.$$eval('#board .tile', (e) => e.length), 9, 'board changed by the Columns select alone');
    await page.click('#new-cancel');
    eq(await page.$$eval('#board .tile', (e) => e.length), 9, 'board after Cancel');
    await page.click('#new');
    eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['3', '3'], 'reopened dialog prefill');
    await page.selectOption('#cols', '5');
    await page.goto('about:blank');
    await page.goBack();
    const vals = await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value, document.querySelectorAll('#board .tile').length]);
    say('after back/forward: ' + JSON.stringify(vals));
    eq(vals, ['3', '3', 9], 'selects and board after back/forward');
  });

  // size-all: AC2 (#2)
  await run('size-all', async ({ page, dir, say }) => {
    for (let r = 3; r <= 10; r++) {
      for (let c = 3; c <= 10; c++) {
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
        if (['3x6', '6x3', '4x5', '6x6', '10x10', '3x10', '10x3'].includes(`${r}x${c}`)) await shot(page, dir, `screenshot-${r}x${c}.png`);
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
    for (const [r, c] of [[3, 4], [5, 3], [6, 6], [10, 10], [3, 10]]) {
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
    for (const [r, c] of [[3, 4], [4, 3], [4, 6], [6, 4], [6, 6], [10, 10], [3, 10], [10, 3], [9, 10], [10, 9]]) {
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
    // #14: 10x10, 20,000 shuffles; each of the 100 cells expects 200 (about 5 standard deviations either side).
    await setSizeUI(page, 10, 10);
    const big = await page.evaluate(() => {
      const cnt = new Array(100).fill(0);
      for (let i = 0; i < 20000; i++) { tiles = [...Array(99).keys()].map((k) => k + 1).concat(0); shuffle(); cnt[tiles.indexOf(1)]++; }
      return cnt;
    });
    say('10x10 tile 1 counts by cell: ' + big.join(' '));
    ok(big.every((n) => n >= 130 && n <= 270), '10x10: a cell count is outside 130-270');
    eq(big.reduce((a, b) => a + b, 0) / 100, 200, '10x10 mean count');
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
    for (const [r, c, a, b] of [[3, 4, 7, 11], [6, 6, 34, 35], [10, 10, 98, 99]]) {
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
    await setSizeUI(page, 3, 5);
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
      await setSizeUI(p2, 4, 3);
      ok(!(await p2.locator('#message').isVisible()), '(d) message visible after resize');
      eq(await board(p2), solvedBoard(12), '(d) board');
      await click(p2, 8);
      await sleep(1200);
      ok((await timerOf(p2)) >= 1, '(d) timer frozen after resize');
      say('(d) message hidden after resize; timer ' + (await timerOf(p2)) + ' after move');
    } finally {
      await fresh.ctx.close();
    }
    // (e) New at the same size also resets.
    const same = await newPage();
    try {
      const p3 = same.page;
      await click(p3, 7);
      await sleep(1200);
      ok((await movesOf(p3)) === 1 && (await timerOf(p3)) >= 1, '(e) setup: moves 1 and timer >= 1');
      await setSizeUI(p3, 3, 3);
      eq(await board(p3), SOLVED, '(e) board');
      eq(await movesOf(p3), 0, '(e) moves');
      eq(await timerOf(p3), 0, '(e) timer');
      say('(e) New at the same size 3x3: solved, moves 0, timer 0s');
    } finally {
      await same.ctx.close();
    }
  }, { video: true });

  // size-slide-large: AC3 (#14). Legal and illegal clicks on the largest and the widest boards, judged by slideOracle and by the plan's literal boards.
  await run('size-slide-large', async ({ page, dir, say }) => {
    const lit = (n, over) => { const b = solvedBoard(n); for (const [i, v] of Object.entries(over)) b[Number(i)] = v; return b; };
    const cases = [
      [10, 10, [89, 90, 88, 77], lit(100, { 88: '_', 89: '89', 99: '90' })],
      [3, 10, [19, 20, 18], lit(30, { 18: '_', 19: '19', 29: '20' })],
      [10, 3, [26, 27, 25], lit(30, { 25: '_', 26: '26', 29: '27' })],
    ];
    for (const [r, c, clicks, want] of cases) {
      const tag = `${r}x${c}`;
      await setSizeUI(page, r, c);
      for (const i of clicks) await click(page, i);
      const o = slideOracle(r, c, clicks);
      eq(o.tiles, want, tag + ' oracle against the plan literal');
      eq(await board(page), o.tiles, tag + ' board');
      eq(await movesOf(page), 2, tag + ' moves');
      eq(o.moves, 2, tag + ' oracle moves');
      say(`${tag}: clicks ${JSON.stringify(clicks)} -> board matches the oracle, moves 2`);
      await shot(page, dir, `screenshot-${tag}.png`);
    }
  });

  // ---- #3 image tiles: checks C1 to C8 (plan section 6) ----
  // image-pick: C1. A real file input in the New dialog; choosing a file selects Image; Start opens the crop modal.
  await run('image-pick', async ({ page, say }) => {
    await page.click('#new');
    const info = await page.$eval('#image-file', (e) => ({ tag: e.tagName, type: e.type, accept: e.getAttribute('accept'), inDialog: !!e.closest('#new-dialog') }));
    say('file input: ' + JSON.stringify(info));
    eq(info, { tag: 'INPUT', type: 'file', accept: 'image/*', inDialog: true }, 'file input');
    eq(await page.getByLabel('Image file').evaluate((e) => e.id), 'image-file', 'Image file label target');
    ok(!(await page.isChecked('#kind-image')), 'Image radio checked before choosing a file');
    const fx = FIX['landscape.png'];
    await page.setInputFiles('#image-file', { name: fx.name, mimeType: fx.mimeType, buffer: fx.buffer });
    ok(await page.isChecked('#kind-image'), 'choosing a file did not check Image');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    ok(await isOpen(page, 'crop-dialog'), 'crop dialog not open');
    await cropDoneUI(page);
    eq(await imgBoard(page), solvedBoard(9), 'image board');
    eq(await page.$$eval('#board .tile.image', (e) => e.length), 8, 'image tile count');
    say('file chosen -> Image checked -> Start -> crop dialog -> Done -> 8 image tiles, solved');
  });

  // image-sizes: C2. Every size 3..10 x 3..10 with an image: split, mapping, solved start.
  await run('image-sizes', async ({ page, dir, say }) => {
    const fx = FIX['landscape.png'];
    for (let r = 3; r <= 10; r++) {
      for (let c = 3; c <= 10; c++) {
        const tag = `${r}x${c}`;
        await newImageUI(page, r, c);
        await cropDoneUI(page);
        const boxes = await page.$$eval('#board .tile', (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y)]; }));
        eq(boxes.length, r * c, `${tag} tile count`);
        eq(new Set(boxes.map((b) => b[0])).size, c, `${tag} distinct x`);
        eq(new Set(boxes.map((b) => b[1])).size, r, `${tag} distinct y`);
        eq(await page.$$eval('#board .tile.empty', (e) => e.map((x) => Number(x.dataset.index))), [r * c - 1], `${tag} empty tile`);
        eq(await page.$$eval('#board .tile.image', (e) => e.length), r * c - 1, `${tag} image tiles`);
        eq(await page.$$eval('#board .tile.image', (e) => e.map((x) => x.querySelectorAll('canvas').length).every((n) => n === 1)), true, `${tag} one canvas per tile`);
        eq(await imgBoard(page), solvedBoard(r * c), `${tag} labels`);
        const pc = await expectPieces(page, fx, r, c, cropOracle(fx.W, fx.H, r, c, 1, fx.W / 2, fx.H / 2), tag);
        eq(await movesOf(page), 0, `${tag} moves`);
        eq(await timerOf(page), 0, `${tag} timer`);
        ok(!(await page.isVisible('#message')), `${tag} message visible`);
        say(`${tag}: ${boxes.length} tiles, ${c} columns, ${r} rows, ${pc.count} pieces match the oracle (worst ${pc.worst.toFixed(2)}px), solved, moves 0, timer 0s`);
        if (['3x6', '6x3', '4x5', '6x6', '10x10'].includes(tag)) await shot(page, dir, `screenshot-${tag}.png`);
      }
    }
  });

  // image-play: C2. Pieces follow tile values through play, solving and shuffling.
  await run('image-play', async ({ page, say }) => {
    const fx = FIX['landscape.png'];
    const o = cropOracle(fx.W, fx.H, 3, 3, 1, fx.W / 2, fx.H / 2);
    await newImageUI(page, 3, 3);
    await cropDoneUI(page);
    await click(page, 7);
    await sleep(1200);
    await click(page, 8);
    ok(await page.isVisible('#message'), 'message hidden after solving the image board');
    eq((await page.textContent('#message')).trim(), 'You solved it!', 'win text');
    const t1 = await timerOf(page);
    await sleep(1500);
    eq(await timerOf(page), t1, 'timer frozen after the solve');
    ok(t1 >= 1, 'timer never ran before the solve');
    say(`two legal clicks solved the image board; timer frozen at ${t1}s`);
    for (let n = 0; n < 10; n++) {
      await page.click('#shuffle');
      const b = await imgBoard(page);
      const nums = b.map((x) => (x === '_' ? 0 : Number(x)));
      eq([...nums].sort((a, d) => a - d), [...Array(9).keys()], `shuffle ${n} permutation`);
      ok(oracleSolvable(nums, 3, 3), `shuffle ${n}: unsolvable`);
      ok(nums.join() !== SOLVED3, `shuffle ${n}: solved`);
      eq(await movesOf(page), 0, `shuffle ${n} moves`);
      eq(await timerOf(page), 0, `shuffle ${n} timer`);
      await expectPieces(page, fx, 3, 3, o, `shuffle ${n}`);
    }
    say('10 shuffles: permutation, oracle-solvable, not solved, moves 0, timer 0, every piece at its own value\'s home cell');
    const before = await imgBoard(page);
    const e = before.indexOf('_');
    const nb = [e - 3, e + 3, e - 1, e + 1].filter((i) => i >= 0 && i < 9 && (Math.abs(i - e) === 3 || Math.floor(i / 3) === Math.floor(e / 3)))[0];
    const sBefore = (await pieceSample(page)).find((p) => p.i === nb);
    await click(page, nb);
    const after = await imgBoard(page);
    const sAfter = (await pieceSample(page)).find((p) => p.i === e);
    eq(after[e], before[nb], 'tile value in the old empty index');
    eq(after[nb], '_', 'empty index after slide');
    eq(sAfter.rgb, sBefore.rgb, 'the same canvas colour moved into the empty index');
    eq(await movesOf(page), 1, 'moves after slide');
    say(`slid tile ${before[nb]} from ${nb} to ${e}: same colour ${JSON.stringify(sAfter.rgb)}, moves 1`);
    // #14: the same holds on the largest and the widest boards.
    for (const [r, c] of [[10, 10], [3, 10]]) {
      const tag = `${r}x${c}`;
      const o2 = cropOracle(fx.W, fx.H, r, c, 1, fx.W / 2, fx.H / 2);
      await newImageUI(page, r, c);
      await cropDoneUI(page);
      await expectPieces(page, fx, r, c, o2, tag + ' start');
      for (let n = 0; n < 3; n++) {
        await page.click('#shuffle');
        const b2 = (await imgBoard(page)).map((x) => (x === '_' ? 0 : Number(x)));
        eq([...b2].sort((a, d) => a - d), [...Array(r * c).keys()], `${tag} shuffle ${n} permutation`);
        ok(oracleSolvable(b2, r, c), `${tag} shuffle ${n}: unsolvable`);
        ok(b2.join() !== solvedOf(r * c).join(), `${tag} shuffle ${n}: solved`);
        await expectPieces(page, fx, r, c, o2, `${tag} shuffle ${n}`);
      }
      const bef = await imgBoard(page);
      const e2 = bef.indexOf('_');
      const nb2 = e2 % c > 0 ? e2 - 1 : e2 + 1;
      const sB = (await pieceSample(page)).find((p) => p.i === nb2);
      await click(page, nb2);
      const sA = (await pieceSample(page)).find((p) => p.i === e2);
      eq(sA.rgb, sB.rgb, `${tag}: the same canvas colour moved into the empty index`);
      eq(await movesOf(page), 1, `${tag}: moves after slide`);
      say(`${tag}: 3 shuffles oracle-solvable with every piece home; slid tile ${bef[nb2]} from ${nb2} to ${e2}, same colour ${JSON.stringify(sA.rgb)}, moves 1`);
    }
  });

  // image-no-numbers: C3. No digit text and no digit drawn into the pixels.
  await run('image-no-numbers', async ({ page, dir, say }) => {
    for (const n of [3, 6]) {
      await newImageUI(page, n, n);
      await cropDoneUI(page);
      const info = await page.$$eval('#board .tile.image', (els) => els.map((e) => ({
        inner: e.innerText.trim(), text: e.textContent, before: getComputedStyle(e, '::before').content, after: getComputedStyle(e, '::after').content,
        kids: [...e.children].map((k) => k.tagName), aria: e.getAttribute('aria-label'), v: e.getAttribute('aria-label'),
      })));
      eq(info.length, n * n - 1, `${n}x${n} image tile count`);
      for (const t of info) {
        eq(t.inner, '', `${t.aria} innerText`);
        eq(t.text, '', `${t.aria} textContent`);
        ok(t.before === 'none' || t.before === 'normal', `${t.aria} ::before content ${t.before}`);
        eq(t.after, '""', `${t.aria} ::after content`);
        eq(t.kids, ['CANVAS'], `${t.aria} children`);
        ok(/^Tile \d+$/.test(t.aria), 'aria-label ' + t.aria);
      }
      const grids = await pieceGrid(page);
      for (const [gi, g] of grids.entries()) {
        for (let a = 0; a < 5; a++) {
          for (let b = 1; b < 5; b++) {
            ok(g[a][b][0] >= g[a][b - 1][0] - 2, `${n}x${n} piece ${gi + 1}: R decreases along x at row ${a}`);
            ok(g[b][a][1] >= g[b - 1][a][1] - 2, `${n}x${n} piece ${gi + 1}: G decreases along y at column ${a}`);
          }
        }
      }
      say(`${n}x${n}: ${info.length} image tiles, no text, ::after "", one canvas each, 5x5 samples monotone`);
      await shot(page, dir, `screenshot-${n}x${n}.png`);
    }
  });

  // image-crop-default: C4. The default crop is the cover crop; the preview matches the pieces; DPR 2 too.
  await run('image-crop-default', async ({ page, dir, say }) => {
    const cases = [['landscape.png', 3, 3, { sx: 100, sy: 0, cw: 400, ch: 400 }], ['landscape.png', 3, 6, { sx: 0, sy: 50, cw: 600, ch: 300 }], ['portrait.png', 4, 3, { sx: 0, sy: 100 / 3, cw: 400, ch: 1600 / 3 }]];
    const one = async (pg, name, r, c, lit, dpr, tag) => {
      const fx = FIX[name];
      const startBoard = await board(pg);
      await newImageUI(pg, r, c, name);
      ok(await pg.$eval('#crop-dialog', (e) => e.matches(':modal')), tag + ': crop dialog not modal');
      eq(await pg.$eval('#crop-zoom', (e) => [e.min, e.max, e.value]), ['1', '4', '1'], tag + ' zoom range');
      const v = await rect(pg, '#crop-view'), d = await rect(pg, '#crop-dialog');
      const A = c / r;
      ok(Math.abs(v.w - v.h * A) <= 1, `${tag}: view ${v.w}x${v.h} not within 1px of aspect ${A}`);
      ok(inside(v, d) && v.l >= 0 && v.t >= 0 && v.r <= 1280 && v.b <= 800, tag + ': view outside dialog or viewport');
      eq(await board(pg), startBoard, tag + ': board behind the dialog changed');
      const bs = await pg.$eval('#crop-view', (e) => [e.width, e.height]);
      ok(Math.abs(bs[0] - v.w * dpr) <= 2 && Math.abs(bs[1] - v.h * dpr) <= 2, `${tag}: backing store ${bs} is not ${dpr}x the view ${v.w}x${v.h}`);
      const o = cropOracle(fx.W, fx.H, r, c, 1, fx.W / 2, fx.H / 2);
      for (const k of Object.keys(lit)) ok(Math.abs(o[k] - lit[k]) < 1e-6, `${tag}: oracle ${k} ${o[k]} differs from the plan's ${lit[k]}`);
      if (pg === page) await shot(pg, dir, `crop-${name.replace('.png', '')}-${r}x${c}.png`);
      await expectCrop(pg, fx, r, c, 1, fx.W / 2, fx.H / 2, tag, say);
      say(`${tag}: view ${v.w}x${v.h}, backing ${bs}, modal, zoom 1..4 at 1`);
    };
    for (const [name, r, c, lit] of cases) await one(page, name, r, c, lit, 1, `${name} ${r}x${c}`);
    const hi = await newPage({ deviceScaleFactor: 2 });
    try {
      await one(hi.page, 'landscape.png', 3, 3, cases[0][3], 2, 'DPR2 landscape.png 3x3');
    } finally {
      await hi.ctx.close();
    }
  });

  // image-crop: C4. Drag, zoom, keys and Centre set the crop, on both axes.
  await run('image-crop', async ({ page, say }) => {
    const fx = FIX['landscape.png'];
    const dims = async () => { const v = await rect(page, '#crop-view'); return { Vw: v.w, Vh: v.h }; };
    await newImageUI(page, 3, 3);
    await setZoom(page, 2);
    await expectCrop(page, fx, 3, 3, 2, 300, 200, '(a) zoom 2', say);
    await newImageUI(page, 3, 3);
    await setZoom(page, 2);
    let { Vw, Vh } = await dims();
    await dragView(page, 0.25 * Vw, 0.25 * Vh);
    await expectCrop(page, fx, 3, 3, 2, 250, 150, '(b) zoom 2 drag +0.25', say);
    await newImageUI(page, 3, 3);
    await setZoom(page, 2);
    ({ Vw, Vh } = await dims());
    await dragView(page, -2 * Vw, -2 * Vh);
    await expectCrop(page, fx, 3, 3, 2, 500, 300, '(c) zoom 2 drag -2 clamps', say);
    await newImageUI(page, 3, 3);
    await setZoom(page, 2);
    ({ Vw, Vh } = await dims());
    await dragView(page, -2 * Vw, -2 * Vh);
    await page.click('#crop-centre');
    await expectCrop(page, fx, 3, 3, 2, 300, 200, '(d) drag then Centre', say);
    await newImageUI(page, 3, 3);
    await setZoom(page, 2);
    await page.focus('#crop-view');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await expectCrop(page, fx, 3, 3, 2, 340, 200, '(e) zoom 2 ArrowLeft x4', say);
    await newImageUI(page, 3, 3);
    ({ Vw, Vh } = await dims());
    await dragView(page, Vw, 0);
    await expectCrop(page, fx, 3, 3, 1, 200, 200, '(f) zoom 1 drag +Vw clamps', say);
    await newImageUI(page, 3, 6);
    await setZoom(page, 2);
    ({ Vw, Vh } = await dims());
    await dragView(page, -2 * Vw, -2 * Vh);
    await expectCrop(page, fx, 3, 6, 2, 450, 325, '(g) 3x6 zoom 2 drag -2 clamps', say);
    await newImageUI(page, 3, 6);
    await setZoom(page, 2);
    await page.focus('#crop-view');
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowUp');
    await expectCrop(page, fx, 3, 6, 2, 300, 215, '(h) 3x6 zoom 2 ArrowUp x2', say);
  }, { video: true });

  // crop-cancel: C4. Cancel and Escape leave the game alone.
  await run('crop-cancel', async ({ page, say }) => {
    const fx = FIX['landscape.png'];
    await click(page, 7);
    await sleep(1200);
    const b0 = await board(page);
    ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, 'setup: moves 1 and timer >= 1');
    for (const how of ['Cancel', 'Escape']) {
      await newImageUI(page, 3, 3);
      const t0 = await timerOf(page);
      if (how === 'Cancel') await page.click('#crop-cancel'); else await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('crop-dialog').open);
      eq(await board(page), b0, `${how}: board`);
      eq(await movesOf(page), 1, `${how}: moves`);
      eq(await page.$$eval('#board canvas', (e) => e.length), 0, `${how}: kind changed to image`);
      await sleep(1200);
      ok((await timerOf(page)) > t0, `${how}: timer stopped (${t0} -> ${await timerOf(page)})`);
      say(`${how}: board, moves and kind unchanged; timer kept counting`);
    }
    // Image puzzle, moved; New -> 4x4 -> Image with no file reuses the image.
    await newImageUI(page, 3, 3);
    await cropDoneUI(page);
    await click(page, 7);
    const b1 = await imgBoard(page);
    await page.click('#new');
    await page.selectOption('#rows', '4');
    await page.selectOption('#cols', '4');
    await page.check('#kind-image');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    const v = await rect(page, '#crop-view');
    ok(Math.abs(v.w - v.h) <= 1, `reused-image crop at 4x4 is not square: ${v.w}x${v.h}`);
    await page.click('#crop-cancel');
    await page.waitForFunction(() => !document.getElementById('crop-dialog').open);
    eq(await imgBoard(page), b1, 'image board after Cancel');
    eq(await movesOf(page), 1, 'image moves after Cancel');
    eq(await page.$$eval('#board .tile', (e) => e.length), 9, 'still 3x3');
    const pc = await expectPieces(page, fx, 3, 3, cropOracle(fx.W, fx.H, 3, 3, 1, fx.W / 2, fx.H / 2), 'after Cancel');
    say(`image puzzle kept after Cancel: 3x3, ${pc.count} pieces still at their home cells`);
  });

  // new-dialog: C5. The New button and its dialog.
  await run('new-dialog', async ({ page, say }) => {
    eq(await page.textContent('#new'), 'New', 'New text');
    ok(await page.isVisible('#new'), '#new not visible');
    ok(!(await isOpen(page, 'new-dialog')) && !(await isOpen(page, 'crop-dialog')), 'a dialog is open at load');
    await click(page, 7);
    await sleep(1200);
    const b0 = await board(page);
    await page.click('#new');
    ok(await isOpen(page, 'new-dialog'), 'New dialog not open');
    ok(await page.$eval('#new-dialog', (e) => e.matches(':modal')), 'New dialog not modal');
    eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['3', '3'], 'prefilled size');
    ok(await page.isChecked('#kind-numbers'), 'Numbers not checked');
    eq(await page.getByLabel('Numbers').evaluate((e) => e.id), 'kind-numbers', 'Numbers label');
    eq(await page.getByLabel('Image', { exact: true }).evaluate((e) => e.id), 'kind-image', 'Image label');
    eq(await page.$eval('fieldset.kind legend', (e) => e.textContent.trim()), 'Tiles', 'legend');
    ok(await page.$$eval('fieldset.kind input[type=radio]', (e) => e.length === 2), 'radios not inside the Tiles fieldset');
    for (const how of ['Cancel', 'Escape']) {
      if (how === 'Escape') await page.click('#new');
      const t0 = await timerOf(page);
      if (how === 'Cancel') await page.click('#new-cancel'); else await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('new-dialog').open);
      eq(await board(page), b0, `${how}: board`);
      eq(await movesOf(page), 1, `${how}: moves`);
      await sleep(1200);
      ok((await timerOf(page)) > t0, `${how}: timer stopped`);
      say(`${how}: dialog closed, board and moves unchanged, timer still counting`);
    }
  });

  // new-numbers: C5. Choosing numbers returns to numbered tiles, with a full reset.
  await run('new-numbers', async ({ page, say }) => {
    await newImageUI(page, 4, 5);
    await cropDoneUI(page);
    await click(page, 18);
    await sleep(1200);
    ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, 'setup: moves 1 and timer >= 1');
    await page.click('#new');
    ok(await page.isChecked('#kind-image'), 'Image not prefilled');
    eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['4', '5'], 'prefilled size');
    await page.check('#kind-numbers');
    await page.selectOption('#rows', '5');
    await page.selectOption('#cols', '3');
    await page.click('#new-start');
    await page.waitForFunction(() => !document.getElementById('new-dialog').open);
    eq(await board(page), solvedBoard(15), 'board');
    eq(await page.$$eval('#board canvas', (e) => e.length), 0, 'canvas in board');
    ok(await page.$$eval('#board .tile:not(.empty)', (els) => els.every((e) => /^\d+$/.test(e.textContent.trim()))), 'a tile lacks numeric text');
    eq(await movesOf(page), 0, 'moves');
    eq(await timerOf(page), 0, 'timer');
    ok(!(await page.isVisible('#message')), 'message visible');
    say('4x5 image puzzle -> New, Numbers, 5x3: solved numbers, no canvas, moves 0, timer 0s');
  });

  // image-reset: C7. Starting an image puzzle resets the game, from three kinds of starting state.
  await run('image-reset', async ({ page, say }) => {
    const common = async (tag) => {
      eq(await imgBoard(page), solvedBoard(9), tag + ' board');
      eq(await page.$$eval('#board .tile.image', (e) => e.length), 8, tag + ' image tiles');
      eq(await movesOf(page), 0, tag + ' moves');
      eq(await timerOf(page), 0, tag + ' timer');
      await sleep(1500);
      eq(await timerOf(page), 0, tag + ' timer after 1.5s');
      ok(!(await page.isVisible('#message')), tag + ' message visible');
      await click(page, 7);
      await sleep(1200);
      ok((await timerOf(page)) >= 1, tag + ' timer does not run after a move');
      say(`${tag}: image board solved, moves 0, timer 0 (still 0 after 1.5s), message hidden, timer runs after a move`);
    };
    await click(page, 7);
    await sleep(1200);
    ok((await movesOf(page)) === 1 && (await timerOf(page)) >= 1, '(a) setup');
    await newImageUI(page, 3, 3);
    await cropDoneUI(page);
    await common('(a) numbers -> image');
    await click(page, 8);
    ok(await page.isVisible('#message'), '(b) setup: message not visible after the solve');
    await newImageUI(page, 3, 3);
    await cropDoneUI(page);
    await common('(b) solved image -> image');
    ok((await timerOf(page)) >= 1, '(c) setup: timer >= 1');
    await page.click('#new');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(page);
    await common('(c) moved image -> reused image');
  });

  // image-errors: C5. Refused input and the decode races, under the declared timing gate.
  await run('image-errors', async ({ page, say }) => {
    const startNewFlow = async (pg, fixName) => {
      const fx = FIX[fixName];
      await pg.click('#new');
      await pg.check('#kind-image');
      await pg.setInputFiles('#image-file', { name: fx.name, mimeType: fx.mimeType, buffer: fx.buffer });
      await pg.click('#new-start');
    };
    // (a) no file, no current image
    await page.click('#new');
    await page.check('#kind-image');
    await page.click('#new-start');
    await page.waitForSelector('#new-error:not([hidden])');
    eq((await page.textContent('#new-error')).trim(), 'Choose an image file.', '(a) message');
    ok(await isOpen(page, 'new-dialog'), '(a) dialog closed');
    eq(await board(page), SOLVED, '(a) board');
    say('(a) no file: "Choose an image file.", dialog open, game unchanged');
    // (b) a non-image
    const bad = FIX['notes.txt'];
    await page.setInputFiles('#image-file', { name: bad.name, mimeType: bad.mimeType, buffer: bad.buffer });
    await page.click('#new-start');
    await page.waitForFunction(() => document.getElementById('new-error').textContent.includes('not an image'));
    eq((await page.textContent('#new-error')).trim(), 'That file is not an image.', '(b) error text');
    ok(await isOpen(page, 'new-dialog'), '(b) dialog closed');
    ok(await page.isEnabled('#new-start'), '(b) Start still disabled');
    eq(await board(page), SOLVED, '(b) board');
    say('(b) notes.txt: "That file is not an image.", dialog open, game unchanged');
    // (c) recover with a good file
    const good = FIX['landscape.png'];
    await page.setInputFiles('#image-file', { name: good.name, mimeType: good.mimeType, buffer: good.buffer });
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    ok(await page.$eval('#new-error', (e) => e.hidden), '(c) error still shown');
    await page.click('#crop-cancel');
    say('(c) landscape.png after the error: error cleared, crop dialog opened');
    // Race cases under the gate: createImageBitmap is delayed per call, FIFO, then the real decoder runs.
    const gated = async (fn) => {
      const g = await newPage();
      try {
        await g.page.evaluate(() => {
          window.__gate = [];
          const real = window.createImageBitmap.bind(window);
          window.createImageBitmap = (...a) => new Promise((resolve) => window.__gate.push(resolve)).then(() => real(...a));
        });
        await fn(g.page);
      } finally {
        await g.ctx.close();
      }
    };
    const gateLen = (pg) => pg.evaluate(() => window.__gate.length);
    const release = (pg) => pg.evaluate(() => { const r = window.__gate.shift(); if (r) r(); });
    const waitGate = (pg, n) => pg.waitForFunction((k) => window.__gate.length === k, n);
    await gated(async (pg) => {
      // (d) + (e): Escape during a pending decode
      await click(pg, 7);
      const b0 = await board(pg);
      await startNewFlow(pg, 'landscape.png');
      await waitGate(pg, 1);
      ok(await pg.isDisabled('#new-start'), '(e) Start not disabled during the decode');
      await pg.keyboard.press('Escape');
      await release(pg);
      await sleep(300);
      ok(!(await isOpen(pg, 'crop-dialog')), '(d) crop dialog opened after Escape');
      ok(!(await isOpen(pg, 'new-dialog')), '(d) New dialog reopened');
      eq(await board(pg), b0, '(d) board');
      eq(await movesOf(pg), 1, '(d) moves');
      eq(await pg.$$eval('#board canvas', (e) => e.length), 0, '(d) kind changed');
      await pg.click('#new');
      ok(await pg.isEnabled('#new-start'), '(e) Start disabled at the next open');
      await pg.keyboard.press('Escape');
      say('(d) Escape during decode: no crop dialog, game unchanged; (e) Start disabled while pending, enabled again at the next open');
    });
    for (const [label, first] of [['(f) stale token', 'landscape.png'], ['(f2) stale rejection', 'notes.txt']]) {
      await gated(async (pg) => {
        await startNewFlow(pg, first);
        await waitGate(pg, 1);
        await pg.keyboard.press('Escape');
        await startNewFlow(pg, 'landscape.png');
        await waitGate(pg, 2);
        await release(pg);
        await sleep(300);
        ok(!(await isOpen(pg, 'crop-dialog')), label + ': crop dialog opened from the stale decode');
        ok(await pg.$eval('#new-error', (e) => e.hidden), label + ': error shown by the stale decode');
        eq(await gateLen(pg), 1, label + ': second decode not pending');
        await release(pg);
        await pg.waitForSelector('#crop-dialog[open]');
        say(`${label}: first decode released alone changed nothing; the second opened the crop dialog`);
      });
    }
  });

  // image-layout: C8. Image boards fit every view like numbered ones.
  await run('image-layout', async ({ page, dir, say }) => {
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [r, c] of [[3, 3], [6, 6], [3, 6], [6, 3], [10, 10], [3, 10], [10, 3]]) {
        await newImageUI(page, r, c);
        await cropDoneUI(page);
        const m = await page.evaluate(() => {
          const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height }; };
          const tiles = [...document.querySelectorAll('.tile')].map(rc);
          const canvases = [...document.querySelectorAll('.tile.image')].map((e) => ({ tile: rc(e), canvas: rc(e.querySelector('canvas')) }));
          return { tiles, canvases, well: rc(document.querySelector('.well')), fr: rc(document.getElementById('frame')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
        });
        const tag = `${w}x${h} ${r}x${c}`;
        say(`${tag}: tile ${m.tiles[0].w.toFixed(1)}px`);
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => Math.abs(q.w - q.h) <= 1), tag + ': tiles not square');
        ok(m.tiles.every((q) => q.w >= (r <= 6 && c <= 6 ? 40 : 24)), `${tag}: tile under the floor`);
        ok(m.tiles.every((q) => inside(q, m.well)), tag + ': tile outside well');
        ok(inside(m.well, m.fr), tag + ': well outside frame');
        ok(m.canvases.every((x) => ['l', 'r', 't', 'b'].every((k) => Math.abs(x.tile[k] - x.canvas[k]) <= 1)), tag + ': canvas box differs from tile box');
        await shot(page, dir, `${r}x${c}-${w}.png`);
      }
    }
  });

  // dialog-layout: C8. The two dialogs fit and read on every view.
  await run('dialog-layout', async ({ page, dir, say }) => {
    const metrics = (sel, withView) => page.evaluate(([sel, withView]) => {
      const d = document.querySelector(sel);
      const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom, w: q.width, h: q.height }; };
      const nums = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const leaves = [...d.querySelectorAll('label, legend, .hint, h2, button')].filter((e) => e.getClientRects().length > 0).map((e) => ({ name: e.tagName + (e.id ? '#' + e.id : ''), colour: nums(getComputedStyle(e).color) }));
      const all = [d, ...d.querySelectorAll('*')];
      const greens = all.flatMap((e) => { const cs = getComputedStyle(e); return [['color', cs.color], ['background', cs.backgroundColor]].map(([k, v]) => ({ name: e.tagName + (e.id ? '#' + e.id : '') + ' ' + k, c: nums(v) })); }).filter((x) => x.c.length === 3 && x.c[1] > x.c[0] + 20 && x.c[1] > x.c[2] + 20).map((x) => x.name);
      return {
        d: rc(d), sw: d.scrollWidth, cw: d.clientWidth, docCw: document.documentElement.clientWidth, ih: window.innerHeight,
        controls: [...d.querySelectorAll('button, select')].filter((e) => e.getClientRects().length > 0).map((e) => ({ name: e.id, box: rc(e) })),
        view: withView ? rc(d.querySelector('#crop-view')) : null, leaves, greens,
      };
    }, [sel, withView]);
    const verify = async (sel, tag, withView, A) => {
      const m = await metrics(sel, withView);
      ok(m.d.l >= 0 && m.d.r <= m.docCw && m.d.t >= 0 && m.d.b <= m.ih, `${tag}: dialog box ${JSON.stringify(m.d)} outside the viewport`);
      ok(m.sw <= m.cw, `${tag}: dialog scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      ok(m.controls.length >= 2, tag + ': no controls found');
      for (const k of m.controls) ok(inside(k.box, m.d), `${tag}: ${k.name} outside the dialog`);
      if (withView) {
        ok(inside(m.view, m.d), tag + ': crop view outside the dialog');
        ok(Math.abs(m.view.h - m.view.w / A) <= 1, `${tag}: crop view ${m.view.w}x${m.view.h} not within 1px of aspect ${A} (height vs width / aspect, the dimension openCrop rounds)`);
      }
      const bg = await colours(page, sel);
      nonVacuous(bg, tag + ' dialog background', say);
      ok(bg.every((x) => maxc(x) <= 48), tag + ': dialog background not dark plastic');
      for (const l of m.leaves) ok(l.colour.every((v) => v >= 230), `${tag}: ${l.name} text colour ${l.colour} below 230`);
      ok(m.leaves.length >= 4, tag + ': too few text leaves checked');
      eq(m.greens, [], tag + ' green text or background');
      say(`${tag}: dialog ${m.d.w.toFixed(0)}x${m.d.h.toFixed(0)} at (${m.d.l.toFixed(0)}, ${m.d.t.toFixed(0)}), ${m.controls.length} controls inside, ${m.leaves.length} text leaves light`);
    };
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      await page.click('#new');
      await verify('#new-dialog', `${w}x${h} New`, false);
      ok(!isGreen(rgbOf(await style(page, '#new-error', 'color'))), 'new-error is green');
      await shot(page, dir, `new-${w}.png`);
      await page.click('#new-cancel');
      for (const [r, c] of [[3, 6], [6, 3], [3, 10], [10, 3]]) {
        await newImageUI(page, r, c);
        await verify('#crop-dialog', `${w}x${h} crop ${r}x${c}`, true, c / r);
        await shot(page, dir, `crop-${r}x${c}-${w}.png`);
        await page.click('#crop-cancel');
      }
    }
  });

  // ---- #13 preset pictures. Servers start one after another; every one is stopped before the run ends. ----
  const S = {};
  let srvErr = null;
  let cn = null;
  const realFiles = fs.readdirSync(path.join(ROOT, 'images')).filter((f) => R1.test(f));
  const A_NAMES = ['Grad – Landscape ’1’', 'portrait', 'Plain', 'Shot', 'Anim', 'Next', 'UPPER', '50% #1', "Bust (detail) 'x'", 'broken'];
  const A_IGNORED = ['notes', 'readme', 'noext', 'archive.jpg', '.hidden', 'sub', 'inner'];
  try {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shuffle-http-'));
    const indexBytes = fs.readFileSync(path.join(ROOT, 'index.html'));
    const put = (root, rel, bytes) => { const f = path.join(tmpRoot, root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); };
    for (const r of ['A', 'B', 'C', 'D']) put(r, 'index.html', indexBytes);
    const shippedSettings = fs.readFileSync(path.join(ROOT, 'settings.json'));
    for (const r of ['A', 'B', 'C', 'D']) put(r, 'settings.json', shippedSettings);
    ok(Buffer.compare(fs.readFileSync(path.join(tmpRoot, 'A', 'index.html')), indexBytes) === 0, 'A/index.html is not a byte copy');
    put('A', 'images/Grad – Landscape ’1’.png', FIX['landscape.png'].buffer);
    put('A', 'images/portrait.PNG', FIX['portrait.png'].buffer);
    for (const f of ['Plain.jpeg', 'Shot.WEBP', 'Anim.gif', 'Next.avif', 'UPPER.JPG', '50% #1.png', "Bust (detail) 'x'.jpg"]) put('A', 'images/' + f, 'placeholder, listed but never decoded');
    put('A', 'images/broken.jpg', 'hello');
    for (const f of ['notes.txt', 'readme.md', 'noext', 'archive.jpg.zip', '.hidden.txt', 'sub/inner.png']) put('A', 'images/' + f, 'ignored');
    put('C', 'images/index.html', '<p>no listing</p>');
    fs.mkdirSync(path.join(tmpRoot, 'D', 'images'), { recursive: true });
    const frag = (realFiles[0] || 'x').match(/[A-Za-z]{4,}/)[0];
    S.real = await serve(ROOT, async (o) => { const r = await httpGet(o + '/images/'); return r.status === 200 && r.body.includes(frag); });
    S.a = await serve(path.join(tmpRoot, 'A'), async (o) => { const r = await httpGet(o + '/images/'); return r.status === 200 && r.body.includes('portrait'); });
    S.b = await serve(path.join(tmpRoot, 'B'), async (o) => (await httpGet(o + '/images/')).status === 404);
    S.c = await serve(path.join(tmpRoot, 'C'), async (o) => (await httpGet(o + '/images/')).body.includes('no listing'));
    S.d = await serve(path.join(tmpRoot, 'D'), async (o) => { const r = await httpGet(o + '/images/'); return r.status === 200 && !r.body.includes('<li>'); });
    cn = await canned(FIX['landscape.png'].buffer);
    for (const [k, body] of [['s-edit', S_EDIT], ['s-missing', null], ['s-bad', S_BAD], ['s-values', S_VALUES], ['s-near', S_NEAR], ['s-flip', S_FLIP]]) {
      S[k] = await serve(settingsRoot(k, body), settingsProbe(body));
    }
  } catch (e) {
    srvErr = e.message;
  }
  const need = () => { if (srvErr) throw new Error('fixture servers failed to start: ' + srvErr); };
  const U = (s) => (s ? s.origin + '/' : undefined);
  const withPage = async (pageUrl, fn, opts = {}) => {
    const g = await newPage(opts, pageUrl);
    try { return await fn(g.page); } finally { await g.ctx.close(); }
  };
  const nums = async (pg) => (await imgBoard(pg)).map((x) => (x === '_' ? 0 : Number(x)));

  // preset-list: AC1, R1, R2. The New dialog lists every recognised image of images/, named from the file, and nothing else.
  await run('preset-list', async ({ page, dir, say }) => {
    need();
    ok(realFiles.length >= 1, 'images/ holds no recognised image');
    const wantReal = realFiles.map(stemOf).sort();
    for (const p of ['/', '/index.html']) {
      await page.goto(S.real.origin + p);
      await page.click('#new');
      await presetRowVisible(page);
      const opts = await presetOptions(page);
      eq(opts.map((o) => o.text).sort(), wantReal, `REAL ${p} names`);
      for (const o of opts) {
        const file = realFiles.find((f) => stemOf(f) === o.text);
        eq(decodeURIComponent(new URL(o.value).pathname), '/images/' + file, `REAL ${p} value for ${o.text}`);
      }
      ok(await page.$eval('#preset-note', (e) => e.hidden), `REAL ${p}: note visible`);
      ok(await page.isChecked('#kind-numbers'), `REAL ${p}: listing changed the tile kind`);
      say(`REAL ${p}: ${opts.length} options: ${JSON.stringify(opts.map((o) => o.text))}`);
      if (p === '/') await shot(page, dir, 'screenshot.png');
      await page.click('#new-cancel');
    }
    await page.goto(S.a.origin + '/');
    await page.click('#new');
    await presetRowVisible(page);
    const names = await presetNames(page);
    eq([...names].sort(), [...A_NAMES].sort(), 'A names');
    eq(names, [...names].sort((x, y) => x.localeCompare(y)), 'A options sorted by name');
    for (const bad of A_IGNORED) ok(!names.includes(bad), `A lists ignored entry ${bad}`);
    ok(await page.$eval('#preset-note', (e) => e.hidden), 'A: note visible');
    ok(await page.isChecked('#kind-numbers'), 'A: listing changed the tile kind');
    say('A names: ' + JSON.stringify(names));
    await shot(page, dir, 'fixtures-dialog.png');
  }, { url: U(S.real) });

  // preset-refresh: AC2. A file added to images/ is listed the next time New opens, without a reload.
  await run('preset-refresh', async ({ page, say }) => {
    need();
    const fresh = path.join(tmpRoot, 'A', 'images', 'Fresh – Añadida.png');
    try {
      await page.evaluate(() => { window.__mark = 1; });
      let n0 = countLog(S.a, '/images/');
      await page.click('#new');
      await presetRowVisible(page);
      const before = await presetNames(page);
      await page.click('#new-cancel');
      await sleep(200);
      eq(countLog(S.a, '/images/') - n0, 1, 'listing requests for the first open');
      ok(!before.includes('Fresh – Añadida'), 'fresh name listed before it exists');
      fs.writeFileSync(fresh, FIX['landscape.png'].buffer);
      n0 = countLog(S.a, '/images/');
      await page.click('#new');
      await page.waitForFunction(() => [...document.querySelectorAll('#preset option')].some((o) => o.textContent === 'Fresh – Añadida'));
      eq(await page.evaluate(() => window.__mark), 1, 'page reloaded (marker lost)');
      await page.selectOption('#preset', { label: 'Fresh – Añadida' });
      await page.click('#new-start');
      await page.waitForSelector('#crop-dialog[open]');
      await page.click('#crop-cancel');
      eq(countLog(S.a, '/images/') - n0, 1, 'listing requests for the second open');
      say('fresh file listed on the next open, no reload, crop dialog opened (it decodes)');
      fs.rmSync(fresh);
      n0 = countLog(S.a, '/images/');
      await page.click('#new');
      await presetRowVisible(page);
      const after = await presetNames(page);
      await page.click('#new-cancel');
      await sleep(200);
      ok(!after.includes('Fresh – Añadida'), 'deleted file still listed');
      eq(countLog(S.a, '/images/') - n0, 1, 'listing requests for the third open');
      eq([...after].sort(), [...A_NAMES].sort(), 'names after deleting');
      say('deleted file gone on the next open; one GET /images/ per open');
    } finally {
      fs.rmSync(fresh, { force: true });
    }
  }, { url: U(S.a) });

  // preset-play: AC3. A preset goes through the crop dialog and plays as an own file does (video).
  await run('preset-play', async ({ page, dir, say }) => {
    need();
    const land = FIX['landscape.png'], port = FIX['portrait.png'];
    const NAME_L = 'Grad – Landscape ’1’';
    await newPresetUI(page, 3, 3, NAME_L);
    await expectCrop(page, land, 3, 3, 1, 300, 200, 'A 3x3 preset', say);
    const info = await page.$$eval('#board .tile.image', (els) => els.map((e) => ({ inner: e.textContent, kids: [...e.children].map((k) => k.tagName), aria: e.getAttribute('aria-label') })));
    eq(info.length, 8, 'image tile count');
    for (const t of info) { eq(t.inner, '', t.aria + ' text'); eq(t.kids, ['CANVAS'], t.aria + ' children'); ok(/^Tile \d+$/.test(t.aria), 'aria-label ' + t.aria); }
    eq(await page.$$eval('#board canvas', (e) => e.length), 8, 'canvas count');
    eq(await movesOf(page), 0, 'moves after Done');
    eq(await timerOf(page), 0, 'timer after Done');
    ok(await page.$eval('#message', (e) => e.hidden), 'message visible after Done');
    const o = cropOracle(land.W, land.H, 3, 3, 1, 300, 200);
    for (let k = 0; k < 5; k++) {
      await page.click('#shuffle');
      const b = await nums(page);
      ok(oracleSolvable(b, 3, 3), `shuffle ${k + 1}: board not solvable ${b}`);
      ok(b.join() !== SOLVED3, `shuffle ${k + 1}: board solved`);
      await expectPieces(page, land, 3, 3, o, `shuffle ${k + 1}`);
    }
    const e0 = (await nums(page)).indexOf(0);
    await click(page, e0 % 3 > 0 ? e0 - 1 : e0 + 1);
    eq(await movesOf(page), 1, 'moves after one slide');
    say('3x3 preset: crop at the oracle, no numbers, 5 shuffles solvable with pieces home, one slide counted');
    await newPresetUI(page, 3, 6, 'portrait');
    await setZoom(page, 2);
    const v = await rect(page, '#crop-view');
    await dragView(page, -2 * v.w, -2 * v.h);
    await expectCrop(page, port, 3, 6, 2, 300, 500, 'A 3x6 portrait zoom 2 drag -2 clamps', say);
    await page.goto(S.real.origin + '/');
    const hok = realFiles.map(stemOf).find((n) => n.includes('Hokusai'));
    ok(hok, 'no Hokusai preset in images/');
    await newPresetUI(page, 4, 4, hok);
    await cropDoneUI(page);
    eq(await page.$$eval('#board .tile.image canvas', (e) => e.length), 15, 'REAL 4x4 canvases');
    const colours15 = new Set((await pieceSample(page)).map((p) => p.rgb.join()));
    ok(colours15.size >= 3, `REAL 4x4: only ${colours15.size} distinct tile centre colours`);
    say(`REAL 4x4 ${hok}: 15 image tiles, ${colours15.size} distinct centre colours`);
    await shot(page, dir, 'screenshot.png');
    await page.goto(S.a.origin + '/');
    await setSizeUI(page, 3, 3);
    await click(page, 7);
    const b0 = await board(page);
    await sleep(1200);
    const t1 = await timerOf(page);
    ok(t1 >= 1, 'timer not running before the cancels');
    for (const how of ['Cancel', 'Escape']) {
      await newPresetUI(page, 3, 3, NAME_L);
      if (how === 'Cancel') await page.click('#crop-cancel'); else await page.keyboard.press('Escape');
      ok(!(await isOpen(page, 'crop-dialog')), how + ': crop dialog still open');
      eq(await board(page), b0, how + ': board');
      eq(await movesOf(page), 1, how + ': moves');
      eq(await page.$$eval('#board canvas', (e) => e.length), 0, how + ': kind changed');
    }
    await sleep(1200);
    ok((await timerOf(page)) >= t1 + 1, 'timer stopped counting');
    await page.click('#new');
    await presetRowVisible(page);
    await page.selectOption('#cols', '4');
    await page.selectOption('#rows', '4');
    await page.selectOption('#preset', { label: NAME_L });
    await page.check('#kind-numbers');
    await page.click('#new-start');
    await page.waitForFunction(() => !document.getElementById('new-dialog').open);
    eq(await board(page), solvedBoard(16), 'Numbers with a preset selected');
    eq(await page.$$eval('#board canvas', (e) => e.length), 0, 'Numbers with a preset: canvases');
    say('Cancel and Escape on the crop leave the numbers game and a running timer alone; Numbers wins over a selected preset');
  }, { video: true, url: U(S.a) });

  // preset-own-file: AC4. Own files behave as in #3, and a preset and a file never both apply.
  await run('preset-own-file', async ({ page, say }) => {
    need();
    const land = FIX['landscape.png'], port = FIX['portrait.png'];
    await newImageUI(page, 3, 3, 'landscape.png');
    await expectCrop(page, land, 3, 3, 1, 300, 200, 'own landscape 3x3', say);
    await page.click('#new');
    await presetRowVisible(page);
    await page.selectOption('#rows', '3');
    await page.selectOption('#cols', '3');
    await page.selectOption('#preset', { label: 'portrait' });
    ok(await page.isChecked('#kind-image'), 'choosing a preset did not select Image');
    await page.setInputFiles('#image-file', { name: land.name, mimeType: land.mimeType, buffer: land.buffer });
    eq(await page.$eval('#preset', (e) => e.value), '', 'preset after choosing a file');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await expectCrop(page, land, 3, 3, 1, 300, 200, 'preset then file follows the file', say);
    await page.click('#new');
    await presetRowVisible(page);
    await page.selectOption('#rows', '4');
    await page.selectOption('#cols', '3');
    await page.setInputFiles('#image-file', { name: land.name, mimeType: land.mimeType, buffer: land.buffer });
    await page.selectOption('#preset', { label: 'portrait' });
    eq(await page.$eval('#image-file', (e) => e.files.length), 0, 'file input after choosing a preset');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await expectCrop(page, port, 4, 3, 1, 200, 300, 'file then preset follows the preset', say);
    await page.click('#new');
    await presetRowVisible(page);
    ok(await page.isChecked('#kind-image'), 'reuse: Image not preselected');
    eq(await page.$eval('#preset', (e) => e.value), '', 'reuse: preset not reset on open');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await expectCrop(page, port, 4, 3, 1, 200, 300, 'reuse of the current image', say);
  }, { url: U(S.a) });

  // preset-fallback: AC5. On file://, or with no usable listing, the dialog degrades quietly.
  await run('preset-fallback', async ({ page, dir, say }) => {
    need();
    const flow = async (pg, tag, note, shotName) => {
      const before = errors.length;
      await pg.click('#new');
      await pg.waitForFunction((t) => !document.getElementById('preset-note').hidden && document.getElementById('preset-note').textContent === t, note);
      ok(await pg.$eval('#preset-row', (e) => e.hidden), `${tag}: Picture row visible`);
      eq(await pg.$$eval('#preset option', (o) => o.length), 1, `${tag}: options beyond the placeholder`);
      await shot(pg, dir, shotName);
      await pg.click('#new-cancel');
      await setSizeUI(pg, 4, 4);
      eq(await board(pg), solvedBoard(16), `${tag}: 4x4 numbers board`);
      await newImageUI(pg, 4, 4);
      await cropDoneUI(pg);
      eq(await pg.$$eval('#board .tile.image', (e) => e.length), 15, `${tag}: image tiles`);
      eq(errors.slice(before).filter((e) => e.text.startsWith('pageerror')), [], `${tag}: pageerror`);
      say(`${tag}: note "${note}", row hidden, numbers 4x4 and own file work`);
    };
    const seen = [];
    page.on('request', (r) => seen.push(r.url()));
    await page.goto(PAGE_URL);
    await flow(page, '(a) file://', 'Preset pictures need Shuffle served over HTTP (see README).', 'fallback-a-file.png');
    eq(seen.filter((u) => u !== PAGE_URL && u !== 'data:,'), [], '(a) requests other than the page');
    expectConsole(S.b.origin + '/images/');
    const NONE = 'No preset pictures found.';
    for (const [tag, srv, nm] of [['(b) 404', S.b, 'fallback-b-404.png'], ['(c) no links', S.c, 'fallback-c-nolinks.png'], ['(d) empty', S.d, 'fallback-d-empty.png']]) {
      await withPage(srv.origin + '/', (pg) => flow(pg, tag, NONE, nm));
    }
    cn.count = 0;
    cn.listing = () => ({ delay: 1500, body: listingPage(['late.png']) });
    await withPage(cn.origin + '/', async (pg) => {
      await pg.click('#new');
      await pg.selectOption('#rows', '4');
      await pg.selectOption('#cols', '4');
      await pg.click('#new-start');
      await pg.waitForFunction(() => !document.getElementById('new-dialog').open);
      eq(await board(pg), solvedBoard(16), '(e) 4x4 board');
      await sleep(2000);
      ok(!(await isOpen(pg, 'new-dialog')), '(e) dialog reopened by the late listing');
      eq(await board(pg), solvedBoard(16), '(e) board changed');
      await shot(pg, dir, 'fallback-e-delayed.png');
      say('(e) delayed listing: Numbers 4x4 started at once; the late listing changed nothing');
    });
  });

  // preset-errors: R3. An undecodable or missing preset fails like an own file, and the decode races are safe.
  await run('preset-errors', async ({ page, say }) => {
    need();
    const gone = path.join(tmpRoot, 'A', 'images', 'gone.png');
    expectConsole(S.a.origin + '/images/gone.png');
    try {
      await page.click('#new');
      await presetRowVisible(page);
      await page.selectOption('#preset', { label: 'broken' });
      await page.click('#new-start');
      await page.waitForFunction(() => { const e = document.getElementById('new-error'); return !e.hidden && e.textContent.includes('not an image'); });
      eq((await page.textContent('#new-error')).trim(), 'That file is not an image.', '(a) text');
      ok(await isOpen(page, 'new-dialog'), '(a) dialog closed');
      ok(await page.isEnabled('#new-start'), '(a) Start disabled');
      eq(await board(page), SOLVED, '(a) board');
      await page.selectOption('#preset', { label: 'portrait' });
      await page.click('#new-start');
      await page.waitForSelector('#crop-dialog[open]');
      ok(await page.$eval('#new-error', (e) => e.hidden), '(a) error still shown after a good preset');
      await page.click('#crop-cancel');
      say('(a) broken: "That file is not an image.", dialog open, Start enabled; portrait afterwards opens the crop and clears the error');
      fs.writeFileSync(gone, FIX['landscape.png'].buffer);
      await page.click('#new');
      await presetRowVisible(page);
      fs.rmSync(gone);
      await page.selectOption('#preset', { label: 'gone' });
      await page.click('#new-start');
      await page.waitForFunction(() => { const e = document.getElementById('new-error'); return !e.hidden && e.textContent.includes('not an image'); });
      eq((await page.textContent('#new-error')).trim(), 'That file is not an image.', '(b) text');
      ok(await page.isEnabled('#new-start'), '(b) Start disabled');
      await page.click('#new-cancel');
      say('(b) deleted between listing and Start: the same error');
    } finally {
      fs.rmSync(gone, { force: true });
    }
    const gated = async (fn) => {
      const g = await newPage({}, S.a.origin + '/');
      try {
        await g.page.evaluate(() => {
          window.__gate = [];
          const real = window.createImageBitmap.bind(window);
          window.createImageBitmap = (...a) => new Promise((resolve) => window.__gate.push(resolve)).then(() => real(...a));
        });
        await fn(g.page);
      } finally {
        await g.ctx.close();
      }
    };
    const gateLen = (pg) => pg.evaluate(() => window.__gate.length);
    const release = (pg) => pg.evaluate(() => { const r = window.__gate.shift(); if (r) r(); });
    const waitGate = (pg, n) => pg.waitForFunction((k) => window.__gate.length === k, n);
    const startPreset = async (pg, label) => {
      await pg.click('#new');
      await presetRowVisible(pg);
      await pg.selectOption('#preset', { label });
      await pg.click('#new-start');
    };
    await gated(async (pg) => {
      await click(pg, 7);
      const b0 = await board(pg);
      await startPreset(pg, 'portrait');
      await waitGate(pg, 1);
      ok(await pg.isDisabled('#new-start'), '(c) Start not disabled during the decode');
      await pg.keyboard.press('Escape');
      await release(pg);
      await sleep(300);
      ok(!(await isOpen(pg, 'crop-dialog')), '(c) crop dialog opened after Escape');
      ok(!(await isOpen(pg, 'new-dialog')), '(c) New dialog reopened');
      eq(await board(pg), b0, '(c) board');
      eq(await movesOf(pg), 1, '(c) moves');
      say('(c) Escape during a pending preset decode: Start disabled while pending, then no dialog and the game unchanged');
    });
    await gated(async (pg) => {
      await startPreset(pg, 'portrait');
      await waitGate(pg, 1);
      await pg.keyboard.press('Escape');
      await startPreset(pg, 'portrait');
      await waitGate(pg, 2);
      await release(pg);
      await sleep(300);
      ok(!(await isOpen(pg, 'crop-dialog')), '(d) crop dialog opened from the stale decode');
      ok(await pg.$eval('#new-error', (e) => e.hidden), '(d) error shown by the stale decode');
      eq(await gateLen(pg), 1, '(d) second decode not pending');
      await release(pg);
      await pg.waitForSelector('#crop-dialog[open]');
      say('(d) stale token: the first decode changed nothing; the second opened the crop dialog');
    });
  }, { url: U(S.a) });

  // preset-cache: AC2, I11. The listing is never served from the HTTP cache.
  await run('preset-cache', async ({ say }) => {
    need();
    cn.count = 0;
    cn.listing = (n) => ({ headers: { 'Cache-Control': 'max-age=3600' }, body: listingPage([n === 1 ? 'first.png' : 'second.png']) });
    await withPage(cn.origin + '/', async (pg) => {
      await pg.click('#new');
      await presetRowVisible(pg);
      eq(await presetNames(pg), ['first'], 'first open');
      await pg.click('#new-cancel');
      await pg.click('#new');
      await pg.waitForFunction(() => [...document.querySelectorAll('#preset option')].some((o) => o.textContent === 'second'));
      eq(await presetNames(pg), ['second'], 'second open');
      eq(cn.count, 2, 'listing requests that reached the server');
      say('max-age=3600 listing: the second open shows the second body, two requests reached the server');
    });
  });

  // preset-race: AC5. A late listing never acts on a closed or newer dialog.
  await run('preset-race', async ({ say }) => {
    need();
    cn.count = 0;
    cn.listing = (n) => (n === 1 ? { delay: 1000, body: listingPage(['old.png']) } : { body: listingPage(['new.png']) });
    await withPage(cn.origin + '/', async (pg) => {
      await pg.click('#new');
      await pg.click('#new-cancel');
      await pg.click('#new');
      await presetRowVisible(pg);
      eq(await presetNames(pg), ['new'], 'reopened options');
      await sleep(1500);
      eq(await presetNames(pg), ['new'], 'options after the stale reply');
      say('stale reply after Cancel and reopen ignored: options stay [new]');
    });
    cn.count = 0;
    cn.listing = () => ({ delay: 800, body: listingPage(['late.png']) });
    await withPage(cn.origin + '/', async (pg) => {
      await pg.click('#new');
      await pg.keyboard.press('Escape');
      await sleep(1300);
      ok(!(await isOpen(pg, 'new-dialog')), 'New dialog opened by the late reply');
      ok(!(await isOpen(pg, 'crop-dialog')), 'crop dialog opened by the late reply');
      ok(await pg.$eval('#preset-row', (e) => e.hidden), 'Picture row shown by the late reply');
      say('late reply after Escape: both dialogs stay closed');
    });
  });

  // preset-hostile: AC6, R5. Only same-origin files directly inside images/ are offered, and nothing leaves the origin.
  await run('preset-hostile', async ({ page, say }) => {
    need();
    cn.count = 0;
    cn.requests.length = 0;
    const hrefs = [
      'http://example.invalid/evil.png', '//other.invalid/evil.jpg', `http://127.0.0.1:${S.a.port}/x.png`,
      'http://example.invalid/images/evil.png', '//other.invalid/images/evil.jpg', `http://127.0.0.1:${S.a.port}/images/x.png`,
      'sub%2Finner.png', '..%5Cup.png', '../up.png', '/elsewhere/x.png', 'sub/inner.png',
      'javascript:alert(1)//.png', 'data:image/png;base64,AAAA', '?C=N;O=D', './ok.png', 'ok%20two.webp', 'bad%E0%A4%A.png',
    ];
    cn.listing = () => ({ body: listingPage(hrefs) });
    await withPage(cn.origin + '/', async (pg) => {
      await pg.click('#new');
      await presetRowVisible(pg);
      eq(await presetNames(pg), ['ok', 'ok two'], 'offered options');
      await pg.selectOption('#preset', { label: 'ok' });
      await pg.click('#new-start');
      await pg.waitForSelector('#crop-dialog[open]');
      say('offered exactly ["ok","ok two"]; Start ok opened the crop dialog');
    });
    for (const p of cn.requests) ok(['/', '/index.html', '/settings.json', '/images/', '/images/ok.png'].includes(p), 'unexpected request path ' + p);
    say('canned origin requests: ' + JSON.stringify(cn.requests));
    cn.count = 0;
    cn.requests.length = 0;
    cn.listing = () => ({ status: 302, headers: { Location: 'http://example.invalid/images/' }, body: '' });
    expectConsole('http://example.invalid/images/', 'Failed to load resource: net::ERR_FAILED');
    const mark = requests.length;
    await withPage(cn.origin + '/', async (pg) => {
      pg.on('console', (m) => say(`redirect case console: ${m.type()} ${m.text()} @ ${m.location().url}`));
      await pg.click('#new');
      await pg.waitForFunction(() => !document.getElementById('preset-note').hidden);
      eq((await pg.textContent('#preset-note')).trim(), 'No preset pictures found.', 'redirect note');
      ok(await pg.$eval('#preset-row', (e) => e.hidden), 'redirect: Picture row shown');
      await sleep(300);
    });
    eq(requests.slice(mark).filter((u) => u.includes('example.invalid')), [], 'requests to example.invalid');
    say('302 to another origin: treated as unavailable, no request to example.invalid; canned requests ' + JSON.stringify(cn.requests));
  });

  // ---- #14 grid size settings. Servers are the s-* fixture roots, the repo root and the canned server (settings-late only). ----
  // A page with its own request list, also feeding the shared request and console capture.
  async function watched(pageUrl) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const seen = [];
    page.on('request', (r) => { requests.push(r.url()); seen.push(r.url()); });
    page.on('pageerror', (e) => errors.push({ text: 'pageerror: ' + e.message, url: '' }));
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ text: 'console: ' + m.text(), url: m.location().url }); });
    await page.goto(pageUrl);
    return { ctx, page, seen };
  }

  // settings-shipped: AC1. The shipped settings.json offers 3..10 for both, every size plays, a preset works at 10x10.
  await run('settings-shipped', async ({ page, dir, say }) => {
    need();
    const text = fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8').replace(/\r\n/g, '\n');
    eq(text, SHIPPED_TEXT, 'settings.json text');
    const hits = () => S.real.log.filter((e) => e.path === '/settings.json' && e.code === 200).length;
    const n0 = hits();
    await page.goto(S.real.origin + '/');
    await ready(page);
    for (let k = 0; k < 40 && hits() <= n0; k++) await sleep(100);
    ok(hits() > n0, 'no GET /settings.json 200 in the Python log for this load');
    eq(await optionsOf(page), { rows: seq(3, 10), cols: seq(3, 10) }, 'options');
    eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['3', '3'], 'selects');
    eq(await board(page), SOLVED, 'initial board');
    await page.click('#new');
    await shot(page, dir, 'new-dialog.png');
    await page.click('#new-cancel');
    for (let r = 3; r <= 10; r++) {
      for (let c = 3; c <= 10; c++) {
        const tag = `${r}x${c}`;
        await setSizeUI(page, r, c);
        await gridOf(page, r, c, tag);
        eq(await board(page), solvedBoard(r * c), tag + ' labels');
        eq(await movesOf(page), 0, tag + ' moves');
        eq(await timerOf(page), 0, tag + ' timer');
        ok(!(await page.isVisible('#message')), tag + ' message visible');
      }
    }
    say('all 64 sizes 3..10 x 3..10: tile count, columns, rows, labels, moves 0, timer 0, message hidden');
    await page.click('#new');
    await presetRowVisible(page);
    const first = (await presetOptions(page))[0];
    ok(first, 'no preset picture in images/');
    await page.selectOption('#rows', '10');
    await page.selectOption('#cols', '10');
    await page.selectOption('#preset', { label: first.text });
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(page);
    eq(await page.$$eval('#board .tile.image', (e) => e.length), 99, 'image tiles');
    eq(await page.$$eval('#board .tile.image', (els) => els.every((e) => e.querySelectorAll('canvas').length === 1 && e.textContent === '')), true, 'one canvas, no text per tile');
    eq(await imgBoard(page), solvedBoard(100), 'image labels');
    await shot(page, dir, 'preset-10x10.png');
    const nb = 98, e0 = 99;
    const sB = (await pieceSample(page)).find((p) => p.i === nb);
    await click(page, nb);
    const sA = (await pieceSample(page)).find((p) => p.i === e0);
    eq(sA.rgb, sB.rgb, 'the same canvas colour moved into the empty cell');
    eq(await movesOf(page), 1, 'moves after the slide');
    say(`preset "${first.text}" at 10x10: 99 canvases, no text; one slide moved the canvas from ${nb} to ${e0}, moves 1`);
  }, { url: U(S.real) });

  // settings-edit: AC2. The range follows the file, on the next load; larger sizes play and fit.
  await run('settings-edit', async ({ page, dir, say }) => {
    need();
    const file = path.join(tmpRoot, 's-edit', 'settings.json');
    const mark = errors.length;
    try {
      await ready(page);
      eq(await optionsOf(page), { rows: seq(4, 8), cols: seq(3, 12) }, '(a) options');
      eq(await board(page), solvedBoard(12), '(a) board');
      await gridOf(page, 4, 3, '(a) 4x3');
      eq(await movesOf(page), 0, '(a) moves');
      await page.click('#new');
      eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['4', '3'], '(a) selects');
      await page.waitForFunction((t) => { const n = document.getElementById('preset-note'); return !n.hidden && n.textContent === t; }, NO_PRESETS);
      eq(errors.slice(mark), [], '(a) console output');
      await page.click('#new-cancel');
      say('(a) rows 4..8, cols 3..12; board starts 4x3; New opens at 4/3 with no console output');
      fs.writeFileSync(file, '{"grid":{"rows":{"min":5,"max":5},"columns":{"min":7,"max":9}}}');
      await page.reload();
      await ready(page);
      eq(await optionsOf(page), { rows: [5], cols: seq(7, 9) }, '(b) options');
      eq(await board(page), solvedBoard(35), '(b) board');
      await gridOf(page, 5, 7, '(b) 5x7');
      say('(b) file rewritten, reload: rows [5], cols 7..9, board 5x7');
      fs.writeFileSync(file, S_EDIT);
      await page.reload();
      await ready(page);
      eq(await optionsOf(page), { rows: seq(4, 8), cols: seq(3, 12) }, '(c) options');
      await setSizeUI(page, 8, 12);
      await gridOf(page, 8, 12, '(c) 8x12');
      eq(await board(page), solvedBoard(96), '(c) labels');
      await click(page, 83);
      eq(await board(page), slideOracle(8, 12, [83]).tiles, '(c) after the legal click');
      eq(await movesOf(page), 1, '(c) moves after the legal click');
      await click(page, 84);
      const o = slideOracle(8, 12, [83, 84]);
      eq(await board(page), o.tiles, '(c) after the row-wrap click');
      eq(await movesOf(page), o.moves, '(c) moves after the row-wrap click');
      for (let n = 0; n < 3; n++) {
        await page.click('#shuffle');
        const b = (await board(page)).map((x) => (x === '_' ? 0 : Number(x)));
        ok(oracleSolvable(b, 8, 12), `(c) shuffle ${n}: unsolvable`);
        ok(b.join() !== solvedOf(96).join(), `(c) shuffle ${n}: solved`);
      }
      say('(c) 8x12: 96 tiles, 12 columns, 8 rows; legal and row-wrap clicks match slideOracle; 3 shuffles oracle-solvable and unsolved');
      const fx = FIX['landscape.png'];
      await newImageUI(page, 4, 12);
      await cropDoneUI(page);
      eq(await imgBoard(page), solvedBoard(48), '(d) labels');
      const pc = await expectPieces(page, fx, 4, 12, cropOracle(fx.W, fx.H, 4, 12, 1, fx.W / 2, fx.H / 2), '(d) 4x12');
      eq(pc.count, 47, '(d) piece count');
      say(`(d) 4x12 image: ${pc.count} pieces match the oracle (worst ${pc.worst.toFixed(2)}px)`);
      for (const [w, h] of [[360, 740], [1280, 800]]) {
        await page.setViewportSize({ width: w, height: h });
        await setSizeUI(page, 8, 12);
        expectFits(await fitMetrics(page), `(e) ${w}x${h} 8x12`, 20);
        await shot(page, dir, `8x12-${w}.png`);
      }
      ok(!(await optionsOf(page)).rows.includes(12), '(e) 12 rows offered with rows max 8');
      fs.writeFileSync(file, '{"grid":{"rows":{"min":3,"max":12},"columns":{"min":3,"max":12}}}');
      await page.reload();
      await ready(page);
      eq((await optionsOf(page)).rows, seq(3, 12), '(e) rows after the edit');
      for (const [w, h] of [[360, 740], [1280, 800]]) {
        await page.setViewportSize({ width: w, height: h });
        await setSizeUI(page, 12, 12);
        await gridOf(page, 12, 12, `(e) ${w}x${h} 12x12`);
        const m = await fitMetrics(page);
        expectFits(m, `(e) ${w}x${h} 12x12`, 20);
        say(`(e) ${w}x${h} 12x12: tile ${m.tiles[0].w.toFixed(1)}px, message bottom ${m.msgB.toFixed(0)} of ${m.ih}`);
        await shot(page, dir, `12x12-${w}.png`);
      }
    } finally {
      fs.writeFileSync(file, S_EDIT);
    }
  }, { url: U(S['s-edit']) });

  // settings-values: AC2. Bad values fall back per value; a served file with bad values and a nearest-size start.
  await run('settings-values', async ({ page, say }) => {
    need();
    const D = [3, 10, 3, 10];
    const table = [
      [null, D], [7, D], ['x', D], [[], D], [{}, D], [{ grid: null }, D], [{ grid: [] }, D], [{ grid: { rows: null, columns: '3-10' } }, D],
      [{ grid: { rows: { min: 4, max: 8 }, columns: { min: 3, max: 12 } } }, [4, 8, 3, 12]],
      [{ grid: { rows: { min: 4, max: 8 } }, theme: 'dark' }, [4, 8, 3, 10]],
      [{ grid: { rows: { min: '4', max: 8 } } }, [3, 8, 3, 10]],
      [{ grid: { rows: { min: 4.5, max: 8 } } }, [3, 8, 3, 10]],
      [{ grid: { rows: { min: true, max: 8 } } }, [3, 8, 3, 10]],
      [{ grid: { rows: { min: 2, max: 13 } } }, D],
      [{ grid: { rows: { min: -1, max: 0 } } }, D],
      [{ grid: { rows: { min: 3, max: 12 } } }, [3, 12, 3, 10]],
      [{ grid: { rows: { min: 9, max: 4 } } }, D],
      [{ grid: { rows: { min: 11 } } }, D],
      [{ grid: { columns: { max: 3 } } }, [3, 10, 3, 3]],
      [{ grid: { rows: { min: 10, max: 10 } } }, [10, 10, 3, 10]],
    ];
    for (const [input, w] of table) {
      const got = await page.evaluate((s) => gridRange(s), input);
      eq(got, { rows: { min: w[0], max: w[1] }, cols: { min: w[2], max: w[3] } }, 'gridRange(' + JSON.stringify(input) + ')');
    }
    say(`(i) ${table.length} gridRange inputs match the table`);
    const mark = errors.length;
    await withPage(S['s-values'].origin + '/', async (pg) => {
      await ready(pg);
      eq(await optionsOf(pg), { rows: seq(3, 8), cols: seq(3, 10) }, '(ii) options');
      eq(await board(pg), SOLVED, '(ii) board');
      ok(await pg.$eval('#new-error', (e) => e.hidden), '(ii) error visible');
      await pg.click('#new');
      await pg.waitForFunction((t) => { const n = document.getElementById('preset-note'); return !n.hidden && n.textContent === t; }, NO_PRESETS);
      ok(await pg.$eval('#new-error', (e) => e.hidden), '(ii) error visible after New');
    });
    eq(errors.slice(mark), [], '(ii) console output');
    say('(ii) served bad values: rows 3..8, cols 3..10, board 3x3, no error, no console output');
    await withPage(S['s-near'].origin + '/', async (pg) => {
      await ready(pg);
      eq(await optionsOf(pg), { rows: seq(5, 7), cols: [4] }, '(iii) options');
      eq(await board(pg), solvedBoard(20), '(iii) board');
      await gridOf(pg, 5, 4, '(iii) 5x4');
      await pg.click('#new');
      eq(await pg.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['5', '4'], '(iii) selects');
      await pg.click('#new-cancel');
    });
    say('(iii) rows 5..7, cols 4..4: board starts 5x4, selects 5/4');
  });

  // settings-fallback: AC5. An unreadable settings.json (file://, missing, malformed) leaves the defaults and shows nothing.
  await run('settings-fallback', async ({ page, say }) => {
    need();
    const DEFAULT = { rows: seq(3, 10), cols: seq(3, 10) };
    const bodyText = (pg) => pg.evaluate(() => document.body.innerText);
    await ready(page);
    eq(await optionsOf(page), DEFAULT, 'reference options');
    const ref = await bodyText(page);
    const mark = errors.length;
    const w = await watched(PAGE_URL);
    try {
      await ready(w.page);
      eq(await optionsOf(w.page), DEFAULT, '(a) options');
      eq(await board(w.page), SOLVED, '(a) board');
      eq(w.seen.filter((u) => u !== PAGE_URL && u !== 'data:,'), [], '(a) requests other than the page');
      eq(errors.slice(mark), [], '(a) console output');
      say('(a) file://: options 3..10, board 3x3, requests ' + JSON.stringify(w.seen) + ', no console output');
    } finally {
      await w.ctx.close();
    }
    const settingsUrl = S['s-missing'].origin + '/settings.json';
    expectConsole(settingsUrl);
    for (const [tag, key] of [['(b) missing', 's-missing'], ['(c) malformed', 's-bad']]) {
      const m0 = errors.length;
      await withPage(S[key].origin + '/', async (pg) => {
        await ready(pg);
        eq(await optionsOf(pg), DEFAULT, tag + ' options');
        eq(await board(pg), SOLVED, tag + ' board');
        ok(await pg.$eval('#new-error', (e) => e.hidden), tag + ' #new-error visible');
        ok(await pg.$eval('#message', (e) => e.hidden), tag + ' #message visible');
        eq(await bodyText(pg), ref, tag + ' innerText');
        await click(pg, 7);
        eq(await movesOf(pg), 1, tag + ' moves after one slide');
        await pg.click('#new');
        await pg.waitForFunction((t) => { const n = document.getElementById('preset-note'); return !n.hidden && n.textContent === t; }, NO_PRESETS);
        ok(await pg.$eval('#new-error', (e) => e.hidden), tag + ' #new-error visible after New');
        await pg.click('#new-cancel');
        await setSizeUI(pg, 4, 4);
        eq(await board(pg), solvedBoard(16), tag + ' 4x4 board');
      });
      const got = errors.slice(m0);
      if (key === 's-bad') eq(got, [], tag + ' console output');
      else ok(got.every((e) => e.url === settingsUrl && e.text.startsWith('console: Failed to load resource: the server responded with a status of 404')), `${tag}: console output other than the settings.json 404: ${JSON.stringify(got)}`);
      say(`${tag}: options 3..10, board 3x3, no message, same text as the reference, slide, New and 4x4 work; console entries ${got.length}`);
    }
  }, { url: U(S.real) });

  // settings-late: AC5, W1. Settings that arrive late update an open New dialog in place and keep the player's picks.
  if (cn) {
    cn.count = 0;
    cn.listing = () => ({ body: listingPage([]) });
    cn.settings = () => ({ delay: 1500, body: '{"grid":{"rows":{"min":4,"max":8}}}' });
  }
  await run('settings-late', async ({ page, dir, say }) => {
    need();
    const mark = errors.length;
    eq(await optionsOf(page), { rows: seq(3, 10), cols: seq(3, 10) }, 'options before arrival');
    eq(await board(page), SOLVED, 'board before arrival');
    await page.click('#new');
    ok(await isOpen(page, 'new-dialog'), 'New dialog not open');
    await page.selectOption('#cols', '7');
    eq(await optionsOf(page), { rows: seq(3, 10), cols: seq(3, 10) }, 'settings already applied before the pick');
    await ready(page);
    ok(await isOpen(page, 'new-dialog'), 'New dialog closed by the late settings');
    eq(await optionsOf(page), { rows: seq(4, 8), cols: seq(3, 10) }, 'options after arrival');
    eq(await page.evaluate(() => [document.getElementById('rows').value, document.getElementById('cols').value]), ['4', '7'], 'selects after arrival');
    eq(await board(page), solvedBoard(12), 'board after arrival');
    await shot(page, dir, 'dialog-after-arrival.png');
    await page.click('#new-start');
    await page.waitForFunction(() => !document.getElementById('new-dialog').open);
    eq(await board(page), solvedBoard(28), 'board after Start');
    await gridOf(page, 4, 7, 'after Start 4x7');
    eq(errors.slice(mark), [], 'console output');
    say('late settings rows 4..8: dialog stayed open, options rows 4..8 cols 3..10, selects 4/7 (rows clamped, cols pick kept), board 4x3; Start gave 4x7');
  }, { url: cn ? cn.origin + '/' : undefined });
  if (cn) cn.settings = null;

  // readme-settings: Docs. The README documents settings.json after the Run section.
  await run('readme-settings', async ({ say }) => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
    const iRun = readme.indexOf('## Run'), iSet = readme.indexOf('## Settings');
    ok(iRun !== -1 && iSet > iRun, 'README lacks ## Settings after ## Run');
    const rest = readme.slice(iSet + 3);
    const end = rest.search(/\n(## |<!--)/);
    const section = end === -1 ? rest : rest.slice(0, end);
    const m = section.match(/```json\n([\s\S]*?)```/);
    ok(m, 'no ```json block in the Settings section');
    eq(JSON.parse(m[1]), JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8')), 'README json block against settings.json');
    for (const w of ['settings.json', 'rows', 'columns', 'min', 'max', '12', 'http', 'file://']) ok(section.includes(w), `Settings section lacks "${w}"`);
    say('README Settings section: after Run, json block equals settings.json, keywords present');
  }, { shoot: false });

  // ---- #15 flip the board. Each check starts with reduced motion (instant flips) unless it is about motion. ----
  const reduce = (page) => page.emulateMedia({ reducedMotion: 'reduce' });
  const centreOf = async (page, sel) => { const q = await rect(page, sel); return { x: q.l + q.w / 2, y: q.t + q.h / 2 }; };
  const snap = async (page) => ({ board: await board(page), html: await page.$eval('#board', (e) => e.outerHTML), moves: await movesOf(page), msgHidden: await page.$eval('#message', (e) => e.hidden) });
  const pressedOf = (page) => page.getAttribute('#flip', 'aria-pressed');
  const BACK_SHOTS = new Set(['3x3', '10x10', '3x10', '10x3', '12x12', '3x12']);
  // Own-file flow with an arbitrary file name: New, size, file, Start, Done.
  const ownFileUI = async (pg, r, c, fileName) => {
    await pg.click('#new');
    await pg.selectOption('#rows', String(r));
    await pg.selectOption('#cols', String(c));
    await pg.setInputFiles('#image-file', { name: fileName, mimeType: 'image/png', buffer: FIX['landscape.png'].buffer });
    await pg.click('#new-start');
    await pg.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(pg);
  };

  // flip-control: AC1, owner 3. The Flip button sits with New and Shuffle, visibly apart from them.
  await run('flip-control', async ({ page, dir, say }) => {
    await reduce(page);
    const f = await page.$eval('#flip', (e) => {
      const p = e.previousElementSibling;
      return { tag: e.tagName, type: e.getAttribute('type'), text: e.textContent, pressed: e.getAttribute('aria-pressed'), inActions: !!e.closest('.actions'), prevIsSep: !!(p && p.classList.contains('sep')), sepAfterShuffle: !!(p && p.previousElementSibling && p.previousElementSibling.id === 'shuffle') };
    });
    eq(f, { tag: 'BUTTON', type: 'button', text: 'Flip', pressed: 'false', inActions: true, prevIsSep: true, sepAfterShuffle: true }, 'flip button');
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [r, c] of [[3, 3], [10, 10], [3, 10]]) {
        await setSizeUI(page, r, c);
        const tag = `${w}x${h} ${r}x${c}`;
        const nw = await rect(page, '#new'), sh = await rect(page, '#shuffle'), sp = await rect(page, '.actions .sep'), fl = await rect(page, '#flip'), ac = await rect(page, '.actions'), fr = await rect(page, '.frame');
        const cw = await page.evaluate(() => document.documentElement.clientWidth);
        say(`${tag}: New-Shuffle gap ${(sh.l - nw.r).toFixed(1)}, Shuffle-Flip gap ${(fl.l - sh.r).toFixed(1)}, actions ${ac.l.toFixed(1)}..${ac.r.toFixed(1)} of ${cw}`);
        ok(fl.l - sh.r >= 2 * (sh.l - nw.r), `${tag}: Flip gap ${fl.l - sh.r} is under twice the New-Shuffle gap ${sh.l - nw.r}`);
        ok(sp.l >= sh.r - 0.5 && sp.r <= fl.l + 0.5, tag + ': separator not between Shuffle and Flip');
        const fC = await colours(page, '#flip');
        nonVacuous(fC, tag + ' #flip', say);
        ok(fC.every((x) => maxc(x) <= 64), tag + ': #flip not dark plastic');
        ok(rgbOf(await style(page, '#flip', 'color')).every((v) => v >= 230), tag + ': #flip text not white');
        ok(ac.l >= 0 && ac.r <= cw, tag + ': .actions outside [0, clientWidth]');
        ok(fl.l >= 0 && fl.r <= cw, tag + ': #flip outside [0, clientWidth]');
        ok(!overlap(fl, fr), tag + ': #flip intersects the frame');
      }
      await page.locator('.actions').screenshot({ path: path.join(dir, `actions-${w}.png`) });
    }
  });

  // flip-front-unchanged: AC1, owner 1, 2, 4. Flipping changes nothing about the game, and the timer keeps running. Normal motion.
  await run('flip-front-unchanged', async ({ page, say }) => {
    // (a) numbers 3x3, timer running.
    await click(page, 7);
    eq(await movesOf(page), 1, '(a) moves after one slide');
    const before = await snap(page);
    await flipUI(page);
    eq(await pressedOf(page), 'true', '(a) aria-pressed on the back');
    const t0 = await timerOf(page);
    await page.waitForFunction((t) => Number(document.getElementById('timer').textContent.match(/(\d+)s/)[1]) >= t, t0 + 2);
    const tBack = await timerOf(page);
    ok(tBack >= t0 + 2, `(a) timer did not keep running on the back (${t0} -> ${tBack})`);
    eq(await movesOf(page), 1, '(a) moves on the back');
    const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    for (const w of ['peek', 'penalty', 'cheat']) ok(!text.includes(w), `(a) page text mentions "${w}"`);
    await flipUI(page);
    eq(await snap(page), before, '(a) board, markup, moves and message after flipping back');
    eq(await pressedOf(page), 'false', '(a) aria-pressed on the front');
    ok((await timerOf(page)) >= tBack, '(a) timer went backwards');
    say(`(a) numbers: one move, flipped for the timer to go ${t0} -> ${tBack}; board, markup, moves unchanged after flipping back; no peek/penalty/cheat text`);
    // (b) a won board does not flip by itself, and the back and timer behave.
    await setSizeUI(page, 3, 3);
    await click(page, 7);
    await click(page, 8);
    ok(await page.isVisible('#message'), '(b) message not visible after the solve');
    const T = await timerOf(page);
    ok(!(await page.$eval('#plate', (e) => e.classList.contains('flipped'))), '(b) the board flipped by itself on the solve');
    eq(await pressedOf(page), 'false', '(b) aria-pressed after the solve');
    await flipUI(page);
    ok(await page.isVisible('#message'), '(b) message hidden on the back');
    const g = await backGeom(page);
    eq(g.cells, solvedBoard(9), '(b) the back grid');
    await sleep(1200);
    eq(await timerOf(page), T, '(b) frozen timer moved on the back');
    await flipUI(page);
    eq(await board(page), SOLVED, '(b) board after flipping back');
    ok(await page.isVisible('#message'), '(b) message after flipping back');
    eq(await movesOf(page), 2, '(b) moves');
    say(`(b) won board: no automatic flip, message stays, back grid solved, timer stayed ${T}, moves 2`);
    // (c) image 3x3.
    await newImageUI(page, 3, 3, 'landscape.png');
    await cropDoneUI(page);
    await page.click('#shuffle');
    const lab = await imgBoard(page), smp = await pieceSample(page);
    await flipUI(page);
    await flipUI(page);
    eq(await imgBoard(page), lab, '(c) image labels');
    eq(await pieceSample(page), smp, '(c) piece samples');
    eq(await movesOf(page), 0, '(c) moves');
    say('(c) image 3x3: labels and piece pixels unchanged after two flips, moves 0');
  }, { video: true });

  // flip-no-moves: AC4. While the back shows, the board cannot be played and New and Shuffle are off.
  await run('flip-no-moves', async ({ page, say }) => {
    await reduce(page);
    // (a) numbers 3x3 from solved: the tiles next to the gap are 5 and 7.
    const c5 = await centreOf(page, '#board .tile[data-index="5"]'), c7 = await centreOf(page, '#board .tile[data-index="7"]');
    await flipUI(page);
    ok(await page.$eval('#frame', (e) => e.inert), '(a) #frame not inert on the back');
    for (const c of [c5, c7]) {
      ok(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('#back'), [c.x, c.y]), '(a) the back is not what lies over the front tile');
      await page.mouse.click(c.x, c.y);
    }
    eq(await movesOf(page), 0, '(a) moves after clicking where tiles 5 and 7 were');
    eq(await board(page), SOLVED, '(a) board after those clicks');
    ok(await page.$eval('#new', (e) => e.disabled) && await page.$eval('#shuffle', (e) => e.disabled), '(a) New and Shuffle not disabled on the back');
    const forbidden = [];
    let reachedFlip = false;
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    for (let k = 0; k < 15; k++) {
      await page.keyboard.press('Tab');
      const a = await page.evaluate(() => ({ id: document.activeElement.id, tile: document.activeElement.classList.contains('tile') }));
      if (a.tile || a.id === 'new' || a.id === 'shuffle') forbidden.push(a);
      if (a.id === 'flip') reachedFlip = true;
    }
    eq(forbidden, [], '(a) Tab reached a tile, New or Shuffle');
    ok(reachedFlip, '(a) Tab never reached Flip');
    await page.focus('#flip');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('flip').getAttribute('aria-pressed') === 'false' && !document.getElementById('plate').classList.contains('flipped') && document.getElementById('plate').getAnimations().length === 0);
    ok(!(await page.$eval('#frame', (e) => e.inert)), '(a) #frame still inert after flipping back');
    ok(!(await page.$eval('#new', (e) => e.disabled)) && !(await page.$eval('#shuffle', (e) => e.disabled)), '(a) New or Shuffle still disabled on the front');
    await click(page, 7);
    eq(await movesOf(page), 1, '(a) the front is live again');
    say('(a) numbers: frame inert, clicks over the front tiles ignored, New/Shuffle disabled, 15 Tabs never left Flip, Enter flipped back, a click then moved');
    // (b) a click at once after Flip, while the plate is still turning.
    await withPage(PAGE_URL, async (pg) => {
      const c = await centreOf(pg, '#board .tile[data-index="7"]');
      await pg.click('#flip');
      await pg.mouse.click(c.x, c.y);
      eq(await movesOf(pg), 0, '(b) moves after a click during the turn');
      await pg.waitForFunction(() => document.getElementById('plate').getAnimations().length === 0);
      eq(await board(pg), SOLVED, '(b) board after the turn');
    });
    say('(b) normal motion: a click on tile 7 during the turn did nothing');
    // (c) image 3x3.
    await newImageUI(page, 3, 3, 'landscape.png');
    await cropDoneUI(page);
    const lab = await imgBoard(page);
    const i5 = await centreOf(page, '#board .tile[data-index="5"]'), i7 = await centreOf(page, '#board .tile[data-index="7"]');
    await flipUI(page);
    for (const c of [i5, i7]) {
      ok(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y).closest('#back'), [c.x, c.y]), '(c) the back is not what lies over the front tile');
      await page.mouse.click(c.x, c.y);
    }
    eq(await movesOf(page), 0, '(c) moves');
    eq(await imgBoard(page), lab, '(c) image labels');
    say('(c) image: clicks over the front tiles ignored, labels unchanged');
  });

  // back-numbers: AC2, AC6. The back of a number puzzle is the solved grid at every size, phone and desktop.
  await run('back-numbers', async ({ page, dir, say }) => {
    await reduce(page);
    const sweep = async (pg, w, h, sizes, tagp) => {
      await pg.setViewportSize({ width: w, height: h });
      for (const [r, c] of sizes) {
        await setSizeUI(pg, r, c);
        await flipUI(pg);
        const g = await backGeom(pg);
        const tag = `${tagp}${w}x${h} ${r}x${c}`;
        ok(g.showsGrid && !g.showsPicture, tag + ': grid not shown or picture shown');
        eq(g.cells, solvedBoard(r * c), tag + ' cells');
        eq(g.empties, 1, tag + ' empty cells');
        ok(g.emptyLast, tag + ': the empty cell is not last');
        eq(g.capText, `Shuffle ${r}${TIMES}${c}`, tag + ' caption');
        expectBackLayout(g, r, c, tag);
        if (BACK_SHOTS.has(`${r}x${c}`)) await shot(pg, dir, `${r}x${c}-${w}.png`);
        await flipUI(pg);
      }
      say(`${tagp}${w}x${h}: ${sizes.length} sizes, grid, caption and layout hold`);
    };
    await sweep(page, 360, 740, pairs(3, 10), 'file ');
    await sweep(page, 1280, 800, pairs(3, 10), 'file ');
    need();
    await withPage(S['s-flip'].origin + '/', async (pg) => {
      await reduce(pg);
      await ready(pg);
      eq(await optionsOf(pg), { rows: seq(3, 12), cols: seq(3, 12) }, 's-flip options');
      await sweep(pg, 360, 740, pairs(3, 12), 'http ');
      await sweep(pg, 1280, 800, [[12, 12], [3, 12], [12, 3], [4, 12]], 'http ');
    });
  });

  // back-image: AC2, owner 5. The back of an image puzzle is the whole cropped picture in greyscale, with no seams and no missing piece.
  await run('back-image', async ({ page, dir, say }) => {
    await reduce(page);
    const imageCase = async (pg, fixName, r, c, zoom) => {
      const fx = FIX[fixName];
      const tag = `${fixName.replace('.png', '')} ${r}x${c}${zoom !== 1 ? ' zoom ' + zoom : ''}`;
      await newImageUI(pg, r, c, fixName);
      if (zoom !== 1) await setZoom(pg, zoom);
      await cropDoneUI(pg);
      await flipUI(pg);
      const o = cropOracle(fx.W, fx.H, r, c, zoom, fx.W / 2, fx.H / 2);
      await expectBackImage(pg, fx, o, r, c, tag, say);
      await shot(pg, dir, `${fixName.replace('.png', '')}-${r}x${c}${zoom !== 1 ? 'z' + zoom : ''}-1280.png`);
      await flipUI(pg);
    };
    for (const [r, c] of [[3, 3], [4, 6], [6, 3], [10, 10], [3, 10], [10, 3]]) await imageCase(page, 'landscape.png', r, c, 1);
    for (const [r, c] of [[3, 3], [10, 3]]) await imageCase(page, 'portrait.png', r, c, 1);
    await imageCase(page, 'landscape.png', 4, 4, 2);
    need();
    await withPage(S['s-flip'].origin + '/', async (pg) => {
      await reduce(pg);
      await ready(pg);
      for (const [r, c] of [[12, 12], [3, 12], [12, 3]]) await imageCase(pg, 'landscape.png', r, c, 1);
    });
    await withPage(PAGE_URL, async (pg) => {
      await reduce(pg);
      const fx = FIX['landscape.png'];
      await newImageUI(pg, 3, 3, 'landscape.png');
      await cropDoneUI(pg);
      await flipUI(pg);
      await expectBackImage(pg, fx, cropOracle(fx.W, fx.H, 3, 3, 1, fx.W / 2, fx.H / 2), 3, 3, 'dpr2 landscape 3x3', say, 2);
    }, { deviceScaleFactor: 2 });
  });

  // back-caption: AC2. The caption is the preset name, the own file's name without extension, or Shuffle R x C.
  await run('back-caption', async ({ page, dir, say }) => {
    need();
    await reduce(page);
    const land = FIX['landscape.png'];
    const NAME_L = 'Grad – Landscape ’1’';
    // (a) preset from root A.
    await newPresetUI(page, 3, 3, NAME_L);
    await cropDoneUI(page);
    await flipUI(page);
    eq((await backGeom(page)).capText, NAME_L, '(a) caption');
    await expectBackImage(page, land, cropOracle(land.W, land.H, 3, 3, 1, 300, 200), 3, 3, '(a) preset', say);
    await flipUI(page);
    // (b) a real preset, taken from the dialog.
    await page.goto(S.real.origin + '/');
    await ready(page);
    await page.click('#new');
    await presetRowVisible(page);
    const first = (await presetOptions(page))[0];
    ok(first, '(b) no preset in the dialog');
    await page.selectOption('#rows', '4');
    await page.selectOption('#cols', '4');
    await page.selectOption('#preset', { label: first.text });
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(page);
    await flipUI(page);
    eq((await backGeom(page)).capText, first.text, '(b) caption');
    ok(realFiles.map(stemOf).includes(first.text), `(b) "${first.text}" is not the stem of a file in images/`);
    await shot(page, dir, 'real-preset.png');
    say(`(b) real preset "${first.text}" at 4x4: caption is its listed name, a stem of images/`);
    // (c) own file, then (d) a re-crop of the current image.
    await page.goto(PAGE_URL);
    await newImageUI(page, 3, 3, 'landscape.png');
    await cropDoneUI(page);
    await flipUI(page);
    eq((await backGeom(page)).capText, 'landscape', '(c) own file caption');
    await flipUI(page);
    await page.click('#new');
    await page.selectOption('#rows', '3');
    await page.selectOption('#cols', '4');
    await page.click('#new-start');
    await page.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(page);
    await flipUI(page);
    eq((await backGeom(page)).capText, 'landscape', '(d) caption after a re-crop');
    await expectBackImage(page, land, cropOracle(land.W, land.H, 3, 4, 1, 300, 200), 3, 4, '(d) re-crop 3x4', say);
    await flipUI(page);
    await ownFileUI(page, 3, 3, '.png');
    await flipUI(page);
    eq((await backGeom(page)).capText, 'Your picture', '(c) empty-stem caption');
    await flipUI(page);
    say('(c) own file landscape.png -> "landscape"; ".png" -> "Your picture"; (d) re-crop 3x4 keeps "landscape" and shows the 3x4 crop');
    // (e) numbers after an image.
    await setSizeUI(page, 5, 6);
    await flipUI(page);
    const ge = await backGeom(page);
    eq(ge.capText, `Shuffle 5${TIMES}6`, '(e) caption');
    ok(ge.showsGrid && !ge.showsPicture, '(e) grid not shown');
    await flipUI(page);
    say('(e) image then numbers 5x6: caption "Shuffle 5×6", grid shown');
    // (f) long names at 360x740 over s-flip.
    await withPage(S['s-flip'].origin + '/', async (pg) => {
      await pg.setViewportSize({ width: 360, height: 740 });
      await reduce(pg);
      await ready(pg);
      const back = async (name, tag) => { await ownFileUI(pg, 3, 12, name); await flipUI(pg); const g = await backGeom(pg); expectBackLayout(g, 3, 12, tag); await flipUI(pg); return g; };
      const gj = await back('Jacques-Louis David - Napoleon Crossing the Alps.png', '(f) Jacques-Louis');
      eq(gj.capText, 'Jacques-Louis David - Napoleon Crossing the Alps', '(f) long caption');
      const gs = await back('landscape.png', '(f) short');
      const long = 'A'.repeat(236);
      const gl = await back(long + '.png', '(f) 240 characters');
      eq(gl.capText, long, '(f) 240-character caption text');
      ok(gl.caption.h <= 2 * gs.caption.h + 1, `(f) long caption ${gl.caption.h}px tall, more than two lines of ${gs.caption.h}px`);
      ok(gl.panel.w >= 0.8 * gs.panel.w, `(f) panel shrank from ${gs.panel.w} to ${gl.panel.w}`);
      await flipUI(pg);
      await shot(pg, dir, 'long-name-360.png');
      say(`(f) 3x12 at 360: Jacques-Louis caption ${gj.caption.h}px tall inside the back; 240 characters ${gl.caption.h}px (one line ${gs.caption.h}px), panel ${gl.panel.w} against ${gs.panel.w}`);
    });
    // (g) race: the Picture select changes while the preset is still loading.
    await page.goto(S.a.origin + '/');
    await reduce(page);
    let held = false, release;
    const gate = new Promise((res) => { release = res; });
    await page.route(/Grad/, async (route) => { held = true; await gate; await route.continue(); });
    await page.click('#new');
    await presetRowVisible(page);
    await page.selectOption('#rows', '3');
    await page.selectOption('#cols', '3');
    await page.selectOption('#preset', { label: NAME_L });
    await page.click('#new-start');
    for (let k = 0; k < 100 && !held; k++) await sleep(50);
    ok(held, '(g) the preset request was never held');
    await page.selectOption('#preset', { label: 'portrait' });
    ok(!(await isOpen(page, 'crop-dialog')), '(g) the crop dialog opened before the release');
    release();
    await page.waitForSelector('#crop-dialog[open]');
    await cropDoneUI(page);
    await page.unroute(/Grad/);
    await flipUI(page);
    eq((await backGeom(page)).capText, NAME_L, '(g) caption after the select changed');
    say('(g) the Picture select changed while the preset loaded: caption is still the preset that was started');
  }, { url: U(S.a) });

  // flip-motion: AC5. A 0.6s rotation, instant under reduced motion.
  await run('flip-motion', async ({ page, dir, say }) => {
    const m11 = () => page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById('plate')).transform).m11);
    // The click and the first reading are in one page task, so a slow machine cannot let the transition finish first.
    const info = await page.evaluate(() => {
      const plate = document.getElementById('plate');
      document.getElementById('flip').click();
      const a = plate.getAnimations();
      const out = { n: a.length, kinds: a.map((x) => x.constructor.name), props: a.map((x) => x.transitionProperty), dur: a.map((x) => x.effect.getComputedTiming().duration), state: a.map((x) => x.playState) };
      a.forEach((x) => { x.pause(); x.currentTime = 200; });
      return out;
    });
    eq(info, { n: 1, kinds: ['CSSTransition'], props: ['transform'], dur: [600], state: ['running'] }, 'the flip animation');
    const mid = await m11();
    ok(mid > -0.95 && mid < 0.95 && Math.abs(mid) > 0.05, `m11 ${mid} at 200ms is not partway through the rotation`);
    await shot(page, dir, 'mid-flip.png');
    await page.evaluate(() => document.getElementById('plate').getAnimations().forEach((x) => x.play()));
    await page.waitForFunction(() => document.getElementById('plate').getAnimations().length === 0);
    const end = await m11();
    ok(Math.abs(end + 1) < 1e-3, `m11 ${end} after the flip, expected -1`);
    const g = await backGeom(page);
    const s = await backShot(page, g);
    ok(s.bright.right > 50, `right band has ${s.bright.right} bright pixels, the maker's text is not showing`);
    eq(s.nonGrey, 0, 'non-grey pixels in the panel of the rotated plate');
    await flipUI(page);
    const back1 = await m11();
    ok(Math.abs(back1 - 1) < 1e-3, `m11 ${back1} after flipping back, expected 1`);
    say(`one CSSTransition on transform, 600ms; m11 ${mid.toFixed(3)} at 300ms, ${end.toFixed(4)} at the end, ${back1.toFixed(4)} flipped back; right band ${s.bright.right} bright, 0 non-grey in the panel`);
    await withPage(PAGE_URL, async (pg) => {
      await pg.click('#flip');
      const a = await pg.evaluate(() => ({ n: document.getElementById('plate').getAnimations().length, m: new DOMMatrix(getComputedStyle(document.getElementById('plate')).transform).m11 }));
      eq(a.n, 0, 'reduced motion: animations after the flip');
      ok(Math.abs(a.m + 1) < 1e-3, `reduced motion: m11 ${a.m} after the flip, expected -1`);
      await pg.click('#flip');
      const b = await pg.evaluate(() => ({ n: document.getElementById('plate').getAnimations().length, m: new DOMMatrix(getComputedStyle(document.getElementById('plate')).transform).m11 }));
      eq(b.n, 0, 'reduced motion: animations after flipping back');
      ok(Math.abs(b.m - 1) < 1e-3, `reduced motion: m11 ${b.m} after flipping back, expected 1`);
    }, { reducedMotion: 'reduce' });
    say('reduced motion: no animation, m11 -1 then 1 at once');
  }, { video: true });

  // back-look: AC3. The back is a black plate printed in white, with maker's text up the right edge, and the picture area is pure grey.
  await run('back-look', async ({ page, dir, say }) => {
    await reduce(page);
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      const kinds = [...[[3, 3], [6, 6], [10, 10], [3, 10], [10, 3]].map(([r, c]) => ({ kind: 'numbers', r, c })), { kind: 'image', r: 3, c: 3 }];
      for (const k of kinds) {
        if (k.kind === 'numbers') await setSizeUI(page, k.r, k.c); else { await newImageUI(page, k.r, k.c, 'landscape.png'); await cropDoneUI(page); }
        await flipUI(page);
        const tag = `${k.kind} ${k.r}x${k.c} at ${w}x${h}`;
        const bC = await colours(page, '#back');
        nonVacuous(bC, tag + ' #back', say);
        ok(bC.every((x) => maxc(x) <= 48), tag + ': back not black');
        const rad = await style(page, '#back', 'borderTopLeftRadius');
        eq(rad, await style(page, '.frame', 'borderTopLeftRadius'), tag + ' back radius against frame');
        ok(parseFloat(rad) >= 8, tag + ': back radius < 8px');
        ok((await style(page, '#back', 'boxShadow')).includes('inset'), tag + ': back has no inset highlight');
        ok(rgbOf(await style(page, '#back-caption', 'color')).every((v) => v >= 230), tag + ': caption colour below 230');
        ok(parseFloat(await style(page, '#back-caption', 'fontSize')) < parseFloat(await style(page, 'h1', 'fontSize')), tag + ': caption font not smaller than h1');
        eq((await page.textContent('.back-maker')).trim(), 'Made by SHUFFLE', tag + ' maker text');
        ok(parseFloat(await style(page, '.back-maker', 'fontSize')) <= 10, tag + ': maker font over 10px');
        ok(rgbOf(await style(page, '.back-maker', 'color')).every((v) => v >= 230), tag + ': maker colour below 230');
        eq(await style(page, '.back-maker', 'writingMode'), 'vertical-rl', tag + ' maker writing-mode');
        const g = await backGeom(page);
        ok(g.maker.l >= g.back.r - 32 - 0.5 && g.maker.r <= g.back.r + 0.5, `${tag}: maker box ${JSON.stringify(g.maker)} not in the right 32px of the back`);
        ok(g.mark.l >= g.back.l + g.back.w / 2 && g.mark.r <= g.back.r + 0.5 && g.mark.t >= g.back.t - 0.5 && g.mark.b <= g.back.t + g.back.h / 2, `${tag}: mark ${JSON.stringify(g.mark)} not in the top-right quarter`);
        const greys = await page.evaluate(() => {
          const out = {};
          for (const [key, sel] of [['grid', '#back-grid'], ['cell', '.back-cell'], ['empty', '.back-cell.empty']]) {
            const e = document.querySelector(sel);
            if (!e) { out[key] = null; continue; }
            const cs = getComputedStyle(e);
            out[key] = [cs.backgroundColor, cs.color];
          }
          return out;
        });
        ok(greys.grid, tag + ': #back-grid missing');
        if (k.kind === 'numbers') ok(greys.cell && greys.empty, tag + ': back cells missing');
        for (const [key, pair] of Object.entries(greys)) {
          if (!pair) continue;
          for (const cstr of key === 'grid' ? [pair[0]] : pair) { const [R, G, B] = rgbOf(cstr); ok(R === G && G === B, `${tag}: ${key} colour ${cstr} is not pure grey`); }
        }
        const s = await backShot(page, g);
        ok(s.bright.right > 50, `${tag}: right band has ${s.bright.right} bright pixels, the maker's text is not showing`);
        ok(s.bright.left < 20, `${tag}: left band has ${s.bright.left} bright pixels, the back looks mirrored`);
        eq(s.nonGrey, 0, tag + ' non-grey pixels in the panel');
        say(`${tag}: black plate, maker right band ${s.bright.right} bright, left band ${s.bright.left}, panel 0 non-grey`);
        await shot(page, dir, `${k.kind}-${k.r}x${k.c}-${w}.png`);
        await flipUI(page);
      }
    }
  });

  // flip-resize: AC6. The back follows the viewport while it shows.
  await run('flip-resize', async ({ page, say }) => {
    await reduce(page);
    await setSizeUI(page, 10, 10);
    await flipUI(page);
    const g0 = await backGeom(page);
    expectBackLayout(g0, 10, 10, '1280x800');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForFunction((w) => document.getElementById('back-grid').getBoundingClientRect().width !== w, g0.panel.w);
    const g1 = await backGeom(page);
    expectBackLayout(g1, 10, 10, '360x740');
    ok(g1.panel.w !== g0.panel.w, 'panel width did not change at 360x740');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction((w) => document.getElementById('back-grid').getBoundingClientRect().width !== w, g1.panel.w);
    expectBackLayout(await backGeom(page), 10, 10, 'back at 1280x800');
    say(`10x10 panel ${g0.panel.w}px at 1280, ${g1.panel.w}px at 360, layout holds at each`);
  });

  // flip-late-settings: AC1, I7. Settings that arrive late move the board; the back follows.
  if (cn) {
    cn.count = 0;
    cn.listing = () => ({ body: listingPage([]) });
    cn.settings = () => ({ delay: 1500, body: '{"grid":{"rows":{"min":4,"max":8}}}' });
  }
  await run('flip-late-settings', async ({ page, dir, say }) => {
    need();
    await reduce(page);
    const mark = errors.length;
    await flipUI(page);
    eq((await backGeom(page)).capText, `Shuffle 3${TIMES}3`, 'caption before the settings arrive');
    await ready(page);
    const g = await backGeom(page);
    eq(g.capText, `Shuffle 4${TIMES}3`, 'caption after the settings arrive');
    eq(g.cells, solvedBoard(12), 'back cells after the settings arrive');
    expectBackLayout(g, 4, 3, 'after arrival');
    eq(await board(page), solvedBoard(12), 'board after arrival');
    await gridOf(page, 4, 3, 'board 4x3');
    await shot(page, dir, 'back-after-arrival.png');
    await flipUI(page);
    eq(await pressedOf(page), 'false', 'aria-pressed after flipping back');
    ok(!(await page.$eval('#frame', (e) => e.inert)), 'frame inert after flipping back');
    eq(errors.slice(mark), [], 'console output');
    say('flipped before the delayed settings arrived: back "Shuffle 3×3", then "Shuffle 4×3" with 12 cells; flipping back works');
  }, { url: cn ? cn.origin + '/' : undefined });
  if (cn) cn.settings = null;

  // preset-requests: AC6. The Python servers only ever saw the page and images/.
  await run('preset-requests', async ({ say }) => {
    need();
    await sleep(300);
    let total = 0;
    for (const [k, s] of Object.entries(S)) {
      total += s.log.length;
      say(`${k}: ${s.log.length} requests: ${JSON.stringify([...new Set(s.log.map((e) => e.path))])}`);
      for (const e of s.log) ok(e.path === '/' || e.path === '/index.html' || e.path === '/settings.json' || e.path.startsWith('/images/'), `${k}: unexpected GET ${e.path}`);
      ok(!s.log.some((e) => e.path === '/favicon.ico'), k + ': /favicon.ico requested');
    }
    ok(total > 0, 'server logs are empty');
  }, { shoot: false });

  // preset-layout: R6. The grown New dialog still fits and reads on every view.
  await run('preset-layout', async ({ page, dir, say }) => {
    need();
    for (const [w, h] of VIEWS) {
      await page.setViewportSize({ width: w, height: h });
      await page.click('#new');
      await presetRowVisible(page);
      const tag = `${w}x${h} New+presets`;
      const m = await page.evaluate(() => {
        const d = document.querySelector('#new-dialog');
        const rc = (e) => { const q = e.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom }; };
        const n3 = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        const vis = (e) => e.getClientRects().length > 0;
        const leaves = [...d.querySelectorAll('label, legend, .hint, h2, button')].filter(vis).map((e) => ({ name: e.tagName + (e.id ? '#' + e.id : ''), colour: n3(getComputedStyle(e).color) }));
        const greens = [d, ...d.querySelectorAll('*')].flatMap((e) => { const cs = getComputedStyle(e); return [['color', cs.color], ['background', cs.backgroundColor]].map(([k, v]) => ({ name: e.tagName + (e.id ? '#' + e.id : '') + ' ' + k, c: n3(v) })); }).filter((x) => x.c.length === 3 && x.c[1] > x.c[0] + 20 && x.c[1] > x.c[2] + 20).map((x) => x.name);
        return {
          d: rc(d), sw: d.scrollWidth, cw: d.clientWidth, docCw: document.documentElement.clientWidth, ih: window.innerHeight,
          controls: [...d.querySelectorAll('button, select')].filter(vis).map((e) => ({ name: e.id, box: rc(e) })), leaves, greens,
        };
      });
      ok(m.d.l >= 0 && m.d.r <= m.docCw && m.d.t >= 0 && m.d.b <= m.ih, `${tag}: dialog box ${JSON.stringify(m.d)} outside the viewport`);
      ok(m.sw <= m.cw, `${tag}: dialog scrollWidth ${m.sw} > clientWidth ${m.cw}`);
      ok(m.controls.some((k) => k.name === 'preset'), tag + ': #preset not among the controls checked');
      for (const k of m.controls) ok(inside(k.box, m.d), `${tag}: ${k.name} outside the dialog`);
      for (const l of m.leaves) ok(l.colour.every((v) => v >= 230), `${tag}: ${l.name} text colour ${l.colour} below 230`);
      ok(m.leaves.length >= 4, tag + ': too few text leaves checked');
      eq(m.greens, [], tag + ' green text or background');
      const bg = await colours(page, '#new-dialog');
      nonVacuous(bg, tag + ' dialog background', say);
      ok(bg.every((x) => maxc(x) <= 48), tag + ': dialog background not dark plastic');
      const sb = await colours(page, '#preset');
      nonVacuous(sb, tag + ' #preset background', say);
      ok(sb.every((x) => maxc(x) <= 48), tag + ': #preset background not dark plastic');
      const sc = rgbOf(await style(page, '#preset', 'color'));
      ok(sc.every((v) => v >= 230), `${tag}: #preset text colour ${sc} below 230`);
      say(`${tag}: dialog inside the viewport, ${m.controls.length} controls inside (incl. #preset), ${m.leaves.length} text leaves light, #preset dark with light text`);
      await shot(page, dir, `new-${w}.png`);
      await page.click('#new-cancel');
    }
  }, { url: U(S.real) });

  // readme-run: R8. The README says how to run it over HTTP.
  await run('readme-run', async ({ say }) => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    ok(readme.includes('python -m http.server 8000'), 'README lacks python -m http.server 8000');
    ok(readme.includes('http://localhost:8000/'), 'README lacks http://localhost:8000/');
    say('README has the run command and the URL');
  }, { shoot: false });

  // ---- #17 lock the solved puzzle and show a prominent win banner. Each check uses reduced motion unless it is about motion. ----
  // On a fresh solved board, slide the last tile left and back: a real solve in 2 moves.
  const solveUI = async (page, r, c) => { await click(page, r * c - 2); await click(page, r * c - 1); };
  const lockState = async (page) => {
    const t = await page.$eval('#board .tile:not(.empty)', (e) => ({ cursor: getComputedStyle(e).cursor, aria: e.getAttribute('aria-disabled') }));
    return { labels: await imgBoard(page), moves: await movesOf(page), timer: await timerOf(page), msg: await page.$eval('#message', (e) => !e.hidden), locked: await page.$eval('#board', (e) => e.classList.contains('locked')), cursor: t.cursor, aria: t.aria };
  };
  const hoverFilter = async (page, i) => { await page.hover(`#board .tile[data-index="${i}"]`); return page.$eval(`#board .tile[data-index="${i}"]`, (e) => getComputedStyle(e).filter); };
  const legalIndex = async (page) => { const e = (await board(page)).indexOf('_'); return e % 3 ? e - 1 : e + 1; };

  // win-lock: AC1. A solved board ignores clicks, double clicks, keys, mouse and touch; the cue is visible; Flip still works.
  await run('win-lock', async ({ page, dir, say }) => {
    await reduce(page);
    // (a) numbers 3x3
    eq(await style(page, '#board .tile[data-index="5"]', 'cursor'), 'pointer', 'cursor before the solve');
    eq(await hoverFilter(page, 5), 'brightness(1.04)', 'hover filter before the solve');
    await solveUI(page, 3, 3);
    const s0 = await lockState(page);
    eq(s0.labels, SOLVED, 'board after solve');
    eq(s0.moves, 2, 'moves after solve');
    ok(s0.msg, 'message hidden after solve');
    ok(s0.locked, '#board lacks .locked after solve');
    eq(s0.cursor, 'default', 'cursor on a non-empty tile when locked');
    eq(s0.aria, 'true', 'aria-disabled when locked');
    eq(await page.$$eval('#board .tile:not(.empty)', (els) => els.filter((e) => e.getAttribute('aria-disabled') !== 'true').length), 0, 'tiles without aria-disabled');
    eq(await hoverFilter(page, 5), 'none', 'hover filter when locked');
    const T = s0.timer;
    await shot(page, dir, 'locked-numbers.png');
    for (let i = 0; i < 9; i++) await fclick(page, i);
    await page.dblclick('#board .tile[data-index="7"]', { force: true });
    await page.focus('#board .tile[data-index="7"]');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    const c5 = await centreOf(page, '#board .tile[data-index="5"]');
    await page.mouse.click(c5.x, c5.y);
    await sleep(1200);
    const s1 = await lockState(page);
    eq(s1, { ...s0, timer: T }, 'state after every input on the locked numbers board');
    say(`numbers: ${JSON.stringify(s1)}; clicks 0..8, dblclick, Enter, Space and a mouse click ignored; timer stayed ${T}`);
    // touch
    await withPage(PAGE_URL, async (pg) => {
      await solveUI(pg, 3, 3);
      const a = await lockState(pg);
      const c = await centreOf(pg, '#board .tile[data-index="5"]');
      await pg.touchscreen.tap(c.x, c.y);
      await sleep(300);
      eq(await lockState(pg), a, 'state after a tap on the locked board');
    }, { hasTouch: true, reducedMotion: 'reduce' });
    say('touch tap ignored');
    // (c) both faces
    await flipUI(page);
    await flipUI(page);
    ok(!(await page.$eval('#flip', (e) => e.disabled)), '#flip disabled while locked');
    await fclick(page, 7);
    await fclick(page, 8);
    eq(await lockState(page), { ...s0, timer: T }, 'state after flipping twice and clicking 7 and 8');
    say('flip twice, then clicks ignored; #flip enabled');
    // (b) image 3x3
    await newImageUI(page, 3, 3, 'landscape.png');
    await cropDoneUI(page);
    await solveUI(page, 3, 3);
    const labels = await imgBoard(page), px = await pieceSample(page);
    const i0 = await lockState(page);
    eq(i0.moves, 2, 'image moves after solve');
    ok(i0.msg && i0.locked, 'image: message or lock missing');
    for (let i = 0; i < 9; i++) await fclick(page, i);
    await page.focus('#board .tile[data-index="7"]');
    await page.keyboard.press('Enter');
    eq(await imgBoard(page), labels, 'image labels after clicks');
    eq(await pieceSample(page), px, 'image pieces after clicks');
    eq((await lockState(page)).moves, 2, 'image moves after clicks');
    await shot(page, dir, 'locked-image.png');
    say('image 3x3: labels, pieces and moves unchanged after clicks and Enter');
  });

  // win-unlock: AC2, AC5. Shuffle and New unlock; cancelling New keeps the lock.
  await run('win-unlock', async ({ page, say }) => {
    await reduce(page);
    const msg = page.locator('#message');
    await solveUI(page, 3, 3);
    ok(await msg.isVisible(), 'setup: message hidden after solve');
    await page.click('#shuffle');
    ok(!(await msg.isVisible()), 'message visible after Shuffle');
    eq(await movesOf(page), 0, 'moves after Shuffle');
    eq(await timerOf(page), 0, 'timer after Shuffle');
    ok(!(await page.$eval('#board', (e) => e.classList.contains('locked'))), '.locked after Shuffle');
    await click(page, await legalIndex(page));
    eq(await movesOf(page), 1, 'moves after a legal click following Shuffle');
    say('Shuffle: message hidden, moves 0, timer 0, unlocked, legal click gives moves 1');
    await setSizeUI(page, 3, 3);
    await solveUI(page, 3, 3);
    ok(await msg.isVisible(), 'setup 2: message hidden after solve');
    await setSizeUI(page, 3, 3);
    ok(!(await msg.isVisible()), 'message visible after New');
    eq(await board(page), SOLVED, 'board after New');
    eq(await movesOf(page), 0, 'moves after New');
    ok(!(await page.$eval('#board', (e) => e.classList.contains('locked'))), '.locked after New');
    await click(page, 7);
    eq(await movesOf(page), 1, 'moves after click 7 following New');
    ok(!(await msg.isVisible()), 'message visible after one move');
    say('New (numbers 3x3): solved at moves 0, unlocked, click 7 gives moves 1, message hidden');
    await click(page, 8);
    ok(await msg.isVisible(), 'setup 3: message hidden after solve');
    await page.click('#new');
    await page.click('#new-cancel');
    await page.waitForFunction(() => !document.getElementById('new-dialog').open);
    ok(await msg.isVisible(), 'message hidden after New then Cancel');
    ok(await page.$eval('#board', (e) => e.classList.contains('locked')), 'lock lost after New then Cancel');
    await fclick(page, 5);
    eq(await movesOf(page), 2, 'moves after a click following Cancel');
    eq(await board(page), SOLVED, 'board after a click following Cancel');
    say('New then Cancel: still locked, message visible, click ignored');
    await newImageUI(page, 3, 3, 'landscape.png');
    await cropDoneUI(page);
    ok(!(await msg.isVisible()), 'message visible after New image');
    ok(!(await page.$eval('#board', (e) => e.classList.contains('locked'))), '.locked after New image');
    await click(page, 7);
    eq(await movesOf(page), 1, 'moves after a click following New image');
    await click(page, 8);
    ok(await msg.isVisible(), 'image: message hidden after solve');
    await setSizeUI(page, 4, 4);
    ok(!(await msg.isVisible()), 'message visible after a 4x4 New');
    eq(await movesOf(page), 0, 'moves after a 4x4 New');
    say('New image: unlocked and playable; 4x4 New: message hidden at moves 0');
  });

  // win-banner: AC3. A large, bold, white script banner on dark plastic, at 1280 and 360 wide.
  await run('win-banner', async ({ page, dir, say }) => {
    await reduce(page);
    for (const [w, h] of [[1280, 800], [360, 740]]) {
      await page.setViewportSize({ width: w, height: h });
      await setSizeUI(page, 3, 3);
      await solveUI(page, 3, 3);
      const tag = `${w}x${h}`;
      ok(await page.locator('#message').isVisible(), tag + ': message hidden');
      const fm = parseFloat(await style(page, '#message', 'fontSize')), fs2 = parseFloat(await style(page, '#moves', 'fontSize'));
      ok(fm >= 1.75 * fs2, `${tag}: message font ${fm}px not at least 1.75x the status ${fs2}px`);
      ok(Number(await style(page, '#message', 'fontWeight')) >= 700, tag + ': font weight');
      eq(await style(page, '#message', 'fontStyle'), 'italic', tag + ' font-style');
      eq(await style(page, '#message', 'fontFamily'), await style(page, 'h1.brand', 'fontFamily'), tag + ' font family against the title');
      const tc = rgbOf(await style(page, '#message', 'color'));
      ok(tc.every((v) => v >= 230), `${tag}: text colour ${tc}`);
      const bg = await colours(page, '#message');
      nonVacuous(bg, tag + ' #message', say);
      ok(bg.every((c) => maxc(c) <= 48), `${tag}: a background colour is not dark plastic: ${JSON.stringify(bg)}`);
      const ratio = (lum(tc) + 0.05) / (Math.max(...bg.map(lum)) + 0.05);
      ok(ratio >= 7, `${tag}: contrast ${ratio.toFixed(2)} below 7`);
      ok(!isGreen(tc) && !bg.some(isGreen), tag + ': green');
      say(`${tag}: font ${fm}px against ${fs2}px, contrast ${ratio.toFixed(1)}`);
      await shot(page, dir, `solved-${w}.png`);
    }
  });

  // win-banner-motion: AC3. A short pop on a solve, none under reduced motion.
  await run('win-banner-motion', async ({ page, dir, say }) => {
    // The solve clicks and the first reading are in one page task, so a slow machine cannot let the 0.35s animation finish first.
    const info = await page.evaluate(() => {
      const msg = document.getElementById('message');
      document.querySelector('#board .tile[data-index="7"]').click();
      document.querySelector('#board .tile[data-index="8"]').click();
      const a = msg.getAnimations();
      const out = { n: a.length, names: a.map((x) => x.animationName), state: a.map((x) => x.playState), dur: parseFloat(getComputedStyle(msg).animationDuration) };
      a.forEach((x) => { x.pause(); x.currentTime = 100; });
      return out;
    });
    eq({ n: info.n, names: info.names, state: info.state }, { n: 1, names: ['win-pop'], state: ['running'] }, 'the win animation');
    ok(info.dur > 0, 'animation duration ' + info.dur);
    await shot(page, dir, 'mid-pop.png');
    await page.evaluate(() => document.getElementById('message').getAnimations().forEach((x) => x.play()));
    await page.waitForFunction(() => document.getElementById('message').getAnimations().length === 0);
    eq(await style(page, '#message', 'opacity'), '1', 'opacity after the pop');
    say(`one running win-pop animation, ${info.dur}s; opacity 1 when finished`);
    await withPage(PAGE_URL, async (pg) => {
      const r = await pg.evaluate(() => {
        const msg = document.getElementById('message');
        document.querySelector('#board .tile[data-index="7"]').click();
        document.querySelector('#board .tile[data-index="8"]').click();
        return { shown: !msg.hidden, name: getComputedStyle(msg).animationName, n: msg.getAnimations().length, op: getComputedStyle(msg).opacity };
      });
      eq(r, { shown: true, name: 'none', n: 0, op: '1' }, 'reduced motion: banner at once');
    }, { reducedMotion: 'reduce' });
    say('reduced motion: animation none, no animations, opacity 1 at once');
  }, { video: true });

  // win-a11y: AC4. A polite live region sits in the accessibility tree before the banner appears and holds the text after.
  await run('win-a11y', async ({ page, say }) => {
    await reduce(page);
    const attrs = await page.$eval('#win', (e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), atomic: e.getAttribute('aria-atomic'), isParent: document.getElementById('message').parentElement === e }));
    eq(attrs, { role: 'status', live: 'polite', atomic: 'true', isParent: true }, '#win attributes');
    const cdp = await page.context().newCDPSession(page);
    const readLive = async () => {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const node = nodes.find((n) => !n.ignored && n.role && n.role.value === 'status' && (n.properties || []).some((p) => p.name === 'live' && p.value.value === 'polite'));
      if (!node) return null;
      const texts = [];
      const walk = (n) => { for (const id of n.childIds || []) { const ch = byId.get(id); if (!ch) continue; if (ch.role && ch.role.value === 'StaticText' && ch.name) texts.push(ch.name.value); walk(ch); } };
      walk(node);
      return texts;
    };
    const before = await readLive();
    ok(before !== null, 'no non-ignored status node with live=polite before the solve');
    ok(!before.join(' ').includes('You solved it!'), 'text in the live region before the solve: ' + before.join('|'));
    await solveUI(page, 3, 3);
    const after = await readLive();
    ok(after !== null, 'live region gone after the solve');
    ok(after.join(' ').includes('You solved it!'), 'text in the live region after the solve: ' + JSON.stringify(after));
    say(`status/polite node present before (texts ${JSON.stringify(before)}) and after (texts ${JSON.stringify(after)})`);
  }, { shoot: false });

  // win-sizes: AC4, AC6. At every size, on a solve the banner stays in the viewport, off the board, and nothing moves or scrolls. Classic scrollbars.
  {
    const name = 'win-sizes';
    const dir = path.join(OUT, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const log = [];
    const sb = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      for (const [w, h] of [[1280, 800], [360, 740]]) {
        const ctx = await sb.newContext({ viewport: { width: w, height: h } });
        const page = await ctx.newPage();
        page.on('request', (r) => requests.push(r.url()));
        page.on('pageerror', (e) => errors.push({ text: 'pageerror: ' + e.message, url: '' }));
        page.on('console', (m) => { if (m.type() === 'error') errors.push({ text: 'console: ' + m.text(), url: m.location().url }); });
        await page.goto(PAGE_URL);
        await reduce(page);
        const cases = [...SIZES.map(([r, c]) => ({ kind: 'numbers', r, c })), ...[[3, 3], [10, 10], [3, 10]].map(([r, c]) => ({ kind: 'image', r, c }))];
        for (const k of cases) {
          if (k.kind === 'numbers') await setSizeUI(page, k.r, k.c); else { await newImageUI(page, k.r, k.c, 'landscape.png'); await cropDoneUI(page); }
          const tag = `${k.kind} ${k.r}x${k.c} at ${w}x${h}`;
          const geom = () => page.evaluate(() => ({ sh: document.documentElement.scrollHeight, cw: document.documentElement.clientWidth, ih: window.innerHeight, tiles: [...document.querySelectorAll('#board .tile')].map((e) => { const q = e.getBoundingClientRect(); return { l: q.left, t: q.top, w: q.width, h: q.height }; }) }));
          const before = await geom();
          await solveUI(page, k.r, k.c);
          ok(await page.locator('#message').isVisible(), tag + ': message hidden after the solve');
          const after = await geom();
          const m = await rect(page, '#message'), pl = await rect(page, '#plate'), fr = await rect(page, '.frame');
          ok(m.l >= -0.5 && m.r <= after.cw + 0.5 && m.t >= -0.5 && m.b <= after.ih + 0.5, `${tag}: message ${JSON.stringify(m)} outside the viewport ${after.cw}x${after.ih}`);
          ok(!overlap(m, pl) && !overlap(m, fr), tag + ': message intersects the plate or frame');
          ok(after.sh <= after.ih, `${tag}: vertical scroll, scrollHeight ${after.sh} > ${after.ih}`);
          eq(after.tiles.length, before.tiles.length, tag + ' tile count');
          after.tiles.forEach((q, i) => {
            const p = before.tiles[i];
            ok(['l', 't', 'w', 'h'].every((key) => Math.abs(q[key] - p[key]) <= 0.5), `${tag}: tile ${i} moved or resized, ${JSON.stringify(p)} to ${JSON.stringify(q)}`);
          });
          const covered = await page.evaluate(() => [...document.querySelectorAll('#board .tile')].filter((t) => {
            const q = t.getBoundingClientRect();
            const el = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
            const hit = el && el.closest('.tile');
            return hit !== t;
          }).length);
          eq(covered, 0, tag + ': tiles covered by something else');
          const lab = await imgBoard(page);
          await fclick(page, k.r * k.c - 2);
          eq(await imgBoard(page), lab, tag + ': a click moved a tile');
          log.push(`${tag}: message ${m.w.toFixed(0)}x${m.h.toFixed(0)} at ${m.l.toFixed(0)},${m.t.toFixed(0)}; scrollHeight ${after.sh} <= ${after.ih}; tile ${after.tiles[0].w.toFixed(1)}px unchanged; click ignored`);
          await shot(page, dir, `${k.kind === 'image' ? 'image-' : ''}${k.r}x${k.c}-${w}.png`);
        }
        await ctx.close();
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

  // single-file: AC1 (runs near the end so the change set includes the evidence written by the other checks)
  await run('single-file', async ({ say }) => {
    const sh = (c) => execSync(c.replace(/^git /, 'git -c core.quotepath=off '), { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const changed = new Set([
      ...sh(`git diff --name-only ${BASE}...HEAD`),
      ...sh('git diff --name-only HEAD'),
      ...sh('git diff --name-only --cached'),
      ...sh('git ls-files --others --exclude-standard'),
    ]);
    say('changed set: ' + [...changed].join(', '));
    const bad = [...changed].filter((f) => f !== 'index.html' && f !== 'settings.json' && f !== 'README.md' && !f.startsWith('test-results/') && !(f.startsWith('images/') && !f.slice(7).includes('/') && R1.test(f)));
    eq(bad, [], 'files outside index.html, settings.json, README.md, test-results/** and images/<image>');
    ok(changed.has('index.html'), 'index.html not in change set');
    const tracked = sh('git ls-files images/');
    ok(tracked.length >= 1, 'no tracked file under images/');
    eq(tracked.filter((f) => !R1.test(f)), [], 'tracked files under images/ without a recognised extension');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const pats = { 'src=': /src=/, 'href= (not #)': /href=(?!["']#)/, '@import': /@import/, 'url(': /url\(/, 'type="module"': /type="module"/, 'fetch(': /fetch\(/, XMLHttpRequest: /XMLHttpRequest/, '@font-face': /@font-face/, '<link': /<link/ };
    const want = { 'fetch(': 3, '<link': 1, 'href= (not #)': 1 };
    for (const [k, re] of Object.entries(pats)) {
      const n = (html.match(new RegExp(re.source, 'g')) || []).length;
      say(`grep ${k}: ${n} matches`);
      eq(n, want[k] || 0, `grep ${k}`);
    }
    ok(html.includes("fetch('images/'"), "fetch('images/' missing");
    eq((html.match(/fetch\('settings\.json'/g) || []).length, 1, "fetch('settings.json' count");
    eq(html.match(/<link[^>]*>/g), ['<link rel="icon" href="data:,">'], 'the one <link>');
    eq(html.match(/href=[^>\s]*/g), ['href="data:,"'], 'the one href=');
  }, { shoot: false });

  // logic-unchanged: #3 section 4 (I9). The seven game-logic functions are byte-identical to the merge base.
  await run('logic-unchanged', async ({ say }) => {
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const baseHtml = norm(execSync(`git show ${BASE}:index.html`, { encoding: 'utf8', maxBuffer: 1 << 26 }));
    const nowHtml = norm(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const extract = (h, f) => {
      const a = h.indexOf(`function ${f}(`);
      if (a === -1) return null;
      const b = h.indexOf('\n}', a);
      return b === -1 ? null : h.slice(a, b + 2);
    };
    for (const f of ['move', 'shuffle', 'isSolvable', 'isSolved', 'checkWin', 'startTimer', 'setSize']) {
      const a = extract(baseHtml, f), b = extract(nowHtml, f);
      ok(a !== null, `${f} not found at BASE`);
      ok(b !== null, `${f} not found in the working tree`);
      ok(a === b, `${f} differs from BASE`);
      say(`${f}: ${a.length} bytes, identical to ${BASE.slice(0, 7)}`);
    }
  }, { shoot: false });

  // no-inline-handlers: #7's markup grep, unchanged.
  await run('no-inline-handlers', async ({ say }) => {
    const nowHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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
    const allowed = (u) => {
      if (u === PAGE_URL || u === 'data:,') return true;
      let q;
      try { q = new URL(u); } catch (_) { return false; }
      return driverOrigins.has(q.origin) && (q.pathname === '/' || q.pathname === '/index.html' || q.pathname === '/settings.json' || q.pathname.startsWith('/images/'));
    };
    eq(uniq.filter((u) => !allowed(u)), [], 'urls other than the page, the data icon and same-origin images/');
  }, { shoot: false });

  await run('console', async ({ say }) => {
    say(`errors collected: ${errors.length}`);
    errors.forEach((e) => say(e.text + ' @ ' + e.url));
    const unexpected = errors.filter((e) => !expectedConsole.some((x) => e.url === x.url && e.text.startsWith('console: ' + x.prefix)));
    say(`registered expectations: ${JSON.stringify(expectedConsole)}`);
    eq(unexpected.map((e) => e.text + ' @ ' + e.url), [], 'runtime errors');
  }, { shoot: false });

  await stopAll();
  await browser.close();
  fs.rmSync(tmpVideo, { recursive: true, force: true });
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  fs.writeFileSync(path.join(OUT, 'verify-output.txt'), text);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
