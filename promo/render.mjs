// 逐帧渲染：起一个本地静态服务，Playwright 打开 index.html，seek(t) 一帧截一张，喂给 ffmpeg。
// 运动模糊：每帧在半个帧间隔（180° 快门）里取 blur 个子帧，ffmpeg 平均。
//
//   node render.mjs --aspect 16x9 --to 19 --fps 60 --blur 2 --out out/opening-16x9.mp4
//   node render.mjs --aspect 9x16 --stills 1,4,9 --out out/stills   # 只出几张图
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(execGlobalRoot(), 'playwright')); }
function execGlobalRoot() { return require('node:child_process').execSync('npm root -g').toString().trim(); }

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']);
    return acc;
  }, []),
);
const aspect = args.aspect || '16x9';
const fps = +(args.fps || 30);
const blur = +(args.blur || 1);
const from = +(args.from || 0);
const scale = +(args.scale || 1);
const workers = +(args.workers || Math.max(1, Math.min(4, os.cpus().length)));
const subs = args.subs === '1';
const out = path.resolve(args.out || `out/promo-${aspect}.mp4`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const p = path.join(repo, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(repo) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/promo/index.html?aspect=${aspect}${subs ? '&subs=1' : ''}`;
const [W, H] = aspect === '9x16' ? [1080, 1920] : [1920, 1080];

const browser = await playwright.chromium.launch({ args: ['--disable-gpu-vsync', '--font-render-hinting=none', '--force-color-profile=srgb'] });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__film && (window.__film.ready || window.__film.error), null, { timeout: 120000 });
  const err = await page.evaluate(() => window.__film.error);
  if (err) throw new Error(err);
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp };
}

async function grab({ page, cdp }, t, format = 'jpeg') {
  await page.evaluate((tt) => window.__film.seek(tt), t);
  const r = await cdp.send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 94 : undefined, optimizeForSpeed: true, captureBeyondViewport: false });
  return Buffer.from(r.data, 'base64');
}

if (args.stills) {
  fs.mkdirSync(out, { recursive: true });
  const p = await openPage();
  for (const s of args.stills.split(',')) {
    const t = +s;
    fs.writeFileSync(path.join(out, `${aspect}-${t.toFixed(2)}.png`), await grab(p, t, 'png'));
  }
  const info = await p.page.evaluate(() => ({ duration: window.__film.duration, marks: window.__film.marks }));
  console.log(JSON.stringify(info));
  await browser.close();
  server.close();
  process.exit(0);
}

// ---------- 视频 ----------
const info = await (async () => {
  const p = await openPage();
  const r = await p.page.evaluate(() => ({ duration: window.__film.duration, events: window.__film.events }));
  await p.page.close();
  return r;
})();
const to = +(args.to || info.duration);
const total = Math.round((to - from) * fps);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out.replace(/\.mp4$/, '.events.json'), JSON.stringify(info.events, null, 0));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-'));
const chunk = Math.ceil(total / workers);
const t0 = Date.now();
let done = 0;

async function renderChunk(w) {
  const a = w * chunk;
  const b = Math.min(total, a + chunk);
  if (a >= b) return null;
  const file = path.join(tmp, `part-${String(w).padStart(2, '0')}.mp4`);
  const vf = blur > 1 ? `tmix=frames=${blur},select='eq(mod(n\\,${blur})\\,${blur - 1})',setpts=N/(${fps}*TB)` : 'null';
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps * blur), '-i', '-', '-vf', vf, '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const p = await openPage();
  for (let i = a; i < b; i++) {
    for (let j = 0; j < blur; j++) {
      const t = from + (i + (blur > 1 ? (0.5 * j) / blur - 0.25 : 0)) / fps;
      const buf = await grab(p, Math.max(0, t));
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    done++;
    if (done % 60 === 0) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`\r${done}/${total} 帧  ${(done / el).toFixed(1)} 帧/秒  剩约 ${Math.round(((total - done) * el) / done)} 秒   `);
    }
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await p.page.close();
  return file;
}

const parts = (await Promise.all(Array.from({ length: workers }, (_, w) => renderChunk(w)))).filter(Boolean);
const list = path.join(tmp, 'list.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
await new Promise((r) => spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { stdio: 'inherit' }).on('close', r));
console.log(`\n完成：${out}（${total} 帧，${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
