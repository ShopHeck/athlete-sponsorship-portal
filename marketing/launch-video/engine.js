// Shared runtime for the seekable launch-video compositions (index.html 16:9, reels.html 9:16).
// Nothing animates on its own: each composition's draw(t) sets every style for time t, and boot() exposes
// window.__seek(t) so render.mjs can screenshot exact frames.
export const FPS = 30;
export const $ = (s) => document.querySelector(s);
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const lerp = (a, b, k) => a + (b - a) * k;
export const eOut = (x) => 1 - Math.pow(1 - x, 3);
export const eExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
export const eInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const eBack = (x) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
export const css = (el, s) => { for (const k in s) el.style[k] = s[k]; };
const pad = (n) => String(n).padStart(4, '0');

/* ------------------------------------------------------------- footage */
let pending = [];
const lenient = new URLSearchParams(location.search).has('lenient'); // layout previews before capture finishes
// Shows frame f of a captured shot; the seek waits for the decode and fails loudly when a frame is missing.
export function footage(dir, counts) {
  return function foot(img, shot, f) {
    const n = counts[shot];
    const src = `${dir}/${shot}/${pad(clamp(Math.floor(f), 0, n - 1))}.jpg`;
    if (img.dataset.src !== src) {
      img.dataset.src = src; img.src = src;
      pending.push(img.decode().catch(() => { if (!lenient) throw new Error(`missing footage ${src} (run capture.mjs ${shot})`); }));
    }
  };
}

/* ------------------------------------------------------------- text motion */
// Impact entrance: scale down from `from` with de-blur.
export function slam(el, t, t0, { from = 2.2, dur = 0.32, blur = 18, base = '' } = {}) {
  const k = prog(t, t0, t0 + dur);
  if (t < t0) { el.style.opacity = 0; return; }
  const e = eExpo(k);
  css(el, { opacity: clamp(k * 3), transform: `${base} scale(${lerp(from, 1, e)})`, filter: k < 1 ? `blur(${(1 - e) * blur}px)` : 'none' });
}
// Each .line > span slides up out of its mask, staggered.
export function lines(root, t, t0, step = 0.12, dur = 0.42) {
  root.querySelectorAll('.line>span').forEach((s, i) => {
    const k = eOut(prog(t, t0 + i * step, t0 + i * step + dur));
    s.style.transform = `translateY(${(1 - k) * 110}%) skewY(${(1 - k) * 6}deg)`;
  });
}
export function linesOut(root, t, t0, dur = 0.3) {
  const k = eInOut(prog(t, t0, t0 + dur));
  if (k > 0) root.querySelectorAll('.line>span').forEach((s) => { s.style.transform = `translateY(${-k * 110}%)`; });
}
export function fadeUp(el, t, t0, dur = 0.5, dist = 30) {
  const k = eOut(prog(t, t0, t0 + dur));
  css(el, { opacity: k, transform: `translateY(${(1 - k) * dist}px)` });
}

/* ------------------------------------------------------------- global fx */
// Overlays live outside #world so shake and punch-zoom move the picture, not the grain or grade.
const FX_CSS = `
#wipe{position:absolute;inset:0;pointer-events:none;display:none;overflow:hidden}
#wipe div{position:absolute;top:-10%;height:120%;transform:skewX(-18deg)}
#wipe .w1{background:var(--accent)}#wipe .w2{background:#151210}#wipe .w3{background:var(--ink)}
#flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;mix-blend-mode:screen}
#leak{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;opacity:.55}
#grade{position:absolute;inset:0;pointer-events:none;mix-blend-mode:soft-light;background:linear-gradient(160deg,rgba(255,150,70,.30),rgba(255,120,40,.06) 45%,rgba(20,60,90,.32))}
#grain{position:absolute;left:-50px;top:-50px;pointer-events:none;opacity:.11;mix-blend-mode:overlay}
#vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 95% at 50% 50%,transparent 58%,rgba(0,0,0,.62) 100%)}
#fade{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none}`;
const RGB_FILTER = `<svg width="0" height="0" style="position:absolute"><filter id="rgb" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
<feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/><feOffset in="r" id="rgb-r" result="ro"/>
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="g"/>
<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="b"/><feOffset in="b" id="rgb-b" result="bo"/>
<feBlend mode="screen" in="ro" in2="g" result="rg"/><feBlend mode="screen" in="rg" in2="bo"/></filter></svg>`;

const hash = (n) => { let x = (n * 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; return (x ^ (x >>> 13)) >>> 0; };

/**
 * Mounts overlays into #stage and returns draw(t) for the global effects.
 * wipes: cut times covered by a skewed three-panel wipe; glitches: cut times with an RGB-split jolt;
 * impacts: [t, amp] shake + punch-zoom; flashes: [t, opacity]; fadeOut: [from, to] fade to black.
 */
export function mountFx({ width, height, wipes = [], glitches = [], impacts = [], flashes = [], fadeOut = null }) {
  const stage = $('#stage');
  const style = document.createElement('style'); style.textContent = FX_CSS; document.head.append(style);
  stage.insertAdjacentHTML('beforeend', `${RGB_FILTER}<div id="leak"></div><div id="grade"></div>
    <div id="wipe"><div class="w3"></div><div class="w1"></div><div class="w2"></div></div><div id="flash"></div>
    <canvas id="grain" width="${width + 100}" height="${height + 100}"></canvas><div id="vignette"></div><div id="fade"></div>`);
  const world = $('#world'), wipe = $('#wipe'), panels = [...wipe.children], flash = $('#flash'), leak = $('#leak'), grain = $('#grain'), fade = $('#fade');
  const rgbR = $('#rgb-r'), rgbB = $('#rgb-b');

  const g = grain.getContext('2d'), img = g.createImageData(grain.width, grain.height);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) { const v = rnd() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);

  // Panels wide enough to cover the frame at mid-wipe whatever the aspect ratio.
  const slant = Math.tan((18 * Math.PI) / 180) * height * 1.2;
  const PW = width + slant + 160;
  panels.forEach((p) => { p.style.width = `${PW}px`; });
  const fromX = -PW - slant / 2, toX = width + slant / 2;

  return function drawFx(t) {
    const frame = Math.round(t * FPS);
    let wipeOn = false;
    for (const tb of wipes) {
      const k = prog(t, tb - 0.28, tb + 0.28);
      if (k > 0 && k < 1) {
        wipeOn = true;
        [clamp(k * 1.08), k, clamp(k * 0.94 - 0.02)].forEach((kk, i) => { panels[i].style.left = `${lerp(fromX, toX, eInOut(kk))}px`; });
      }
    }
    wipe.style.display = wipeOn ? 'block' : 'none';

    let fl = 0;
    for (const [ft, a] of flashes) if (t >= ft && t < ft + 0.2) fl = Math.max(fl, a * (1 - (t - ft) / 0.2));
    flash.style.opacity = fl;

    let sx = 0, sy = 0, rot = 0, zoom = 1;
    for (const [it, amp] of impacts) if (t >= it && t < it + 0.6) {
      const d = Math.exp(-(t - it) * 9) * amp;
      sx += Math.sin((t - it) * 83 + it) * d; sy += Math.cos((t - it) * 71 + it * 2) * d * 0.8; rot += Math.sin((t - it) * 57) * d * 0.012;
      zoom += (amp / 26) * 0.045 * Math.exp(-(t - it) * 11);
    }
    let gl = 0;
    for (const gt of glitches) { const d = t - gt; if (d > -0.14 && d < 0.2) gl = Math.max(gl, 1 - Math.abs(d + 0.02) / 0.18); }
    if (gl > 0) {
      const h = hash(frame);
      const off = (4 + (h % 22)) * gl;
      rgbR.setAttribute('dx', off); rgbR.setAttribute('dy', ((h >> 5) % 7) - 3);
      rgbB.setAttribute('dx', -off * 0.8); rgbB.setAttribute('dy', ((h >> 9) % 7) - 3);
      sx += (((h >> 12) % 41) - 20) * gl; sy += (((h >> 18) % 13) - 6) * gl;
    }
    world.style.transform = `translate(${sx}px,${sy}px) rotate(${rot}deg) scale(${zoom})`;
    world.style.filter = gl > 0.05 ? `url(#rgb) contrast(${1 + gl * 0.25}) brightness(${1 + gl * 0.15})` : 'none';

    const lx = 50 + 40 * Math.sin(t * 0.7), ly = 30 + 30 * Math.cos(t * 0.45);
    leak.style.background = `radial-gradient(40% 50% at ${lx}% ${ly}%,rgba(243,106,22,.22),transparent 70%),radial-gradient(30% 40% at ${100 - lx}% ${100 - ly}%,rgba(255,150,60,.10),transparent 70%)`;
    const h = hash(frame + 99);
    grain.style.transform = `translate(${-(h % 50)}px,${-((h >> 8) % 50)}px)`;
    fade.style.opacity = fadeOut ? prog(t, fadeOut[0], fadeOut[1]) : 0;
  };
}

/* ------------------------------------------------------------- boot */
// Exposes __seek/__duration/__fps for render.mjs; ?t=12.5 shows one moment, ?play previews in real time.
export async function boot({ duration, draw }) {
  window.__duration = duration;
  window.__fps = FPS;
  window.__seek = async (t) => { pending = []; draw(t); await Promise.all(pending); await document.fonts.ready; };
  const qs = new URLSearchParams(location.search);
  await document.fonts.ready;
  if (qs.has('play')) {
    const t0 = performance.now();
    const tick = () => { draw(((performance.now() - t0) / 1000) % duration); requestAnimationFrame(tick); };
    tick();
  } else {
    await window.__seek(Number(qs.get('t') || 0));
  }
  window.__ready = true;
}
