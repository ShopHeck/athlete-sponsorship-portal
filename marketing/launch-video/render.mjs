// Renders index.html frame by frame into an MP4 (and muxes soundtrack.wav when present).
//   node marketing/launch-video/render.mjs                      → dist/launch-video/asp-launch.mp4
//   node marketing/launch-video/render.mjs --stills 0.5,2.6,9   → PNG stills for review
//   node marketing/launch-video/render.mjs --from 12 --to 18    → partial render
// Needs Playwright (local or global install) and ffmpeg on PATH. Footage frames come from capture.mjs.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = join(ROOT, 'dist/launch-video');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(ROOT) || !existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/marketing/launch-video/index.html`;

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true);
const { duration, fps } = await page.evaluate(() => ({ duration: window.__duration, fps: window.__fps }));
mkdirSync(OUT_DIR, { recursive: true });

if (args.stills) {
  for (const t of String(args.stills).split(',').map(Number)) {
    await page.evaluate((t) => window.__seek(t), t);
    await page.screenshot({ path: join(OUT_DIR, `still-${t.toFixed(2)}.png`) });
  }
  console.log('stills written to', OUT_DIR);
} else {
  const from = Number(args.from ?? 0), to = Number(args.to ?? duration);
  const out = args.out ? resolve(args.out) : join(OUT_DIR, from === 0 && to === duration ? 'asp-launch.mp4' : `asp-launch-${from}-${to}.mp4`);
  const wav = join(HERE, 'soundtrack.wav');
  const withAudio = existsSync(wav) && !args['no-audio'];
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    ...(withAudio ? ['-ss', String(from), '-t', String(to - from), '-i', wav] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round((to - from) * fps);
  const started = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.__seek(t), from + i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 96 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log(`frame ${i}/${total} · ${Math.round((Date.now() - started) / 1000)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
