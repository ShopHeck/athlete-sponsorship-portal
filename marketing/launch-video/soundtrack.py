#!/usr/bin/env python3
"""Original synthesized soundtrack for the launch video (numpy only, no samples, no licensing).

128 BPM A-minor hype bed: cold-open impact + riser, beat drop on "He sent this.", breakdown under the origin story,
re-drop on "Now open to every athlete", and a clean ending under the CTA. Sound effects (whooshes, impacts, logo
drops, counter ticks, bid chimes, stamp) are placed on the exact cue times used by index.html.

    python3 marketing/launch-video/soundtrack.py   -> marketing/launch-video/soundtrack.wav
"""
import wave
from pathlib import Path

import numpy as np

SR = 44100
DUR = 52.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)

BPM = 128
BEAT = 60 / BPM
GRID0 = 2.45                      # beat drop ("He sent this.")
BREAK = (40.5, GRID0 + 88 * BEAT)  # origin breakdown → re-drop at 43.70
END_BEAT = 100                     # last downbeat (≈49.33s)

# Cue times mirrored from index.html
WIPES = [1.62, 6.6, 12.6, 21.6, 25.8, 32.0, 40.5, 45.8]
IMPACTS = [(0.12, 1.0), (2.45, 1.0), (3.3, .35), (6.6, .4), (9.5, .55), (12.6, .4), (17.4, .35), (21.6, .4),
           (25.8, .45), (32.0, .45), (37.3, .9), (40.5, .4), (43.7, .9), (43.93, .5), (44.17, .7), (45.8, .5)]
DROPS = [13.06, 14.43, 15.77]                 # logo lands on the kit
CHIMES = [(22.75, 0), (23.3, 0), (23.85, 1), (24.5, 2)]
COUNTERS = [(0.12, 0.62), (32.75, 33.95)]


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
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    click = rng.standard_normal(n) * np.exp(-t * 400) * .25
    return np.tanh((s + click) * 1.8 * punch) * .9


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
    add(kick(punch=1.2 if k % 16 == 0 else 1.0), bt, .95)
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
        s = np.tanh(np.sin(2 * np.pi * f * t_(n)) * 2.2 + .3 * saw(f, n)) * env(n, .004, .16)
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
add(riser(GRID0 - .3), .3, .55)
for i in range(6):  # stutter ticks under "He didn't send a pitch deck."
    add(blip(1800, 900, .05), 1.66 + i * .13, .25, pan=(-1) ** i * .3)
add(riser(BREAK[1] - 42.3), 42.3, .6)

# ---------------------------------------------------------------- sfx
for w in WIPES:
    add(whoosh(), w - .34, .5, pan=-.2)
for at, s in IMPACTS:
    add(impact(s), at, .75)
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
add(onepole(kick(int(.8 * SR), 1.6), 300), 37.3, .9)   # stamp thud
add(impact(1.0), beats[END_BEAT], .8)                   # final hit

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
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.15) / np.tanh(1.15) * .89
pcm = (mix * 32767).astype('<i2')
out = Path(__file__).with_name('soundtrack.wav')
with wave.open(str(out), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('wrote', out)
