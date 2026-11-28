// 1:45–2:00 回到黑板：CoursePilot · 免费、开源、数据留在你手里 → 学而时习之，不亦说乎 → 落版
import { clamp, lerp, prog, ease, el, svg, rng } from '../lib/core.js';
import { tf, box, pop } from '../lib/scene.js';
import { ChalkWriter, ChalkCanvas, Dust } from '../lib/chalk.js';

export const END_CHARS = '免费开源数据都留在你手里学而时习之不亦说乎';

export function buildEnding(ctx) {
  const { E, portrait: P, cue, script, plain } = ctx;
  const W = E.W, H = E.H;
  const root = E.el;
  const bw = P ? 990 : 1760, bh = P ? 1640 : 990;
  const bx = (W - bw) / 2, by = (H - bh) / 2 - (P ? 40 : 20);
  const board = box(root, { x: bx, y: by, w: bw, h: bh, cls: 'board-surface' });
  board.style.backgroundImage = `url(${ctx.boardTexture(bw, bh)})`;
  box(root, { x: bx - bw * 0.02, y: by + bh - 8, w: bw * 1.04, h: 34, cls: 'ledge', style: { left: bx - bw * 0.02 + 'px', width: bw * 1.04 + 'px' } });
  const cc = new ChalkCanvas(root, { x: bx, y: by, w: bw, h: bh + 80, res: 1.5, z: 3 });
  const keep = new ChalkWriter({ seed: 91 });
  const wipe = new ChalkWriter({ seed: 92 });
  const last = new ChalkWriter({ seed: 93 });
  const cx = bx + bw / 2;

  // CoursePilot
  let lsz = P ? 250 : 300;
  let lw = ChalkWriter.measureLine('CoursePilot', script, lsz);
  const maxW = bw * (P ? 0.78 : 0.56);
  if (lw > maxW) { lsz *= maxW / lw; lw = maxW; }
  const baseY = by + (P ? 300 : 250);
  const logo = keep.addLine('CoursePilot', script, { x: cx - lw / 2, y: baseY, size: lsz, t0: 105.5, width: P ? 9 : 9.5, speed: 6500, overhead: 0.006, strokeGap: 0.004, charGap: 0.006 });

  // 免费 · 开源 · 数据都留在你手里
  const hs = P ? 74 : 74;
  const dot = (x, y, t) => wipe.addLoop({ cx: x, cy: y, rx: 4, ry: 4, t0: t, dur: 0.05, width: 6, turns: 1.2 });
  let t = 106.5;
  if (P) {
    const y1 = by + 470, y2 = y1 + hs * 1.35;
    const w1 = hs * 1.08 * 5;
    let r = wipe.addHan('免费', { x: cx - w1 / 2, y: y1, size: hs, gap: 1.08, t0: t, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    dot(cx, y1 + hs * 0.5, r.t1 + 0.02);
    r = wipe.addHan('开源', { x: cx + w1 / 2 - hs * 2.16, y: y1, size: hs, gap: 1.08, t0: r.t1 + 0.1, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    const w2 = hs * 1.08 * 7;
    r = wipe.addHan('数据都留在你手里', { x: cx - (hs * 1.08 * 8) / 2, y: y2, size: hs, gap: 1.08, t0: r.t1 + 0.1, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    t = r.t1;
  } else {
    const y1 = by + 420;
    const total = hs * 1.08 * 12 + 60;
    let x = cx - total / 2;
    let r = wipe.addHan('免费', { x, y: y1, size: hs, gap: 1.08, t0: t, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    x += hs * 1.08 * 2 + 30;
    dot(x - 15, y1 + hs * 0.5, r.t1 + 0.02);
    r = wipe.addHan('开源', { x, y: y1, size: hs, gap: 1.08, t0: r.t1 + 0.1, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    x += hs * 1.08 * 2 + 30;
    dot(x - 15, y1 + hs * 0.5, r.t1 + 0.02);
    r = wipe.addHan('数据都留在你手里', { x, y: y1, size: hs, gap: 1.08, t0: r.t1 + 0.1, speed: 4600, strokeGap: 0.005, charGap: 0.02, overhead: 0.005 });
    t = r.t1;
  }
  const plat = 'Windows · macOS · Android · iOS';
  const psz = P ? 50 : 58;
  const pw = ChalkWriter.measureLine(plat, plain, psz, 2);
  const platY = by + (P ? 760 : 640);
  wipe.addLine(plat, plain, { x: cx - pw / 2, y: platY, size: psz, t0: t + 0.1, width: 5, speed: 6500, tracking: 2, overhead: 0.004, strokeGap: 0.004, charGap: 0.006 });

  // 擦掉下半块
  const ER0 = 110.75, ER1 = 111.3;
  const zTop = by + (P ? 400 : 360), zBot = by + bh - 70;
  const zig = [];
  const nRows = P ? 11 : 7;
  for (let i = 0; i < nRows; i++) zig.push({ x: i % 2 ? bx + 40 : bx + bw - 40, y: lerp(zTop, zBot, i / (nRows - 1)) });
  const zp = new Path2D();
  zig.forEach((p, i) => (i ? zp.lineTo(p.x, p.y) : zp.moveTo(p.x, p.y)));
  let zLen = 0;
  for (let i = 1; i < zig.length; i++) zLen += Math.hypot(zig[i].x - zig[i - 1].x, zig[i].y - zig[i - 1].y);
  cue(ER0, 'erase', { dur: ER1 - ER0 });

  // 学而时习之 / 不亦说乎
  const bs = P ? 150 : 128;
  const gap = 1.1;
  const l1 = 5 * bs * gap, l2 = 4 * bs * gap;
  const yA = by + (P ? 560 : 410), yB = yA + bs * 1.35;
  const r1 = last.addHan('学而时习之', { x: cx - l1 / 2, y: yA, size: bs, gap, t0: 111.4, speed: 5200, strokeGap: 0.006, charGap: 0.04, overhead: 0.006 });
  const r2 = last.addHan('不亦说乎', { x: cx - l2 / 2, y: yB, size: bs, gap, t0: 113.35, speed: 3000, strokeGap: 0.014, charGap: 0.12, overhead: 0.012 });
  const yue = r2.boxes[2];
  last.addLoop({ cx: yue.x + bs / 2, cy: yue.y + bs * 0.48, rx: bs * 0.66, ry: bs * 0.6, t0: 115.45, dur: 0.38, width: 7.5, seed: 5 });
  const url = 'github.com/wansui976/CoursePilot';
  const usz = P ? 46 : 48;
  const uw = ChalkWriter.measureLine(url, plain, usz, 1);
  const urlR = last.addLine(url, plain, { x: cx - uw / 2, y: by + bh - (P ? 230 : 175), size: usz, t0: 116.1, width: 4.6, speed: 4200, tracking: 1, overhead: 0.003, strokeGap: 0.003, charGap: 0.004 });

  cc.writers.push(keep);
  const dust = new Dust(71);
  for (const w of [keep, wipe, last]) dust.fromWriter(w, { rate: 22 });
  for (let i = 1; i < zig.length; i++) dust.burst(lerp(ER0, ER1, i / (zig.length - 1)), zig[i].x, zig[i].y, 28, 3);
  // 落地那一下扬起一阵粉，像撒彩纸
  for (let i = 0; i < 4; i++) dust.burst(115.95 + i * 0.05, cx + (i - 1.5) * 160, by + bh - 40, 40, 5);
  cc.dust = dust;

  // 板擦（Clawd 推着）
  const eraser = svg('svg', { width: 260, height: 100, viewBox: '-130 -50 260 100', style: 'position:absolute;left:0;top:0;overflow:visible;z-index:4' }, root);
  svg('rect', { x: -110, y: -36, width: 220, height: 72, rx: 8, fill: ctx.css('--eraser') }, eraser);
  svg('rect', { x: -110, y: 18, width: 220, height: 18, rx: 5, fill: '#cfc9bd', opacity: 0.85 }, eraser);
  const eraserAt = (k) => {
    let want = k * zLen;
    for (let i = 1; i < zig.length; i++) {
      const seg = Math.hypot(zig[i].x - zig[i - 1].x, zig[i].y - zig[i - 1].y);
      if (want <= seg) return { x: lerp(zig[i - 1].x, zig[i].x, want / seg), y: lerp(zig[i - 1].y, zig[i].y, want / seg) };
      want -= seg;
    }
    return zig[zig.length - 1];
  };

  // 屏幕角落：署名
  const credit = el('div', { class: 'sans', html: 'Music: “Inspired” by Kevin MacLeod (incompetech.com) · CC BY 4.0<br>Clawd 客串 · Made with Claude Code', style: { position: 'absolute', right: (P ? 40 : 48) + 'px', bottom: (P ? 60 : 36) + 'px', fontSize: (P ? 22 : 20) + 'px', lineHeight: 1.6, color: 'rgba(238,242,236,0.55)', textAlign: 'right', opacity: 0, zIndex: 20 } }, ctx.stage);

  // 镜头：甩过来，慢慢推近，最后轻轻拉开
  ctx.cam(104.65, ctx.I.cam(W / 2, H / 2, 0.98));
  ctx.cam(105.35, E.cam(W / 2, H / 2 + (P ? 0 : 10), 1.06), ease.inOutExpo);
  ctx.cam(110.6, E.cam(W / 2, H / 2 - (P ? 60 : 20), 1.1));
  ctx.cam(111.4, E.cam(W / 2, H / 2, 1.05));
  ctx.cam(115.6, E.cam(W / 2, H / 2 + (P ? 40 : 20), 1.14));
  ctx.cam(119.8, E.cam(W / 2, H / 2, 0.96));
  cue(104.7, 'whoosh', { dur: 0.7 });

  // Clawd：从槽里冒出来看字 → 推板擦 → 回到槽上 → 写完「乎」时一个大跳空翻 → 挥手告别
  const ledgeY = by + bh - 8;
  const u = P ? 11 : 9.5;
  const keys = [
    { t: 105.7, x: bx + bw - 220, y: ledgeY + 120, u, hide: true },
    { t: 106.1, x: bx + bw - 220, y: ledgeY, u, hop: 150, dur: 0.35, look: -0.8 },
    { t: ER0 - 0.02, x: () => eraserAt(0).x + 150, y: () => eraserAt(0).y + 44, u: u * 0.8, hop: 300, dur: 0.5, look: -1 },
    { t: ER1, x: () => eraserAt(1).x + 150, y: () => eraserAt(1).y + 44, u: u * 0.8, walk: true, dur: ER1 - ER0 },
    { t: 111.9, x: bx + bw - 220, y: ledgeY, u, hop: 220, dur: 0.5, look: -0.6 },
    { t: 115.9, x: cx + (P ? 300 : 560), y: ledgeY, u, hop: P ? 520 : 420, dur: 0.75, spin: 1 },
    { t: 116.6, x: cx + (P ? 300 : 560), y: ledgeY, u, hop: 60, dur: 0.3, wave: 1.6 },
    { t: 118.6, x: cx + (P ? 300 : 560), y: ledgeY, u, hop: 50, dur: 0.3, wave: 1.2 },
  ];
  ctx.track(E, keys, 105.4, 120.5);
  cue(105.8, 'pop');

  function update(tt) {
    // 板擦期间只画 keep，然后擦，再画别的；按顺序叠起来
    const ek = ease.inOut(prog(tt, ER0, ER1));
    cc.writers = [keep];
    cc.draw(tt, null, (c) => {
      wipe.draw(c, tt);
      if (ek > 0) {
        c.save();
        c.globalCompositeOperation = 'destination-out';
        c.strokeStyle = 'rgba(0,0,0,0.975)';
        c.lineWidth = 240;
        c.lineCap = c.lineJoin = 'round';
        if (ek < 1) c.setLineDash([ek * zLen, zLen + 1000]);
        c.stroke(zp);
        c.restore();
      }
      last.draw(c, tt);
    });
    if (tt > ER0 - 0.3 && tt < ER1 + 0.4) {
      const p = tt < ER0 ? eraserAt(0) : tt > ER1 ? eraserAt(1) : eraserAt(ek);
      tf(eraser, { x: p.x - 130, y: p.y - 50, r: Math.sin(tt * 22) * 4, o: tt < ER0 ? prog(tt, ER0 - 0.3, ER0) : 1 - prog(tt, ER1, ER1 + 0.4) });
    } else tf(eraser, { o: 0 });
    credit.style.opacity = prog(tt, 117.0, 117.8) * (1 - prog(tt, 119.0, 119.8));
  }
  return { update, board: { bx, by, bw, bh } };
}
