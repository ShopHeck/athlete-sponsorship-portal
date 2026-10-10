# ASP launch video

Two cuts of the Athlete Sponsorship Portal hype video. All 3D footage is captured from the real portal
(`michael-heckert` plus the demo tenants); none of it is a mock-up.

| Cut | Composition | Size | Length | Output |
| --- | --- | --- | --- | --- |
| Launch (YouTube, site, LinkedIn) | `index.html` | 1920×1080 | 52 s | `dist/launch-video/asp-launch.mp4` |
| Reels / TikTok / Shorts | `reels.html` | 1080×1920 | 34.6 s | `dist/launch-video/asp-launch-reels.mp4` |

## Launch cut (16:9)

| Time | Beat | Footage |
| --- | --- | --- |
| 0.0–3.3 | **Hook:** "+60% more sponsorship revenue" → "He didn't send a pitch deck. He sent this." | Michael's portal intro |
| 3.3–6.6 | Reveal: 360° Athlete Sponsorship Portal · Your kit. Your sponsors. One portal. | intro pull-back |
| 6.6–12.6 | 01 Custom likeness: 12 phone photos scanned into the 3D model | `processed/heckert-*.webp` → 360° spin |
| 12.6–21.6 | 02 Hyper-real mockups: a "YOUR BRAND" logo dropped onto three placements, then Michael's sold-out kit close-ups | logo upload on Jada Monroe demo, placement fly-tos |
| 21.6–25.8 | 03 Bid or Lock It Now: live bids, buyout, Stripe invoice | portal UI |
| 25.8–32.0 | 04 Every fight sport: bare knuckle, boxing, MMA, jiu-jitsu gi, no-gi | demo intros + Michael's victory move |
| 32.0–40.5 | Case study: +60% sponsorship revenue, 12/12 sold, $1,100 avg, $13K+, sold out before fight night | victory move, sponsor wall |
| 40.5–45.8 | Origin: built by a pro fighter to land his own sponsors, now open to every athlete | fight-poster portrait |
| 45.8–52.0 | CTA: Apply for a founding spot · $0 setup · athletes.michaelheckert.com | 360° spin |

## Reels cut (9:16)

The same story, tightened to about 35 seconds. Every cut lands on the 128 BPM grid from the drop at 1.95 s. The
hook reads in the first 100 ms. Sports change every two beats, and the bid scene shows the real mobile portal on a
phone. Text stays inside the platform-safe band (y 250–1480, x 70–1010), clear of the top bar, the caption area
and the action rail.

## Rebuild

1. Capture footage from the running portal. Software WebGL is slow: about 30–60 minutes per format.
   ```sh
   npm run build
   npx netlify dev --offline --port 8890 &
   node marketing/launch-video/capture.mjs                    # 16:9 footage → frames/
   node marketing/launch-video/capture.mjs --format reels     # 9:16 footage → frames/reels/
   ```
   Name shots to capture only some of them, e.g. `capture.mjs heck-intro demo-upload`.
2. Optional: regenerate the soundtracks (numpy only).
   ```sh
   python3 marketing/launch-video/soundtrack.py          # soundtrack.wav
   python3 marketing/launch-video/soundtrack.py reels    # soundtrack-reels.wav
   ```
3. Render.
   ```sh
   node marketing/launch-video/render.mjs                 # asp-launch.mp4
   node marketing/launch-video/render.mjs --format reels  # asp-launch-reels.mp4
   ```
   - `--stills 0.5,9,33.6` writes review PNGs.
   - `--from 12 --to 18` renders a slice.
   - `--no-audio` skips the audio mux.
   - `--lenient` previews layouts while footage is still missing. Without it, a missing frame stops the render.

Needs Playwright (local or global) and `ffmpeg`.

## How it fits together

- `engine.js` is the shared runtime: easing, footage frames, text motion, the global effects and `boot()`. The
  effects are three-panel wipes, RGB-split glitch cuts, shake with punch-zoom, flashes, a split-tone grade, grain
  and a vignette.
- `boot()` exposes `window.__seek(t)`, which draws the exact frame for time `t`. Nothing animates on its own. You
  can open either composition through a static server at the repo root with `?t=12.5` or `?play`.
- `base.css` holds the shared look. Each composition owns its layout, its `SCENES` windows and its cue lists:
  `wipes`, `glitches`, `impacts` and `flashes` in `mountFx`.
- If you move a cue, mirror it in `soundtrack.py` (`FORMATS['wide']` / `reels_cues()`).

## Notes

- The soundtrack is an original synthesized bed. Swap in a licensed track by replacing the `.wav`.
- The +60% revenue figure comes from Michael's campaign. The 12/12, $1,100, $13K+ and 18-brand figures match the
  tenant config and marketing site. The bid amounts are illustrative, and the logo is a placeholder.
