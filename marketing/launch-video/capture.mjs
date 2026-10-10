// Captures real portal footage for the launch video, frame-exact, from a running `netlify dev`.
//   npm run build && npx netlify dev --offline --port 8890
//   node marketing/launch-video/capture.mjs [shot ...]        (no args = every shot)
// The page's clock and requestAnimationFrame are virtualized, so each screenshot is exactly 1/30 s after the last
// regardless of how slowly the (software) GPU renders. Output: marketing/launch-video/frames/<shot>/NNNN.jpg.
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(HERE, 'frames');
const BASE = process.env.PORTAL_URL || 'http://localhost:8890';
const STEP = 1000 / 30;
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const INIT = `(() => {
  const realNow = performance.now.bind(performance);
  const realRAF = window.requestAnimationFrame.bind(window);
  let frozen = false, vt = 0, queue = [];
  performance.now = () => (frozen ? vt : realNow());
  window.requestAnimationFrame = (cb) => { if (!frozen) return realRAF(cb); queue.push(cb); return queue.length; };
  // Smooth scrolling never settles under a frozen clock and stalls screenshots.
  for (const m of ['scrollBy', 'scrollTo', 'scroll']) { const f = Element.prototype[m]; Element.prototype[m] = function (o, y) { return f.call(this, typeof o === 'object' ? { ...o, behavior: 'instant' } : o, y); }; }
  const siv = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (o) { return siv.call(this, typeof o === 'object' ? { ...o, behavior: 'instant' } : o); };
  window.__freeze = () => { vt = realNow(); frozen = true; };
  window.__step = (ms) => { vt += ms; const q = queue; queue = []; q.forEach((cb) => cb(vt)); };
})();`;
// Full-bleed viewer: hide the portal chrome around the 3D stage.
const STAGE_CSS = `
  html,body{overflow:hidden!important;background:#000!important}
  #modelStage{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:99999!important;margin:0!important;border:0!important;border-radius:0!important}
  #rotatePrev,#rotateNext,.orientation,.viewer-hint,.stage-hint,.viewer-foot{display:none!important}`;

const pages = [];
async function open(browser, slug, { w, h, stage = true }) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.addInitScript(INIT);
  page.on('pageerror', (e) => console.error(slug, 'pageerror:', e.message));
  await page.goto(`${BASE}/${slug}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => { const l = document.getElementById('viewerLoading'); return !l || l.hidden || getComputedStyle(l).display === 'none' || getComputedStyle(l).opacity === '0'; }, null, { timeout: 180000 });
  // Freeze as soon as the model is up so intro shots start on the intro's opening pose.
  await page.evaluate(() => window.__freeze());
  if (stage) { await page.addStyleTag({ content: STAGE_CSS }); await page.evaluate(() => window.dispatchEvent(new Event('resize'))); }
  await page.waitForTimeout(1500); // logo textures and the resized canvas settle; the frozen clock does not advance
  await skip(page, 1);
  pages.push(page);
  return page;
}
// Advance without capturing; reading one pixel back makes the GPU finish each frame so work does not pile up.
async function skip(page, n) {
  for (let i = 0; i < n; i++) {
    await page.evaluate((ms) => {
      window.__step(ms);
      const c = document.querySelector('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl');
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }, STEP);
  }
}
async function record(page, shot, frames, onFrame) {
  const dir = join(FRAMES, shot);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < frames; i++) {
    if (onFrame) await onFrame(i);
    await page.evaluate((ms) => window.__step(ms), STEP);
    await page.screenshot({ path: join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92, timeout: 300000 });
  }
}
// Constant horizontal drag along the floor (below the kit, so no placement hover); 360° = canvas height in px.
function dragger(page, w, h, pxPerFrame) {
  let x = 0, down = false;
  const y = Math.round(h * 0.975);
  return async () => {
    if (!down || x > w * 0.85) { if (down) await page.mouse.up(); x = w * 0.15; await page.mouse.move(x, y); await page.mouse.down(); down = true; }
    x += pxPerFrame; await page.mouse.move(x, y);
  };
}
const click = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
const selectSpot = (page, id) => page.evaluate((id) => [...document.querySelectorAll('.inventory-item')].find((b) => b.textContent.includes(id))?.click(), id);
const garment = (page, g) => click(page, `.garment-tab[data-garment="${g}"]`);
const upload = (page, variant) => page.setInputFiles('#logoInput', join(HERE, 'assets', `your-brand-${variant}.png`));

const SHOTS = {
  'heck-intro': async (b) => { const p = await open(b, 'michael-heckert', { w: 1920, h: 1080 }); await record(p, 'heck-intro', 84); },
  'heck-spin': async (b) => {
    const p = await open(b, 'michael-heckert', { w: 1080, h: 1350 }); await skip(p, 85);
    await record(p, 'heck-spin', 150, dragger(p, 1080, 1350, 10));
  },
  'heck-close': async (b) => {
    const p = await open(b, 'michael-heckert', { w: 1920, h: 1080 }); await skip(p, 85);
    // The inventory lists only the side facing the camera, so every target here is a front placement.
    const plan = { 0: () => selectSpot(p, 'SF-L1'), 40: () => selectSpot(p, 'SF-R2'), 80: async () => { await garment(p, 'shirt'); await selectSpot(p, 'TF-05'); } };
    await record(p, 'heck-close', 170, (i) => plan[i]?.());
  },
  'heck-victory': async (b) => {
    const p = await open(b, 'michael-heckert', { w: 1080, h: 1350 }); await skip(p, 85);
    await record(p, 'heck-victory', 110, (i) => (i === 0 ? click(p, '[data-move="Victory_Chest_Beat"]') : null));
  },
  'demo-upload': async (b) => {
    const p = await open(b, 'demo-boxing-women', { w: 1920, h: 1080 }); await skip(p, 150);
    const plan = {
      0: () => selectSpot(p, 'WB-F1'), 42: () => upload(p, 'dark'),
      70: async () => { await garment(p, 'crop-top'); await selectSpot(p, 'CT-F1'); }, 108: () => upload(p, 'light'),
      136: async () => { await garment(p, 'trunks'); await selectSpot(p, 'SF-L1'); }, 172: () => upload(p, 'dark'),
      196: () => p.evaluate(() => document.querySelector('canvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))),
    };
    const uploads = new Set([42, 108, 172]);
    await record(p, 'demo-upload', 250, async (i) => { await plan[i]?.(); if (uploads.has(i)) await p.waitForTimeout(400); });
  },
  ui: async (b) => {
    const p = await open(b, 'demo-boxing-women', { w: 1920, h: 1080, stage: false }); await skip(p, 150);
    await selectSpot(p, 'WB-F1'); await skip(p, 40); await upload(p, 'dark'); await p.waitForTimeout(500); await skip(p, 5);
    mkdirSync(FRAMES, { recursive: true });
    await p.screenshot({ path: join(FRAMES, 'ui-demo-boxing-women.png'), timeout: 300000 });
  },
};
// Each demo's built-in intro: face close-up, pull back, signature move.
for (const slug of ['demo-boxing-men', 'demo-mma-women', 'demo-bjj-gi-men', 'demo-nogi-women']) {
  SHOTS[slug] = async (b) => { const p = await open(b, slug, { w: 1080, h: 1350 }); await record(p, slug, 130); };
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const name of names) {
  if (!SHOTS[name]) throw new Error(`unknown shot ${name}; known: ${Object.keys(SHOTS).join(', ')}`);
  const t = Date.now();
  try { await SHOTS[name](browser); } finally { await Promise.all(pages.splice(0).map((p) => p.close())); } // free each shot's WebGL scene
  console.log(name, `done in ${Math.round((Date.now() - t) / 1000)}s`);
}
await browser.close();
