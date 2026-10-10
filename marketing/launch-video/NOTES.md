# QA notes

All measurements come from the rendered MP4s, via `python3 marketing/launch-video/qa.py <mp4> --hits …`, which
decodes them the way a player would. Re-run it after any change to cues or the mix.

## Spec

- **Goal:** athletes stop scrolling on the +60% hook and leave knowing three things: the portal shows their own
  3D likeness, sponsors see real logo mockups on the kit, and it works for every fight sport.
- **16:9:** 1920×1080, 30 fps, 52 s (1560 frames).
- **9:16:** 1080×1920, 30 fps, 35.1 s (1053 frames). Every cut is on the 128 BPM grid from the 2.45 s drop
  (`T(n) = 2.45 + n·60/128`).
- **Look:** #0b0a09 ground, one accent #f36a16, ink #f4efe6. Barlow Condensed 900 italic for display, Inter 500
  for body. Warm/cool split-tone grade, grain at 11%.
- **Motion:** expo-out entrances; line reveals staggered 100–160 ms. Three cut vocabularies: skewed
  three-panel wipes into each numbered feature, RGB-split glitch cuts for story turns, and flash + punch-zoom on
  impacts.

## Round notes (polish pass)

| # | Note | Fix |
|---|---|---|
| 1 | The hook's +60% only became legible at ~0.35 s. | The slam starts at frame 0 and lands by frame 3; the count reaches 60 by 0.5 s. |
| 2 | "He didn't send a pitch deck." was on screen 0.83 s (16:9) and 0.9 s (reels). Five words need ~2 s; 1.1–1.15 s is the most the hook allows. | 16:9 turn moved to 1.35 s. Reels drop moved to 2.45 s, with the turn at 1.3 s. |
| 3 | All 8 transitions used the same wipe. | Wipes only into features 01–04; glitch cuts on the pitch turn, case study and origin; flash + punch-zoom into the CTA. |
| 4 | Text over footage lost contrast in bright frames. | 42 px soft shadow on display type; kicker rule accents; brand bug from the reveal to the origin. |
| 5 | 16:9 bid UI zoom covered the headline. | Headline steps aside as the camera pushes in. |
| 6 | Reels: the likeness headline wrapped word-by-word, and "360°" sat on Michael's face. | Gave the container a width; moved 360° into the lower stack. |
| 7 | Old master measured +0.3 dBTP after AAC (clipping), with the phone band 6.9 dB under the full mix. | 190 Hz knock on the kick, octave partial on the bass, −6 dB low shelf, master to −14 LUFS / −3 dBTP before AAC. |
| 8 | The drop peaked 45 ms early (the riser crested into it), and the reels stamp peaked 82 ms late (low-passed thud). | 80 ms suck-out before drops; un-filtered thud plus a broadband slap on the stamp; audio delayed 1 frame at mux. |

## Final measurements

| | 16:9 | 9:16 |
|---|---|---|
| Flashes (max in any 1 s, limit 3) | 1 | 1 |
| Loudness, full mix | −14.2 LUFS, −2.2 dBTP | −14.2 LUFS, −1.5 dBTP |
| Phone band (200 Hz–6 kHz) | −17.5 LUFS (3.3 dB under full) | −17.6 LUFS (3.4 dB under full) |
| Hits within one frame of (F+1)/fps | 7/7, worst −26.5 ms | 6/6, worst −24.8 ms |

## Known deviations

- **The limiter works hard:** about 6.5 dB on the beat and 9 dB on the single stamp transient, against a
  1.5 dB guideline. The cause is the beat's crest across the whole track, not stacked hits. The limiter looks
  ahead, and every measured hit still lands within a frame. For a gentler master, lower `TARGET_I` to −16.
- **Some copy still holds briefly.** The +60% sub-line and the reels sports labels run under the
  0.3 s/word + 0.5 s guideline. They are one to three words over moving footage, by design.
