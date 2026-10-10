#!/usr/bin/env python3
"""Original synthesized soundtrack for the launch video (numpy only, no samples, no licensing).

128 BPM A-minor hype bed: cold-open impact + riser, beat drop on "He sent this.", breakdown under the origin story,
re-drop on "Now open to every athlete", and a clean ending under the CTA. Sound effects (whooshes, glitches, impacts,
logo drops, counter ticks, bid chimes, stamp) sit on the exact cue times used by index.html / reels.html.

    python3 marketing/launch-video/soundtrack.py          -> soundtrack.wav        (16:9, index.html)
    python3 marketing/launch-video/soundtrack.py reels    -> soundtrack-reels.wav  (9:16, reels.html)
"""
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 128
BEAT = 60 / BPM


def reels_cues():
    drop, pitch = 2.45, 1.3
    T = lambda n: drop + n * BEAT  # noqa: E731
    ups = [T(16) + (f + 1 - 20) / (30 * 2.1) for f in (42, 108, 172)]
    return dict(
        out='soundtrack-reels.wav', dur=T(68) + 0.77, grid0=drop, brk=(T(52), T(56)), end_beat=66, stutter=pitch + .05,
        wipes=[T(7), T(16), T(23), T(30)], glitches=[pitch, T(40), T(52)],
        impacts=[(0.12, 1.0), (pitch, .45), (drop, 1.0), (T(2), .35), (T(7), .4), (T(11.5), .55), (T(16), .4), (T(23), .4),
                 *[(T(30 + 2 * i), .45) for i in range(5)], (T(40), .45), (T(48), .9), (T(52), .4),
                 (T(56), .9), (T(56.5), .5), (T(57), .7), (T(59), .5)],
        drops=ups, chimes=[(T(24.85), 0), (T(25.85), 0), (T(26.85), 1), (T(28.35), 2)], counters=[(0.0, 0.5), (T(41), T(41) + 1.0)],
        stamp=T(48),
    )


# Cue sheets mirrored from the compositions.
FORMATS = {
    'wide': dict(
        out='soundtrack.wav', dur=52.0, grid0=2.45, brk=(40.5, 2.45 + 88 * BEAT), end_beat=100, stutter=1.39,
        wipes=[6.6, 12.6, 21.6, 25.8], glitches=[1.35, 32.0, 40.5],
        impacts=[(0.12, 1.0), (1.35, .45), (2.45, 1.0), (3.3, .35), (6.6, .4), (9.5, .55), (12.6, .4), (17.4, .35), (21.6, .4),
                 (25.8, .45), (32.0, .45), (37.3, .9), (40.5, .4), (43.7, .9), (43.93, .5), (44.17, .7), (45.8, .6)],
        drops=[13.06, 14.43, 15.77], chimes=[(22.75, 0), (23.3, 0), (23.85, 1), (24.5, 2)],
        counters=[(0.0, 0.5), (32.75, 33.95)], stamp=37.3,
    ),
    'reels': reels_cues(),
}
FMT = sys.argv[1] if len(sys.argv) > 1 else 'wide'
if FMT not in FORMATS:
    sys.exit(f'unknown format {FMT!r}; use one of {", ".join(FORMATS)}')
C = FORMATS[FMT]
DUR = C['dur']
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)
GRID0 = C['grid0']        # beat drop ("He sent this.")
BREAK = C['brk']          # origin breakdown → re-drop
END_BEAT = C['end_beat']  # last downbeat
WIPES, GLITCHES, IMPACTS, DROPS, CHIMES, COUNTERS = (C[k] for k in ('wipes', 'glitches', 'impacts', 'drops', 'chimes', 'counters'))


def t_(n):
    return np.arange(n) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i + len(sig) <= 0:
        return
    if i < 0:
        sig, i = sig[-i:], 0
    sig = sig[: N - i]
    L[i:i + len(sig)] += sig * gain * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * gain * np.sqrt(0.5 * (1 + pan))


def onepole(x, cutoff):
    """Time-varying one-pole low-pass; cutoff may be a scalar or per-sample array (Hz)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def hp(x, cutoff):
    return x - onepole(x, cutoff)


def env(n, attack, decay):
    t = t_(n)
    return np.minimum(1, t / max(attack, 1e-4)) * np.exp(-t / decay)


def note(name):
    names = {'C': -9, 'D': -7, 'E': -5, 'F': -4, 'G': -2, 'A': 0, 'B': 2}
    return 440 * 2 ** ((names[name[0]] + 12 * (int(name[-1]) - 4)) / 12)


def saw(f, n, detune=0.0, phase=0.0):
    ph = (t_(n) * f * (1 + detune) + phase) % 1
    return 2 * ph - 1


# ---------------------------------------------------------------- drums
def kick(n=int(.45 * SR), punch=1.0):
    t = t_(n)
    f = 45 + 110 * np.exp(-t * 38)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5) * .6
    click = rng.standard_normal(n) * np.exp(-t * 400) * .25
    knock = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 32) * .45   # what phone speakers actually reproduce
    return np.tanh((s + click + knock) * 1.8 * punch) * .9


def clap(n=int(.3 * SR)):
    x = rng.standard_normal(n)
    e = np.zeros(n)
    for d in (0, .011, .022):
        i = int(d * SR)
        e[i:] += np.exp(-t_(n - i) * 55) * (0.7 if d else 1)
    e += np.exp(-t_(n) * 14) * .35
    return hp(onepole(x, 4200), 900) * e * 1.1


def hat(n=int(.06 * SR), open_=False):
    n = int(.22 * SR) if open_ else n
    x = hp(rng.standard_normal(n), 7000)
    return x * np.exp(-t_(n) * (14 if open_ else 70)) * .55


def impact(strength=1.0, n=int(2.6 * SR)):
    t = t_(n)
    boom = np.sin(2 * np.pi * np.cumsum(30 + 70 * np.exp(-t * 9)) / SR) * np.exp(-t * 1.6)
    crack = onepole(rng.standard_normal(n), 2500 + 6000 * np.exp(-t * 10)) * np.exp(-t * 5)
    return np.tanh((boom * 1.4 + crack * .9) * 1.5) * strength


def whoosh(dur=.62, peak=.55):
    n = int(dur * SR)
    t = t_(n) / dur
    shape = np.exp(-((t - peak) / .22) ** 2)
    cut = 300 + 7000 * shape
    return hp(onepole(rng.standard_normal(n), cut), 150) * shape * .9


def glitch(dur=.32):
    """Bit-crushed, gated noise-and-tone stutter for the RGB-split cuts."""
    n = int(dur * SR)
    t = t_(n)
    x = rng.standard_normal(n) * .6 + np.sign(np.sin(2 * np.pi * 180 * t)) * .5
    x = np.round(x * 4) / 4                              # crush
    hold = 7
    x = np.repeat(x[::hold], hold)[:n]                   # sample-rate reduce
    gate = (np.floor(t * 34) % 2 == 0).astype(float)     # stutter
    return onepole(x, 3500) * gate * np.exp(-t * 6) * .8


def riser(dur):
    n = int(dur * SR)
    t = t_(n) / dur
    noise = onepole(rng.standard_normal(n), 400 + 9000 * t ** 2) * t ** 2
    tone = np.sin(2 * np.pi * np.cumsum(200 + 900 * t ** 2) / SR) * t ** 3 * .25
    return noise * .8 + tone


def blip(f0, f1, dur=.12):
    n = int(dur * SR)
    t = t_(n)
    f = f1 + (f0 - f1) * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, .002, dur / 3)


def chime(kind):
    n = int(.7 * SR)
    t = t_(n)
    fs = {0: (1318.5, 1975.5), 1: (880, 1318.5, 1760), 2: (1046.5, 1568, 2093)}[kind]
    s = sum(np.sin(2 * np.pi * f * t) * np.exp(-t * (6 + i * 2)) for i, f in enumerate(fs))
    return s * env(n, .003, .25) * .35


# ---------------------------------------------------------------- music bed
def in_break(t):
    return BREAK[0] <= t < BREAK[1]


beats = [GRID0 + k * BEAT for k in range(END_BEAT + 1)]
for k, bt in enumerate(beats):
    if in_break(bt):
        if k % 2 == 0:
            add(onepole(kick(), 600), bt, .55)   # heartbeat under the origin story
        continue
    last = k == END_BEAT
    add(kick(punch=1.2 if k % 16 == 0 else 1.0), bt, .8)
    if last:
        break
    if k % 4 in (1, 3):
        add(clap(), bt, .55, pan=.05)
    add(hat(open_=True), bt + BEAT / 2, .14, pan=.3)
    for s in (0, .25, .75):
        add(hat(), bt + BEAT * s, .11 if s else .07, pan=-.25)
    if k % 16 == 15:                             # hat roll into every 4th bar
        for r in range(8):
            add(hat(), bt + r * BEAT / 8, .08 + r * .015, pan=-.1)

# chords: Am – F – C – G, one bar each
PROG = [('A1', ['A3', 'C4', 'E4']), ('F1', ['F3', 'A3', 'C4']), ('C2', ['G3', 'C4', 'E4']), ('G1', ['G3', 'B3', 'D4'])]
BAR = BEAT * 4
bass = np.zeros(N)
padL = np.zeros(N)
padR = np.zeros(N)
bar = 0
start = GRID0
while start < beats[END_BEAT]:
    root, chord = PROG[bar % 4]
    # bass: eighth-note pulse with sidechain-style ducking
    for e in range(8):
        at = start + e * BEAT / 2
        if at >= beats[END_BEAT]:
            break
        n = int(BEAT / 2 * SR)
        f = note(root) * (2 if e in (3, 7) else 1)
        ph = 2 * np.pi * f * t_(n)
        # Octave-up partial keeps the bass line audible on phones, which reproduce little below ~150 Hz.
        s = np.tanh(np.sin(ph) * 2.2 + .55 * np.sin(2 * ph) + .3 * saw(f, n)) * env(n, .004, .16)
        i = int(at * SR)
        g = .25 if in_break(at) else 1.0
        bass[i:i + n] += s[: N - i] * g
    n = int(BAR * SR)
    i = int(start * SR)
    for nm in chord:
        f = note(nm)
        padL[i:i + n] += (saw(f, n, -.004) + saw(f, n, .003, .3))[: N - i] * .5
        padR[i:i + n] += (saw(f, n, .004, .6) + saw(f, n, -.003, .1))[: N - i] * .5
    start += BAR
    bar += 1

tt = t_(N)
cut = np.full(N, 1800.0)
cut[tt < GRID0] = 500
brk = (tt >= BREAK[0]) & (tt < BREAK[1])
cut[brk] = 500 + 2500 * ((tt[brk] - BREAK[0]) / (BREAK[1] - BREAK[0])) ** 2
padL = onepole(padL, cut)
padR = onepole(padR, cut)
# sidechain pump from the kick grid
duck = np.ones(N)
for bt in beats:
    if in_break(bt):
        continue
    i = int(bt * SR)
    n = min(int(BEAT * SR), N - i)
    duck[i:i + n] = np.minimum(duck[i:i + n], 1 - .6 * np.exp(-t_(n) * 9))
padL *= duck
padR *= duck
bass = onepole(bass * duck, 900)
L += padL * .09 + bass * .3
R += padR * .09 + bass * .3

# cold open: low drone + riser into the drop
n = int(GRID0 * SR)
drone = np.sin(2 * np.pi * 55 * t_(n)) * .35 + onepole(rng.standard_normal(n), 200) * .5
add(drone * np.linspace(.3, 1, n), 0, .35)
SUCK = .08  # risers stop just short of a drop: the gap makes the hit land harder and keeps its peak on the frame
add(riser(GRID0 - .3 - SUCK), .3, .55)
for i in range(6):  # stutter ticks under "He didn't send a pitch deck."
    add(blip(1800, 900, .05), C['stutter'] + i * .13, .25, pan=(-1) ** i * .3)
add(riser(1.4 - SUCK), BREAK[1] - 1.4, .6)

# ---------------------------------------------------------------- sfx
for w in WIPES:
    add(whoosh(), w - .34, .5, pan=-.2)
for g in GLITCHES:
    add(glitch(), g - .08, .55, pan=.15)
for at, s in IMPACTS:
    add(impact(s), at, .32)
for d in DROPS:
    add(blip(220, 70, .25), d, .55)
    add(hat(), d, .4)
    add(chime(0), d + .02, .35)
for at, kind in CHIMES:
    add(chime(kind), at, .9 if kind else .7, pan=.2)
for a, b in COUNTERS:
    t = a
    while t < b:
        add(blip(2600, 2000, .03), t, .12)
        t += .035 + .09 * ((t - a) / (b - a)) ** 2
add(kick(int(.4 * SR), 1.4), C['stamp'], .5)   # stamp: thud + broadband slap, so its peak stays on the frame
add(clap(), C['stamp'], .9)
add(blip(900, 180, .06), C['stamp'], .5)
add(impact(1.0), beats[END_BEAT], .38)                   # final hit

# ---------------------------------------------------------------- reverb + master
def reverb(x, secs=2.2, mix=.18):
    n = int(secs * SR)
    ir = rng.standard_normal(n) * np.exp(-t_(n) * 3.2)
    ir = onepole(ir, 5000)
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    return x + y / np.max(np.abs(y)) * np.max(np.abs(x)) * mix


L, R = reverb(L), reverb(R)
L = hp(L, 25)
R = hp(R, 25)
fade = np.clip((DUR - tt) / 1.2, 0, 1)
mix = np.stack([L, R], 1) * fade[:, None]
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.15) / np.tanh(1.15) * .7
pcm = (mix * 32767).astype('<i2')
out = Path(__file__).with_name(C['out'])
raw = out.with_suffix('.premaster.wav')
with wave.open(str(raw), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())


# ---------------------------------------------------------------- loudness master
# -14 LUFS integrated, true peak under -3 dBTP so the AAC encode stays under -1 dBTP: low shelf so the mix doesn't live in the
# sub (phone speakers drop it), static gain, 4x-oversampled limiter.
def measure(f):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(f), '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True).stderr
    s = r[r.rindex('Summary'):]
    return float(re.search(r'I:\s+(-?[\d.]+)', s).group(1)), float(re.search(r'Peak:\s+(-?[\d.]+)', s).group(1))


TARGET_I, CEIL_TP = -14.0, -3.0  # AAC lifted this mix's peaks by up to 1.8 dB
i0, tp0 = measure(raw)
gain = TARGET_I - i0 + 2  # the -6 dB low shelf (sub is what phones drop anyway) costs ~2 dB of loudness
for _ in range(3):  # limiting costs loudness; re-aim
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-af',
                    f'bass=g=-6:f=110:w=0.7,volume={gain:.2f}dB,aresample={SR * 4},alimiter=limit={10 ** ((CEIL_TP - 0.5) / 20):.4f}:attack=1:release=60:level=0,aresample={SR}',
                    '-c:a', 'pcm_s16le', str(out)], check=True)
    i1, tp1 = measure(out)
    if abs(i1 - TARGET_I) < 0.3:
        break
    gain += TARGET_I - i1
pre = out.with_suffix('.prelimit.wav')  # same chain without the limiter, to report how hard it worked
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-af', f'bass=g=-6:f=110:w=0.7,volume={gain:.2f}dB', '-c:a', 'pcm_f32le', str(pre)], check=True)
tp_pre = measure(pre)[1]
raw.unlink()
pre.unlink()
print(f'wrote {out}: {i1} LUFS, {tp1} dBTP (limiter took {max(0, tp_pre - tp1):.1f} dB off the loudest peak)')
