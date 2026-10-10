#!/usr/bin/env python3
"""Measured QA for a rendered cut (reads the MP4 like a player would, numpy only).

    python3 marketing/launch-video/qa.py dist/launch-video/asp-launch.mp4 --hits 0.12,2.45,37.3
    python3 marketing/launch-video/qa.py dist/launch-video/asp-launch-reels.mp4 --hits 0.12,2.45,24.95

Reports:
  flashes  max luminance flashes in any 1 s window (WCAG general-flash guidance: no more than 3)
  loudness integrated LUFS and true peak, full mix and phone band (200 Hz–6 kHz; within ~4 dB is healthy)
  hits     audio peak near each cue vs its target, one frame after the picture: (frame + 1) / fps
"""
import argparse
import re
import subprocess

import numpy as np


def probe_fps(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=r_frame_rate',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout.strip()
    n, d = out.split('/')
    return float(n) / float(d)


def flashes(path, fps):
    dims = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height',
                           '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout.strip().split(',')
    w = 96
    h = round(w * int(dims[1]) / int(dims[0]) / 2) * 2
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    px = np.frombuffer(raw, np.uint8)
    lum = px[: len(px) // (w * h) * w * h].reshape(-1, h, w).mean(axis=(1, 2)) / 255
    d = np.diff(lum)
    # A flash: luminance rises >= 10% of full scale, then falls >= 10% within 0.25 s.
    events = []
    for i in np.where(d >= 0.1)[0]:
        if np.any(d[i + 1:i + 1 + int(0.25 * fps)] <= -0.1) and (not events or i - events[-1] > 2):
            events.append(i)
    t = np.array(events) / fps
    worst = max((int(np.sum((t >= s) & (t < s + 1))) for s in t), default=0)
    print(f'flashes: {len(events)} total, max {worst} in any 1 s window ({"OK" if worst <= 3 else "TOO MANY"})')


def loudness(path):
    for name, f in (('full', ''), ('phone band', 'highpass=f=200,lowpass=f=6000,')):
        r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', f'{f}ebur128=peak=true', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
        s = r[r.rindex('Summary'):]
        i = float(re.search(r'I:\s+(-?[\d.]+)', s).group(1))
        tp = float(re.search(r'Peak:\s+(-?[\d.]+)', s).group(1))
        print(f'loudness ({name}): {i} LUFS, {tp} dBTP')


def hits(path, fps, times):
    sr = 48000
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
                         capture_output=True, check=True).stdout
    x = np.abs(np.frombuffer(raw, np.float32))
    print(f"{'cue_s':>7} {'target_ms':>10} {'peak_ms':>9} {'off_ms':>7}")
    for t in times:
        tgt = (round(t * fps) + 1) / fps
        lo, hi = int((tgt - 1.5 / fps) * sr), int((tgt + 3 / fps) * sr)
        pk = (lo + int(np.argmax(x[lo:hi]))) / sr
        off = (pk - tgt) * 1000
        print(f'{t:>7.2f} {tgt * 1000:>10.1f} {pk * 1000:>9.1f} {off:>+7.1f}{"  <-- off" if abs(off) > 1000 / fps else ""}')
    print(f'tolerance ±{1000 / fps:.1f} ms (one frame)')


p = argparse.ArgumentParser()
p.add_argument('video')
p.add_argument('--hits', default='', help='comma-separated cue times in seconds')
a = p.parse_args()
fps = probe_fps(a.video)
flashes(a.video, fps)
loudness(a.video)
if a.hits:
    hits(a.video, fps, [float(v) for v in a.hits.split(',')])
