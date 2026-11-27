// 时间轴的基础件：画面只由时间 t 决定，不读系统时钟，任意一帧都能单独渲染出来。

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
/** t 落在 [a, b] 里的进度，0..1。 */
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const mix2 = (p, q, t) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  inOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  // 镜头用：起步慢、收尾长，像人推轨道。
  camera: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
};

/** 弹簧阶跃响应：t 秒后从 0 走到 1（会过冲）。freq 每秒振荡次数，damp 阻尼比。 */
export function spring(t, freq = 2.2, damp = 0.42) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + ((damp * w) / wd) * Math.sin(wd * t));
}

/** 冲击后的衰减抖动：t 秒前发生的一下，返回 -1..1。 */
export function wobble(t, freq = 7, decay = 6) {
  if (t <= 0) return 0;
  return Math.sin(2 * Math.PI * freq * t) * Math.exp(-decay * t);
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平滑的伪噪声（几条正弦叠起来），手持镜头的晃动用。 */
export function noise1(t, seed = 0) {
  const s = seed * 12.9898;
  return (
    Math.sin(t * 0.73 + s) * 0.5 +
    Math.sin(t * 1.37 + s * 1.7) * 0.3 +
    Math.sin(t * 2.91 + s * 2.3) * 0.2
  );
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}
export function el(tag, attrs = {}, parent) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
}

/** 折线的总长和按长度取点。 */
export function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}
export function pointAt(pts, frac) {
  const total = polyLength(pts);
  let want = clamp(frac) * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (want <= seg || i === pts.length - 1) {
      const k = seg ? clamp(want / seg) : 0;
      return { x: lerp(pts[i - 1].x, pts[i].x, k), y: lerp(pts[i - 1].y, pts[i].y, k), dir: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) };
    }
    want -= seg;
  }
  return { ...pts[pts.length - 1], dir: 0 };
}

/** 声音事件：画面里发生什么，就在那一刻记一笔，混音时按它配音效。 */
export const events = [];
export function cue(t, type, extra = {}) {
  events.push({ t: +t.toFixed(4), type, ...extra });
}
