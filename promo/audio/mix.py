"""按画面事件配音效，剪好音乐，混出成片的声音。

  python3 audio/mix.py --events out/x.events.json --dur 19 --out out/x

出三个文件：<out>.sfx.wav（音效）、<out>.music.wav（剪好、压在旁白下的音乐）、<out>.mix.wav（两者混好）。
旁白由用户自己配，音乐按 script/narration.json 的时间预先让出位置（压低 8 dB）。
"""
import argparse, json, subprocess, os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

ap = argparse.ArgumentParser()
ap.add_argument('--events', required=True)
ap.add_argument('--dur', type=float, required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--music', default=os.path.join(HERE, 'music', 'Inspired.mp3'))
ap.add_argument('--music-lag', type=float, default=0.11, help='音乐比画面晚开始多少秒（让小节线落在 12.05 秒）')
ap.add_argument('--from', dest='start', type=float, default=0)
a = ap.parse_args()

N = int(a.dur * SR)
rng = np.random.default_rng(7)
events = json.load(open(a.events))
narr = json.load(open(os.path.join(ROOT, 'script', 'narration.json')))['lines']


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], 'bandpass', fs=SR, output='sos'), x)


def lp(x, f, order=2):
    return sosfilt(butter(order, f, 'lowpass', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'highpass', fs=SR, output='sos'), x)


def env(n, attack, release):
    e = np.ones(n)
    na, nr = min(n, int(attack * SR)), min(n, int(release * SR))
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e


sfx = np.zeros((N, 2))


def place(sig, t, gain=1.0, pan=0.0):
    i = int((t - a.start) * SR)
    if sig.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * l * 1.414, sig * r * 1.414], 1)
    j0, j1 = max(0, i), min(N, i + len(sig))
    if j1 > j0:
        sfx[j0:j1] += sig[j0 - i:j1 - i] * gain


# ---------- 粉笔 ----------
def chalk(dur, length):
    n = max(int(dur * SR), 200)
    noise = rng.standard_normal(n)
    body = bp(noise, 1600, 7000)
    # 粉笔在板面上一顿一顿的摩擦
    rough = np.abs(lp(rng.standard_normal(n), 70)) ; rough /= rough.max() + 1e-9
    s = body * (0.35 + 0.65 * rough)
    # 少数笔画带一点吱声
    if rng.random() < 0.3:
        tt = np.arange(n) / SR
        f = rng.uniform(2300, 3400)
        s += 0.06 * np.sin(2 * np.pi * (f * tt + 8 * np.sin(2 * np.pi * 7 * tt))) * env(n, 0.02, 0.03)
    speed = length / max(dur, 1e-3)
    g = 0.05 * np.clip(speed / 2500, 0.5, 1.3)
    tap = np.zeros(n)
    k = min(n, int(0.004 * SR))
    tap[:k] = rng.standard_normal(k) * np.linspace(1, 0, k) * 0.5
    return (s * env(n, 0.006, 0.025) + lp(tap, 4000)) * g


def erase(dur, sweeps=6):
    n = int(dur * SR)
    tt = np.linspace(0, 1, n)
    s = bp(rng.standard_normal(n), 250, 3200)
    am = np.abs(np.sin(np.pi * sweeps * tt)) ** 0.6
    return s * am * env(n, 0.03, 0.08) * 0.09


def square(freqs, durs, vol=0.08):
    out = []
    for f0, f1, d in zip(freqs[::2], freqs[1::2], durs):
        n = int(d * SR)
        f = np.linspace(f0, f1, n)
        ph = np.cumsum(f) / SR
        w = np.sign(np.sin(2 * np.pi * ph)) * 0.6 + np.sin(2 * np.pi * ph) * 0.4
        out.append(w * env(n, 0.004, d * 0.5))
    return lp(np.concatenate(out), 5000) * vol


def thump(f=90, d=0.18, vol=0.25):
    n = int(d * SR)
    tt = np.arange(n) / SR
    return np.sin(2 * np.pi * f * tt * (1 - 0.3 * tt / d)) * np.exp(-tt * 22) * vol


def whoosh(dur, vol=0.08):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    blk = 1024
    for i in range(0, n, blk):
        k = i / n
        c = 300 + 2600 * np.sin(np.pi * k) ** 2
        seg = noise[max(0, i - 2048):i + blk]
        y = bp(seg, c * 0.6, min(c * 1.6, 20000))
        out[i:i + blk] = y[-len(noise[i:i + blk]):]
    return out * np.sin(np.pi * np.linspace(0, 1, n)) ** 1.5 * vol


def riser(dur, vol=0.07):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    blk = 1024
    for i in range(0, n, blk):
        k = i / n
        c = 400 * (16 ** k)
        seg = noise[max(0, i - 2048):i + blk]
        y = bp(seg, c * 0.7, min(c * 1.4, 20000))
        out[i:i + blk] = y[-len(noise[i:i + blk]):]
    return out * np.linspace(0, 1, n) ** 2.2 * vol


def hit(vol=0.11):
    n = int(1.2 * SR)
    tt = np.arange(n) / SR
    boom = np.sin(2 * np.pi * 52 * tt) * np.exp(-tt * 4.5)
    click = lp(rng.standard_normal(n), 2500) * np.exp(-tt * 60) * 0.5
    return (boom + click) * vol


for e in events:
    t, ty = e['t'], e['type']
    if ty == 'chalk':
        place(chalk(e['dur'], e['len']), t, pan=rng.uniform(-0.25, 0.25))
    elif ty == 'erase':
        place(erase(e['dur'], 6), t)
    elif ty == 'pop':
        place(square([260, 880], [0.12], 0.07), t + 0.05, pan=0.4)
    elif ty == 'chirp':
        place(square([1318, 1318, 1568, 1568], [0.07, 0.1], 0.05), t, pan=0.4)
    elif ty == 'jump':
        place(square([220, 900], [0.2], 0.06), t, pan=0.3)
    elif ty == 'land':
        place(thump(110, 0.16, 0.18), t)
        place(square([660, 520], [0.06], 0.04), t, pan=0.1)
    elif ty == 'whoosh':
        place(whoosh(e['dur'] + 0.3), t - 0.1)
    elif ty == 'riser':
        place(riser(e['dur']), t)
    elif ty == 'hit':
        place(hit(), t)

# 一点房间混响，让声音落在同一个空间里。
ir_n = int(0.7 * SR)
ir = rng.standard_normal((ir_n, 2)) * np.exp(-np.arange(ir_n) / SR * 7)[:, None]
ir[:, 0] = lp(ir[:, 0], 6000); ir[:, 1] = lp(ir[:, 1], 6000)
wet = np.stack([fftconvolve(sfx[:, c], ir[:, c])[:N] for c in range(2)], 1)
sfx = sfx + wet * 0.05

# ---------- 音乐 ----------
raw = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', a.music, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
m = np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)
music = np.zeros((N, 2))
off = int((a.music_lag - a.start) * SR)  # 画面 t 对应音乐 t - lag
if off >= 0:
    seg = m[:N - off]
    music[off:off + len(seg)] = seg
else:
    seg = m[-off:-off + N]
    music[:len(seg)] = seg

t = a.start + np.arange(N) / SR
# 开场：闷在低通里，CoursePilot 落笔那一下打开。
OPEN0, OPEN1 = 11.8, 12.1
closed = np.stack([lp(music[:, c], 520, 2) for c in range(2)], 1)
k = np.clip((t - OPEN0) / (OPEN1 - OPEN0), 0, 1)[:, None]
music = closed * (1 - k) + music * k
gain = np.interp(t, [0, 1.5, 11.8, 12.1], [0.0, 0.55, 0.75, 1.0])
# 旁白的位置压低 8 dB（旁白前 0.25 秒开始让）。
duck = np.ones(N)
for l in narr:
    duck = np.minimum(duck, np.interp(t, [l['start'] - 0.25, l['start'], l['end'], l['end'] + 0.4], [1, 0.4, 0.4, 1], left=1, right=1))
music *= (gain * duck)[:, None] * 0.55
# 结尾淡出
fade = np.clip((a.start + a.dur - t) / 1.2, 0, 1)
music *= fade[:, None]
sfx *= fade[:, None] ** 0.3

mix = music + sfx
peak = np.abs(mix).max()
if peak > 0.98:
    mix *= 0.98 / peak


def write(path, x):
    x = np.clip(x, -1, 1)
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', path], stdin=subprocess.PIPE)
    p.communicate(x.astype(np.float32).tobytes())


write(a.out + '.sfx.wav', sfx)
write(a.out + '.music.wav', music)
write(a.out + '.mix.wav', mix)
print('ok', a.out)
