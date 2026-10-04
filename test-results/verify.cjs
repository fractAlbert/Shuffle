// Verification driver (test tooling, not app code). See plan section 6 of issues #1, #2, #3, #4, #5, #7 and #13.
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
          return { fr, well: rc(document.querySelector('.well')), tiles, emptyBg: bg('.tile.empty'), tileBg: bg('.tile:not(.empty)'), emptyColour: bgColour('.tile.empty'), tileColour: bgColour('.tile:not(.empty)'), board: rc(document.getElementById('board')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ih: window.innerHeight, actions: rc(document.querySelector('.actions')), status: rc(document.querySelector('.status')), shuffle: rc(document.getElementById('shuffle')), msgBox };
        });
        const tag = `${w}x${h} ${r}x${c}`;
        say(`${tag}: tile ${m.tiles[0].w.toFixed(1)}px, frame ${m.fr.l.toFixed(1)}..${m.fr.r.toFixed(1)}, cw ${m.cw}, msgBottom ${m.msgBox.b.toFixed(1)}`);
        ok(m.sw <= m.cw, `${tag}: horizontal scroll ${m.sw} > ${m.cw}`);
        ok(m.tiles.every((q) => Math.abs(q.w - q.h) <= 1), tag + ': tiles not square');
        ok(m.tiles.every((q) => q.w >= 40), `${tag}: tile under 40px (${m.tiles[0].w})`);
        ok(m.emptyBg !== m.tileBg, tag + ': empty bg equals tile bg');
        ok(m.emptyColour !== m.tileColour, tag + ': empty background-color equals tile background-color (#2 assertion)');
        ok(Math.abs(m.fr.l - (m.cw - m.fr.r)) <= 2, `${tag}: frame margins ${m.fr.l} vs ${m.cw - m.fr.r}`);
        for (const [k, q] of [['.actions', m.actions], ['.status', m.status], ['#shuffle', m.shuffle], ['#message', m.msgBox]]) ok(q.l >= 0 && q.r <= m.cw, `${tag}: ${k} outside [0, clientWidth]`);
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
        const nwC = await colours(page, '#new');
        nonVacuous(nwC, tag + ' #new', say);
        ok(nwC.every((x) => maxc(x) <= 64), tag + ': #new not dark plastic');
        ok(rgbOf(await style(page, '#new', 'color')).every((v) => v >= 230), tag + ': #new text not white');
        for (const sel of ['#moves', '#timer', '#shuffle', '#new']) ok(!overlap(await rect(page, sel), fr), `${tag}: ${sel} intersects frame`);
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
    for (const f of ['render', 'move', 'setSize', 'shuffle', 'isSolvable', 'isSolved', 'checkWin', 'openNew', 'startNew', 'onDecoded', 'onRejected', 'cropRect', 'openCrop', 'drawCrop', 'moveCrop', 'cutImage', 'cropDone', 'loadPresets', 'parseListing', 'onListed']) {
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

  // image-sizes: C2. Every size 3..6 x 3..6 with an image: split, mapping, solved start.
  await run('image-sizes', async ({ page, dir, say }) => {
    const fx = FIX['landscape.png'];
    for (let r = 3; r <= 6; r++) {
      for (let c = 3; c <= 6; c++) {
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
        if (['3x6', '6x3', '4x5', '6x6'].includes(tag)) await shot(page, dir, `screenshot-${tag}.png`);
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
      for (const [r, c] of [[3, 3], [6, 6], [3, 6], [6, 3]]) {
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
        ok(m.tiles.every((q) => q.w >= 40), `${tag}: tile under 40px`);
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
        ok(Math.abs(m.view.w - m.view.h * A) <= 1, `${tag}: crop view ${m.view.w}x${m.view.h} not within 1px of aspect ${A}`);
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
      for (const [r, c] of [[3, 6], [6, 3]]) {
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
    for (const p of cn.requests) ok(['/', '/index.html', '/images/', '/images/ok.png'].includes(p), 'unexpected request path ' + p);
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

  // preset-requests: AC6. The Python servers only ever saw the page and images/.
  await run('preset-requests', async ({ say }) => {
    need();
    await sleep(300);
    let total = 0;
    for (const [k, s] of Object.entries(S)) {
      total += s.log.length;
      say(`${k}: ${s.log.length} requests: ${JSON.stringify([...new Set(s.log.map((e) => e.path))])}`);
      for (const e of s.log) ok(e.path === '/' || e.path === '/index.html' || e.path.startsWith('/images/'), `${k}: unexpected GET ${e.path}`);
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
    const bad = [...changed].filter((f) => f !== 'index.html' && f !== 'README.md' && !f.startsWith('test-results/') && !(f.startsWith('images/') && !f.slice(7).includes('/') && R1.test(f)));
    eq(bad, [], 'files outside index.html, README.md, test-results/** and images/<image>');
    ok(changed.has('index.html'), 'index.html not in change set');
    ok(changed.has('README.md'), 'README.md not in change set');
    ok([...changed].some((f) => f.startsWith('images/')), 'no images/ file in change set');
    const tracked = sh('git ls-files images/');
    ok(tracked.length >= 1, 'no tracked file under images/');
    eq(tracked.filter((f) => !R1.test(f)), [], 'tracked files under images/ without a recognised extension');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const pats = { 'src=': /src=/, 'href= (not #)': /href=(?!["']#)/, '@import': /@import/, 'url(': /url\(/, 'type="module"': /type="module"/, 'fetch(': /fetch\(/, XMLHttpRequest: /XMLHttpRequest/, '@font-face': /@font-face/, '<link': /<link/ };
    const want = { 'fetch(': 2, '<link': 1, 'href= (not #)': 1 };
    for (const [k, re] of Object.entries(pats)) {
      const n = (html.match(new RegExp(re.source, 'g')) || []).length;
      say(`grep ${k}: ${n} matches`);
      eq(n, want[k] || 0, `grep ${k}`);
    }
    ok(html.includes("fetch('images/'"), "fetch('images/' missing");
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
      return driverOrigins.has(q.origin) && (q.pathname === '/' || q.pathname === '/index.html' || q.pathname.startsWith('/images/'));
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
