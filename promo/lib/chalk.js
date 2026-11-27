// 粉笔字：按真实笔顺一笔一笔写出来。
// 汉字：Make Me a Hanzi 的笔画轮廓 + 中线（hanzi-writer-data），中线描出来、轮廓裁边。
// 西文：EMS / Hershey 单线字体，本身就是笔走的路径。
import { clamp, lerp, rng, polyLength, pointAt, cue } from './core.js';

const hanziCache = new Map();
export async function loadHanzi(chars) {
  const need = [...new Set(chars)].filter((c) => /\p{Script=Han}/u.test(c) && !hanziCache.has(c));
  await Promise.all(
    need.map(async (c) => {
      const r = await fetch(`node_modules/hanzi-writer-data/${encodeURIComponent(c)}.json`);
      if (!r.ok) throw new Error(`缺笔画数据：${c}`);
      hanziCache.set(c, await r.json());
    }),
  );
}

const fontCache = new Map();
export async function loadLineFont(name) {
  if (fontCache.has(name)) return fontCache.get(name);
  const txt = await (await fetch(`node_modules/hersheytext/svg_fonts/${name}.svg`)).text();
  const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
  const font = doc.querySelector('font');
  const face = doc.querySelector('font-face');
  const glyphs = new Map();
  for (const g of doc.querySelectorAll('glyph')) {
    const u = g.getAttribute('unicode');
    if (!u) continue;
    const strokes = [];
    const d = g.getAttribute('d') || '';
    for (const part of d.split('M').map((s) => s.trim()).filter(Boolean)) {
      const nums = part.replace(/L/g, ' ').trim().split(/\s+/).map(Number);
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      if (pts.length > 1) strokes.push(pts);
    }
    glyphs.set(u, { adv: +(g.getAttribute('horiz-adv-x') || font.getAttribute('horiz-adv-x')), strokes });
  }
  const f = { glyphs, upm: +(face.getAttribute('units-per-em') || 1000), def: +font.getAttribute('horiz-adv-x') };
  fontCache.set(name, f);
  return f;
}

/** 粉笔颗粒：一张和画布一样大的透明度噪声，最后用 destination-in 盖一次。 */
export function grainCanvas(w, h, seed = 11) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  // 大块的疏密（有的地方粉多、有的地方粉少）
  const lw = Math.ceil(w / 24), lh = Math.ceil(h / 24);
  const low = document.createElement('canvas');
  low.width = lw;
  low.height = lh;
  const lx = low.getContext('2d');
  const li = lx.createImageData(lw, lh);
  const r = rng(seed);
  for (let i = 0; i < lw * lh; i++) li.data[i * 4 + 3] = 255 * r();
  lx.putImageData(li, 0, 0);
  x.imageSmoothingEnabled = true;
  x.drawImage(low, 0, 0, w, h);
  const lowData = x.getImageData(0, 0, w, h).data;
  const img = x.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = r();
    const l = lowData[i * 4 + 3] / 255;
    const a = Math.min(1, Math.max(0, 0.18 + 1.05 * n + 0.45 * (l - 0.5)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255 * a;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/**
 * 一块板面上的一串笔画。add* 只排时间；update(t) 求笔尖，draw(ctx, t) 画到画布上。
 * 每一笔：{ t0, t1, pts(板面坐标的中线), len, width, clip(Path2D | null) }
 */
export class ChalkWriter {
  constructor({ color = '#eef2ec', seed = 1 } = {}) {
    this.color = color;
    this.strokes = [];
    this.rand = rng(seed);
  }

  _push(pts, { width, clip, t0, speed, overhead, opacity, color }) {
    const len = polyLength(pts);
    const dur = overhead + len / speed;
    const path = new Path2D();
    pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    const s = { t0, t1: t0 + dur, pts, len, width, clip: clip || null, path, color: color || this.color, opacity: opacity ?? lerp(0.82, 0.97, this.rand()) };
    this.strokes.push(s);
    cue(t0, 'chalk', { dur: +dur.toFixed(3), len: Math.round(len) });
    return s;
  }

  /** 汉字一串。dir: 'h' 横排 / 'v' 竖排。返回写完的时间和每个字的框。 */
  addHan(text, { x, y, size, gap = 1.08, dir = 'h', t0, speed = 2300, strokeGap = 0.035, charGap = 0.1, overhead = 0.045 }) {
    const s = size / 1024;
    let t = t0;
    const boxes = [];
    [...text].forEach((ch, i) => {
      const cx = dir === 'h' ? x + i * size * gap : x;
      const cy = dir === 'h' ? y : y + i * size * gap;
      boxes.push({ ch, x: cx, y: cy, size, t0: t });
      const data = hanziCache.get(ch);
      if (!data) return;
      const m = new DOMMatrix([s, 0, 0, -s, cx, cy + 900 * s]);
      data.strokes.forEach((outline, k) => {
        const clip = new Path2D();
        clip.addPath(new Path2D(outline), m);
        const pts = data.medians[k].map(([mx, my]) => ({ x: cx + mx * s, y: cy + (900 - my) * s }));
        const st = this._push(pts, { width: 190 * s, clip, t0: t, speed, overhead });
        t = st.t1 + strokeGap;
      });
      boxes[i].t1 = t;
      t += charGap;
    });
    return { t1: t - charGap, boxes };
  }

  /** 西文单线字。size 是 em 大小（板面像素）；x 为左端、y 为基线。 */
  addLine(text, font, { x, y, size, t0, width = 8, speed = 1500, strokeGap = 0.01, charGap = 0.02, overhead = 0.02, tracking = 0 }) {
    const s = size / font.upm;
    let cx = x;
    let t = t0;
    for (const ch of text) {
      const g = font.glyphs.get(ch);
      if (!g) {
        cx += font.def * s;
        continue;
      }
      for (const st of g.strokes) {
        const pts = st.map((p) => ({ x: cx + p.x * s, y: y - p.y * s }));
        const r = this._push(pts, { width, t0: t, speed, overhead });
        t = r.t1 + strokeGap;
      }
      cx += g.adv * s + tracking;
      t += charGap;
    }
    return { t1: t, width: cx - x };
  }

  static measureLine(text, font, size, tracking = 0) {
    const s = size / font.upm;
    let w = 0;
    for (const ch of text) w += (font.glyphs.get(ch)?.adv ?? font.def) * s + tracking;
    return w;
  }

  /** 手画的圈：比椭圆多绕一点、首尾不闭合，像随手一圈。 */
  addLoop({ cx, cy, rx, ry, t0, dur = 0.45, width = 7, turns = 1.12, start = -2.2, seed = 3 }) {
    const r = rng(seed);
    const pts = [];
    const n = 80;
    const wob = [r(), r(), r()];
    for (let i = 0; i <= n; i++) {
      const a = start + (i / n) * turns * Math.PI * 2;
      const k = 1 + 0.05 * Math.sin(a * 2 + wob[0] * 6) + 0.03 * Math.sin(a * 3 + wob[1] * 6) + (i / n) * 0.06;
      pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k + (i / n) * ry * 0.08 });
    }
    const len = polyLength(pts);
    return this._push(pts, { width, t0, speed: len / dur, overhead: 0, opacity: 0.92 });
  }

  /** 一道粉笔线（下划线、箭头杆）。 */
  addStroke(pts, { t0, dur, width = 7, color }) {
    const len = polyLength(pts);
    return this._push(pts, { width, t0, speed: len / dur, overhead: 0, opacity: 0.92, color });
  }

  get t1() {
    return this.strokes.reduce((m, s) => Math.max(m, s.t1), 0);
  }

  /** 笔尖在 t 时的状态，粉笔头和粉尘跟着它走。 */
  update(t) {
    let pen = null;
    for (let i = 0; i < this.strokes.length; i++) {
      const s = this.strokes[i];
      if (t >= s.t0 && t <= s.t1) pen = { ...pointAt(s.pts, (t - s.t0) / (s.t1 - s.t0)), down: true, i };
      else if (!pen && t > s.t1 && this.strokes[i + 1] && t < this.strokes[i + 1].t0) {
        // 两笔之间：笔抬起来，从这一笔的末尾飘到下一笔的起点。
        const n = this.strokes[i + 1];
        const k = (t - s.t1) / (n.t0 - s.t1);
        const a = s.pts[s.pts.length - 1];
        const b = n.pts[0];
        pen = { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), down: false, lift: Math.sin(Math.PI * k), i };
      }
    }
    return pen;
  }

  draw(ctx, t) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) {
      if (t <= s.t0) continue;
      const p = clamp((t - s.t0) / (s.t1 - s.t0));
      ctx.save();
      if (s.clip) ctx.clip(s.clip);
      ctx.globalAlpha = s.opacity;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      if (p < 1) ctx.setLineDash([Math.max(0.01, p * s.len), s.len + 1000]);
      ctx.stroke(s.path);
      ctx.restore();
    }
  }
}

/** 粉尘：笔尖每走一段掉几粒，落下、变淡。全部由时间算出。 */
export class Dust {
  constructor(seed = 7) {
    this.parts = [];
    this.rand = rng(seed);
  }
  /** 沿着写字器的每一笔，预先撒好粉尘。 */
  fromWriter(w, { rate = 26, spread = 1 } = {}) {
    for (const s of w.strokes) {
      const n = Math.max(1, Math.round((s.t1 - s.t0) * rate));
      for (let i = 0; i < n; i++) {
        const k = this.rand();
        const p = pointAt(s.pts, k);
        this.add(s.t0 + (s.t1 - s.t0) * k, p.x, p.y, spread);
      }
    }
  }
  add(t, x, y, spread = 1, big = 1) {
    const r = this.rand;
    this.parts.push({
      t,
      x,
      y,
      vx: (r() - 0.5) * 60 * spread,
      vy: (r() * 30 - 10) * spread,
      size: (0.8 + r() * 2.2) * big,
      life: 0.6 + r() * 1.1,
      a: 0.35 + r() * 0.5,
    });
  }
  /** 板擦扬起的一团。 */
  burst(t, x, y, n = 40, spread = 2.5) {
    for (let i = 0; i < n; i++) this.add(t + this.rand() * 0.15, x + (this.rand() - 0.5) * 120, y + (this.rand() - 0.5) * 60, spread, 1.4);
  }
  draw(ctx, t) {
    ctx.fillStyle = '#eef2ec';
    for (const p of this.parts) {
      const dt = t - p.t;
      if (dt < 0 || dt > p.life) continue;
      const x = p.x + p.vx * dt;
      const y = p.y + p.vy * dt + 0.5 * 220 * dt * dt;
      ctx.globalAlpha = p.a * (1 - dt / p.life);
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
