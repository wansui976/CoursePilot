// 场景工具：每个场景是世界里的一个容器（中心 cx, cy，缩放 s），里面按「一屏像素」排版。
// 镜头对准某个场景的局部坐标 (lx, ly)、局部缩放 lz，就能换算成世界坐标。
import { clamp, lerp, ease, el } from './core.js';

export class Scene {
  constructor(parent, { cx, cy, s, W, H, name }) {
    Object.assign(this, { cx, cy, s, W, H, name });
    this.el = el('div', { class: 'scene', 'data-scene': name, style: {
      position: 'absolute', left: '0px', top: '0px', width: W + 'px', height: H + 'px',
      transformOrigin: '0 0',
      transform: `translate(${cx - (W / 2) * s}px, ${cy - (H / 2) * s}px) scale(${s})`,
    } }, parent);
    this.t0 = -Infinity;
    this.t1 = Infinity;
  }
  /** 局部（左上角为 0,0 的一屏像素）→ 世界 */
  w(lx, ly) {
    return { x: this.cx + (lx - this.W / 2) * this.s, y: this.cy + (ly - this.H / 2) * this.s };
  }
  /** 世界 → 局部 */
  l(x, y) {
    return { x: (x - this.cx) / this.s + this.W / 2, y: (y - this.cy) / this.s + this.H / 2 };
  }
  /** 镜头对准局部点，局部缩放 lz（1 = 这个场景正好一屏） */
  cam(lx = this.W / 2, ly = this.H / 2, lz = 1, r = 0) {
    const p = this.w(lx, ly);
    return { x: p.x, y: p.y, z: lz / this.s, r };
  }
  live(t0, t1) {
    this.t0 = t0;
    this.t1 = t1;
    return this;
  }
  show(t) {
    const on = t >= this.t0 && t <= this.t1;
    this.el.style.display = on ? '' : 'none';
    return on;
  }
}

/** 分段关键帧：keys = [[t, v], ...]，v 可以是数字或 {x, y, ...}。fn 为每段缓动。 */
export function kf(t, keys, fn = ease.inOut) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [ta, va] = keys[i - 1];
    const [tb, vb, eb] = keys[i];
    if (t <= tb) {
      const k = (eb || fn)(clamp((t - ta) / (tb - ta)));
      if (typeof va === 'number') return lerp(va, vb, k);
      const o = {};
      for (const key of Object.keys(va)) o[key] = typeof va[key] === 'number' ? lerp(va[key], vb[key], k) : vb[key];
      return o;
    }
  }
  return keys[keys.length - 1][1];
}

/** 设置一个元素的位置、缩放、旋转、透明度（transform-origin 默认中心）。 */
export function tf(node, { x = 0, y = 0, s = 1, sx, sy, r = 0, rx = 0, ry = 0, z = 0, o, persp } = {}) {
  node.style.transform = `${persp ? `perspective(${persp}px) ` : ''}translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotate(${r}deg) scale(${sx ?? s}, ${sy ?? s})`;
  if (o !== undefined) {
    node.style.opacity = o;
    node.style.visibility = o <= 0.001 ? 'hidden' : '';
  }
}

/** 绝对定位的盒子：局部像素。 */
export function box(parent, { x, y, w, h, cls = '', style = {}, text, html, tag = 'div' }) {
  return el(tag, { class: cls, style: { position: 'absolute', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', ...style }, ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}) }, parent);
}

/** 进入 / 退出：0..1 弹簧式出现。 */
export function pop(t, t0, dur = 0.5) {
  if (t <= t0) return 0;
  const k = (t - t0) / dur;
  return k >= 1.6 ? 1 : 1 - Math.exp(-6 * k) * Math.cos(9 * k);
}

/** 打字机：t0 起每秒 cps 个字。 */
export function typed(text, t, t0, cps = 14) {
  const n = Math.max(0, Math.floor((t - t0) * cps));
  return [...text].slice(0, n).join('');
}

/** 镜头关键帧插值：缩放走对数，位置跟着缩放走（推拉时主体稳）。 */
export function camLerp(a, b, k) {
  const z = Math.exp(lerp(Math.log(a.z), Math.log(b.z), k));
  // 位置按「屏幕上的移动」插值：用 1/z 加权，避免大幅拉远时画面先甩开再回来。
  const wa = 1 / a.z, wb = 1 / b.z, wz = 1 / z;
  const kk = Math.abs(wb - wa) < 1e-6 ? k : (wz - wa) / (wb - wa);
  const kp = Math.abs(Math.log(b.z / a.z)) > 0.4 ? clamp(kk) : k;
  return { x: lerp(a.x, b.x, kp), y: lerp(a.y, b.y, kp), z, r: lerp(a.r || 0, b.r || 0, k) };
}
