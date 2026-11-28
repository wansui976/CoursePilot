// Clawd 的走位：给一串「几点几分到哪里」，自动补上起跳、空中弧线、落地压扁、走路、眨眼。
// keys: [{ t, x, y, u?, hop?, dur?, spin?, look?, wave?, walk?, hide? }]
//   t      到达时间
//   x, y   落脚点（场景局部坐标，也可以是 (t) => 数字，跟着会动的东西走）
//   u      大小（局部像素 / 每格）
//   hop    跳过去的弧高；0 表示走过去（walk）或直接出现
//   dur    路上用多久（默认 0.42 秒）
//   spin   空中翻一圈（1 / -1）
//   look   到了以后往哪看（-1..1）
//   wave   到了以后挥手（秒数）
import { clamp, lerp, ease, wobble } from './core.js';

const val = (v, t) => (typeof v === 'function' ? v(t) : v);

export function clawdAt(t, keys, { cue } = {}) {
  if (!keys.length || t < keys[0].t - (keys[0].dur ?? 0)) return null;
  let i = keys.findIndex((k) => k.t > t);
  if (i === -1) i = keys.length;
  if (i === 0) i = 1;
  const prev = keys[i - 1];
  const next = keys[i];
  const st = { x: val(prev.x, t), y: val(prev.y, t), u: prev.u ?? 10, squash: 0, tilt: 0, step: 0, look: prev.look ?? 0, wave: 0, waveFlip: false, blink: 0, shadow: 1, hide: !!prev.hide };

  // 在路上
  if (next) {
    const dur = next.dur ?? 0.42;
    const t0 = next.t - dur;
    if (t >= t0) {
      const k = clamp((t - t0) / dur);
      const ax = val(prev.x, t0), ay = val(prev.y, t0);
      const bx = val(next.x, next.t), by = val(next.y, next.t);
      const u = lerp(prev.u ?? 10, next.u ?? prev.u ?? 10, k);
      if ((next.hop ?? 0) > 0) {
        const e = ease.inOut(k);
        return {
          ...st, x: lerp(ax, bx, e), y: lerp(ay, by, k) - next.hop * 4 * k * (1 - k), u,
          squash: k < 0.18 ? -0.45 * (1 - k / 0.18) : 0,
          tilt: next.spin ? -360 * next.spin * ease.inOut(clamp((k - 0.1) / 0.8)) : (bx - ax > 0 ? 8 : -8) * Math.sin(Math.PI * k),
          shadow: 0, look: Math.sign(bx - ax) * 0.6, hide: false,
        };
      }
      if (next.walk) {
        return { ...st, x: lerp(ax, bx, k), y: lerp(ay, by, k), u, step: (t - t0) * 3.2, look: Math.sign(bx - ax) * 0.7, hide: false };
      }
    }
    // 起跳前蹲一下
    if ((next.hop ?? 0) > 0) {
      const tc = next.t - (next.dur ?? 0.42);
      if (t > tc - 0.16 && t < tc) st.squash = 0.5 * ease.outCubic((t - (tc - 0.16)) / 0.16);
    }
  }
  // 落地
  const since = t - prev.t;
  if ((prev.hop ?? 0) > 0 && since < 1) st.squash += 0.5 * wobble(since, 3.4, 5.5) + 0.3 * Math.exp(-10 * since);
  // 挥手
  if (prev.wave && since > 0.05 && since < prev.wave) {
    st.wave = 1;
    st.waveFlip = Math.sin(t * Math.PI * 9) > 0;
  }
  // 原地呼吸 + 眨眼
  st.squash += 0.04 * Math.sin(t * 3.1);
  const bp = (t * 0.41 + 0.3) % 1;
  st.blink = bp > 0.97 ? 1 - Math.abs(bp - 0.985) / 0.015 : 0;
  return st;
}

/** 给每次落地记一个声音事件。 */
export function cueTrack(keys, cue) {
  for (const k of keys) {
    if ((k.hop ?? 0) > 0) {
      cue(k.t - (k.dur ?? 0.42), 'jump');
      cue(k.t, 'land');
    }
    if (k.wave) cue(k.t + 0.05, 'chirp');
  }
}
