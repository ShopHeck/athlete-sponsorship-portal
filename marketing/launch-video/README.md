# ASP launch video

52-second 1920×1080 hype video for the Athlete Sponsorship Portal. All 3D footage is captured from the real
portal (`michael-heckert` plus the demo tenants); none of it is a mock-up.

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

## Rebuild

1. Capture the footage from the running portal. This takes about 30–60 minutes with software WebGL.
   ```sh
   npm run build
   npx netlify dev --offline --port 8890 &
   node marketing/launch-video/capture.mjs          # or name shots: heck-intro demo-upload ...
   ```
2. Optional: regenerate the soundtrack (numpy only): `python3 marketing/launch-video/soundtrack.py`
3. Render: `node marketing/launch-video/render.mjs` → `dist/launch-video/asp-launch.mp4`
   - `--stills 0.5,9,33.6` writes review PNGs; `--from 12 --to 18` renders a slice; `--no-audio` skips the mux.

Needs Playwright (local or global) and `ffmpeg`. `index.html` is a seekable composition: `window.__seek(t)` draws
the frame for time `t`. You can also open it through any static server at the repo root with `?t=12.5` or `?play`.

## Editing

- Copy, timings and effects live in `index.html`. Scene windows are in `SCENES`, transitions in `WIPES`, and
  screen shake and flashes in `IMPACTS` and `FLASHES`.
- If you move a cue, mirror it in `soundtrack.py` (`WIPES`, `IMPACTS`, `DROPS`, `CHIMES`, `COUNTERS`). The music
  runs at 128 BPM from the 2.45 s drop.
- The soundtrack is an original synthesized bed. Swap in a licensed track by replacing `soundtrack.wav`.
- The +60% revenue figure comes from Michael's campaign. The 12/12, $1,100, $13K+ and 18-brand figures match the
  tenant config and marketing site. The bid amounts in scene 03 are illustrative, and the logo is a placeholder.
