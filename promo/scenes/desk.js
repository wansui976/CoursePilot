// 0:37–0:52 课桌：窗外的天色、季节和天气；摊开的上一讲；待复习、收集册；课程牌堆与 AI 画的黑板封面
import { clamp, lerp, prog, ease, el, svg, rng } from '../lib/core.js';
import { kf, tf, box, pop } from '../lib/scene.js';
import { ChalkWriter, ChalkCanvas, Dust } from '../lib/chalk.js';

export const DESK = (P) =>
  P
    ? {
        win: { x: 50, y: 100, w: 480, h: 330 }, sticky: { x: 550, y: 100, w: 480, h: 330 },
        nb: { x: 50, y: 460, w: 980, h: 640 }, cover: { x: 70, y: 480, w: 940, h: 529 },
        due: { x: 50, y: 1130, w: 480, h: 300 }, coll: { x: 550, y: 1130, w: 480, h: 300 },
        deck: { y: 1470, w: 310, h: 360, xs: [50, 385, 720], ch: 210 },
      }
    : {
        win: { x: 60, y: 90, w: 410, h: 300 }, sticky: { x: 60, y: 410, w: 410, h: 280 },
        nb: { x: 500, y: 90, w: 920, h: 600 }, cover: { x: 520, y: 110, w: 880, h: 495 },
        due: { x: 1450, y: 90, w: 410, h: 300 }, coll: { x: 1450, y: 410, w: 410, h: 280 },
        deck: { y: 722, w: 340, h: 318, xs: [60, 422, 784, 1146, 1508], ch: 200 },
      };

const COURSES = [
  { name: '微积分', meta: '24 讲', subj: '数学', terms: '导数 极限' },
  { name: '有机化学', meta: '18 讲', subj: '化学', terms: '苯环' },
  { name: '机器学习导论', meta: '16 讲', subj: '计算机', terms: '梯度 损失' },
  { name: '大学物理', meta: '30 讲', subj: '物理', terms: '简谐振动' },
  { name: '中国近代史', meta: '12 讲', subj: '历史', terms: '' },
];

export function deskChars() {
  return COURSES.map((c) => c.terms).join('');
}

export function buildDesk(ctx) {
  const { D, portrait: P, cue, plain } = ctx;
  const L = DESK(P);
  const root = D.el;
  const W = D.W, H = D.H;
  box(root, { x: 0, y: 0, w: W, h: H, cls: 'desk', style: { borderRadius: '12px', border: '1px solid var(--border-subtle)' } });
  box(root, { x: P ? 50 : 60, y: P ? 30 : 26, w: 400, h: 50, cls: 'serif', text: '课桌', style: { fontSize: '34px', fontWeight: 600, color: 'var(--text-strong)' } });
  box(root, { x: W - (P ? 450 : 460), y: P ? 40 : 34, w: P ? 400 : 400, h: 40, cls: 'mono', text: '11 月 28 日 · 星期六', style: { fontSize: '24px', color: 'var(--text-muted)', textAlign: 'right' } });

  // ---------- 窗 ----------
  const win = box(root, { ...L.win, cls: 'win' });
  const ww = L.win.w - 12, wh = L.win.h - 12;
  const sky = box(win, { x: 0, y: 0, w: ww, h: wh, cls: 'sky' });
  const ws = svg('svg', { width: ww, height: wh, viewBox: `0 0 ${ww} ${wh}`, style: 'position:absolute;left:0;top:0' }, win);
  const sun = svg('circle', { r: 22, fill: 'var(--sun)' }, ws);
  const moonG = svg('g', {}, ws);
  const moonDefs = svg('defs', {}, ws);
  const mm = svg('mask', { id: 'moonmask' }, moonDefs);
  svg('rect', { x: -40, y: -40, width: 80, height: 80, fill: '#fff' }, mm);
  const moonCut = svg('circle', { r: 18, cx: 9, cy: -4, fill: '#000' }, mm);
  svg('circle', { r: 18, fill: 'var(--moon)', mask: 'url(#moonmask)' }, moonG);
  const stars = [];
  const sr = rng(5);
  for (let i = 0; i < 22; i++) stars.push(svg('circle', { cx: sr() * ww, cy: sr() * wh * 0.55, r: 0.8 + sr() * 1.4, fill: '#fff' }, ws));
  const clouds = [];
  for (let i = 0; i < 3; i++) {
    const g = svg('g', {}, ws);
    [[0, 0, 26], [26, -8, 30], [54, 2, 22]].forEach(([x, y, r]) => svg('circle', { cx: x, cy: y, r, fill: 'var(--cloud)' }, g));
    clouds.push(g);
  }
  const hillFar = svg('path', { d: `M0 ${wh * 0.72} Q ${ww * 0.25} ${wh * 0.55} ${ww * 0.5} ${wh * 0.68} T ${ww} ${wh * 0.62} L ${ww} ${wh} L 0 ${wh} Z`, opacity: 0.7 }, ws);
  const hillNear = svg('path', { d: `M0 ${wh * 0.82} Q ${ww * 0.35} ${wh * 0.7} ${ww * 0.65} ${wh * 0.84} T ${ww} ${wh * 0.8} L ${ww} ${wh} L 0 ${wh} Z` }, ws);
  const wx = el('canvas', { width: ww, height: wh, style: { position: 'absolute', left: 0, top: 0, width: ww + 'px', height: wh + 'px' } }, win);
  const wctx = wx.getContext('2d');
  box(win, { x: ww / 2 - 3, y: 0, w: 6, h: wh, cls: 'mull-v' });
  box(win, { x: 0, y: wh * 0.46, w: ww, h: 6, cls: 'mull-h' });
  const weatherTag = box(root, { x: L.win.x + 16, y: L.win.y + L.win.h - 54, w: 260, h: 40, cls: 'chip', style: { fontSize: '22px', width: 'auto', background: 'rgba(255,255,255,0.86)' } });
  const drops = [];
  const dr = rng(8);
  for (let i = 0; i < 120; i++) drops.push({ x: dr() * ww, y: dr() * wh, v: 0.8 + dr() * 0.5, s: dr() });

  // ---------- 便利贴 ----------
  const st = box(root, { ...L.sticky, cls: 'sticky', style: { fontSize: (P ? 30 : 28) + 'px', transform: 'rotate(-1.2deg)' } });
  el('div', { class: 'tape' }, st);
  el('div', { class: 'serif', text: '今天', style: { fontWeight: 600, color: 'var(--text-strong)', fontSize: '1.15em', marginBottom: '0.3em' } }, st);
  const todo = ['复习 12 张卡', '看完第 4 讲', '错题过一遍'].map((s) => el('div', { text: '· ' + s }, st));

  // ---------- 摊开的上一讲 ----------
  const nb = box(root, { ...L.nb, cls: 'widget' });
  const cov = box(root, { ...L.cover, cls: 'lec' });
  lectureFrame(cov, L.cover.w, L.cover.h);
  const playB = box(cov, { x: L.cover.w / 2 - 48, y: L.cover.h / 2 - 48, w: 96, h: 96, cls: 'play', style: { fontSize: '38px' } });
  const pbar = box(cov, { x: 28, y: L.cover.h - 30, w: L.cover.w - 56, h: 4, cls: 'prog' });
  const pfill = el('i', { style: { width: '41%' } }, pbar);
  const phead = el('b', { style: { left: '41%' } }, pbar);
  const ty = L.cover.y + L.cover.h + (P ? 22 : 18);
  box(root, { x: L.cover.x, y: ty, w: L.cover.w, h: 44, cls: 'serif', text: '机器学习导论 · 第 3 讲 梯度下降', style: { fontSize: (P ? 34 : 32) + 'px', fontWeight: 600, color: 'var(--text-strong)', whiteSpace: 'nowrap' } });
  box(root, { x: L.cover.x, y: ty + (P ? 50 : 46), w: L.cover.w, h: 34, cls: 'mono', text: '上次看到 12:48 · 还剩 18:20', style: { fontSize: '24px', color: 'var(--text-muted)' } });

  // ---------- 右边两格 ----------
  const due = box(root, { ...L.due, cls: 'widget' });
  box(due, { x: 28, y: 24, w: 300, h: 34, cls: 'wt', text: '待复习', style: { fontSize: '26px' } });
  const dueN = box(due, { x: 28, y: 80, w: 300, h: 130, cls: 'big', text: '12', style: { fontSize: '128px' } });
  box(due, { x: 28, y: L.due.h - 62, w: 340, h: 34, cls: 'wt', text: '张卡 · 约 6 分钟', style: { fontSize: '24px' } });
  const coll = box(root, { ...L.coll, cls: 'widget' });
  box(coll, { x: 28, y: 24, w: 300, h: 34, cls: 'wt', text: '收集册 · 错题本', style: { fontSize: '26px' } });
  box(coll, { x: 28, y: 80, w: 360, h: 100, cls: 'big', html: '6<span style="font-size:0.45em;color:var(--text-muted)"> / 8 点亮</span>', style: { fontSize: '96px' } });
  box(coll, { x: 28, y: L.coll.h - 62, w: 360, h: 34, cls: 'wt', html: '<span style="color:var(--status-err)">●</span> 错题 9 道', style: { fontSize: '24px' } });

  // ---------- 课程牌堆 ----------
  const dk = L.deck;
  const deck = dk.xs.map((x, i) => {
    const c = COURSES[i];
    const card = box(root, { x, y: dk.y, w: dk.w, h: dk.h, cls: 'deckcard' });
    box(card, { x: 0, y: 0, w: dk.w, h: dk.ch, cls: 'cov' }).appendChild(el('div', { class: 'ledge3' }));
    box(card, { x: 22, y: dk.ch + 22, w: dk.w - 44, h: 40, cls: 'ttl', text: c.name, style: { fontSize: (P ? 30 : 30) + 'px' } });
    const meta = box(card, { x: 22, y: dk.ch + 72, w: dk.w - 44, h: 34, cls: 'meta', html: `${c.meta} · <span class="chip" style="font-size:20px">AI 判断：${c.subj}</span>`, style: { fontSize: '22px' } });
    return { card, meta, x, y: dk.y };
  });
  // 封面上的粉笔画
  const chalk = new ChalkCanvas(root, { x: 0, y: dk.y - 10, w: W, h: dk.ch + 20, res: 1.6, z: 6 });
  const C0 = 47.0;
  const covT = [];
  deck.forEach((d, i) => {
    const w = new ChalkWriter({ seed: 40 + i });
    const t0 = C0 + i * (P ? 1.0 : 0.72);
    covT.push(t0);
    const cx = d.x + dk.w / 2, cy = d.y + dk.ch / 2 - 6;
    drawSubject(w, COURSES[i], cx, cy, dk.w, dk.ch, t0, plain);
    chalk.writers.push(w);
  });
  // 设计规范：课程封面上不落粉笔灰。
  covT.forEach((t) => cue(t, 'sparkle'));

  // ---------- 时间与镜头 ----------
  const T = { in: 37.6, sky0: 38.8, sky1: 43.2, nb: 43.4, deck: 46.4 };
  const camWin = D.cam(L.win.x + L.win.w / 2 + (P ? 0 : 20), L.win.y + L.win.h / 2 + 20, P ? 1.75 : 2.05);
  ctx.cam(37.7, D.cam(W / 2, H / 2, 1.0));
  ctx.cam(38.7, camWin);
  ctx.cam(42.6, { ...camWin, z: camWin.z * 1.06 });
  ctx.cam(43.6, D.cam(L.nb.x + L.nb.w / 2, L.nb.y + L.nb.h / 2, P ? 1.06 : 1.5));
  ctx.cam(46.0, D.cam(L.nb.x + L.nb.w / 2, L.nb.y + L.nb.h / 2 - 10, P ? 1.1 : 1.58));
  const deckW = dk.xs[dk.xs.length - 1] + dk.w - dk.xs[0];
  ctx.cam(46.9, D.cam(dk.xs[0] + deckW / 2, dk.y + dk.h / 2 + (P ? -80 : 0), (W / (deckW + 80)) * 1.0));
  ctx.cam(51.6, D.cam(dk.xs[0] + deckW / 2, dk.y + dk.h / 2 + (P ? -80 : 0), (W / (deckW + 80)) * 1.04));

  // Clawd：从收集册那一格跳上窗台看天，下雨时缩一下；走到摊开的笔记本上；再一张张封面跳过去。
  const sill = { x: L.win.x + L.win.w * 0.72, y: L.win.y + L.win.h - 4 };
  const keys = [
    { t: 37.4, x: L.coll.x + L.coll.w / 2, y: L.coll.y, u: 7 },
    { t: 38.5, x: sill.x, y: sill.y, hop: P ? 420 : 300, dur: 0.75, u: P ? 6 : 5, look: -0.7, spin: 1 },
    { t: 41.7, x: sill.x - 40, y: sill.y, walk: true, dur: 0.5, u: P ? 6 : 5, look: -0.8 },
    { t: 43.9, x: L.nb.x + L.nb.w * 0.78, y: L.nb.y, hop: 260, dur: 0.7, u: P ? 8 : 7, look: -0.6, wave: 0.9 },
    ...deck.map((d, i) => ({ t: covT[i] - 0.05, x: d.x + dk.w / 2, y: d.y, hop: i === 0 ? 300 : 140, dur: i === 0 ? 0.7 : 0.42, u: P ? 7 : 6.5, look: 0.6 })),
    { t: 51.3, x: deck[deck.length - 1].x + dk.w / 2 + 40, y: deck[deck.length - 1].y, walk: true, dur: 0.5, u: P ? 7 : 6.5, wave: 0.8 },
  ];
  ctx.track(D, keys, 37.4, 52.3);
  cue(41.0, 'rain', { dur: 1.1 });

  function update(t) {
    // 天色：黎明 → 白天 → 黄昏 → 夜里，季节和天气跟着走一圈
    const p = clamp((t - T.sky0) / (T.sky1 - T.sky0));
    const stops = [
      [0, 'dawn'], [0.28, 'day'], [0.55, 'dusk'], [0.72, 'night'], [1, 'night'],
    ];
    const col = (name, which) => ctx.css(`--sky-${name}-${which}`);
    let a = stops[0], b = stops[1];
    for (let i = 1; i < stops.length; i++) if (p <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; } else { a = stops[i]; b = stops[i]; }
    const k = b[0] > a[0] ? (p - a[0]) / (b[0] - a[0]) : 0;
    const top = mixHex(col(a[1], 'top'), col(b[1], 'top'), k);
    const bot = mixHex(col(a[1], 'bottom'), col(b[1], 'bottom'), k);
    sky.style.background = `linear-gradient(${top}, ${bot})`;
    // 太阳从左边升起、右边落下；夜里月亮出来（按月相画：一弯上弦月）
    const sp = clamp(p / 0.62);
    sun.setAttribute('cx', lerp(ww * 0.1, ww * 0.9, sp));
    sun.setAttribute('cy', wh * 0.62 - Math.sin(Math.PI * sp) * wh * 0.48);
    sun.setAttribute('opacity', p < 0.66 ? 1 : 0);
    const mp = clamp((p - 0.6) / 0.4);
    moonG.setAttribute('transform', `translate(${lerp(ww * 0.2, ww * 0.62, mp)} ${wh * 0.5 - Math.sin(Math.PI * (0.2 + mp * 0.6)) * wh * 0.32})`);
    moonG.setAttribute('opacity', clamp((p - 0.62) / 0.08));
    moonCut.setAttribute('cx', lerp(14, 6, mp));
    stars.forEach((s, i) => s.setAttribute('opacity', clamp((p - 0.66) / 0.08) * (0.5 + 0.5 * Math.sin(t * 3 + i))));
    clouds.forEach((g, i) => {
      const cxp = ((t * 22 + i * 160) % (ww + 160)) - 80;
      g.setAttribute('transform', `translate(${cxp} ${wh * (0.18 + i * 0.12)}) scale(${0.8 + i * 0.15})`);
      g.setAttribute('opacity', p > 0.66 ? 0.25 : 0.95);
    });
    // 远山按季节换色：春 → 夏 → 秋 → 冬
    const seasons = ['spring', 'summer', 'autumn', 'winter'].map((s) => ctx.css(`--hill-${s}`));
    const sp4 = clamp(p) * 3;
    const si = Math.min(2, Math.floor(sp4));
    const hc = mixHex(seasons[si], seasons[si + 1], ease.inOut(sp4 - si));
    hillNear.setAttribute('fill', hc);
    hillFar.setAttribute('fill', mixHex(hc, '#ffffff', 0.35));
    // 雨（黄昏前）和雪（夜里）
    wctx.clearRect(0, 0, ww, wh);
    const rain = clamp((p - 0.42) / 0.05) * (1 - clamp((p - 0.6) / 0.05));
    const snow = clamp((p - 0.78) / 0.05);
    if (rain > 0) {
      wctx.strokeStyle = ctx.css('--rain');
      wctx.lineWidth = 1.6;
      wctx.globalAlpha = rain;
      for (const d of drops) {
        const y = (d.y + t * 900 * d.v) % wh;
        wctx.beginPath();
        wctx.moveTo(d.x, y);
        wctx.lineTo(d.x - 4, y + 16);
        wctx.stroke();
      }
    }
    if (snow > 0) {
      wctx.fillStyle = ctx.css('--snow');
      wctx.globalAlpha = snow;
      for (const d of drops) {
        const y = (d.y + t * 50 * d.v) % wh;
        const x = (d.x + Math.sin(t * 1.5 + d.s * 6) * 10 + ww) % ww;
        wctx.beginPath();
        wctx.arc(x, y, 1.5 + d.s * 1.8, 0, Math.PI * 2);
        wctx.fill();
      }
    }
    wctx.globalAlpha = 1;
    const tag = p < 0.2 ? '06:12 日出 · 春' : p < 0.42 ? '13:40 晴 · 夏' : p < 0.6 ? '17:55 小雨 · 秋' : p < 0.78 ? '21:30 上弦月' : '23:10 小雪 · 冬';
    weatherTag.textContent = t < T.sky0 ? '09:20 晴 · 本地天气' : tag;
    weatherTag.style.opacity = t < 44 ? 1 : 0.9;

    // 上一讲：播放头轻轻一闪，播放键呼吸
    const ph = 0.41 + 0.0005 * Math.max(0, t - 44);
    pfill.style.width = ph * 100 + '%';
    phead.style.left = ph * 100 + '%';
    const pulse = t > T.nb + 0.6 && t < 46.5 ? 1 + 0.06 * Math.sin((t - T.nb) * 6) : 1;
    playB.style.transform = `scale(${pulse})`;
    todo.forEach((n, i) => (n.style.textDecoration = i === 0 && t > 36 ? 'line-through' : 'none'));
    dueN.textContent = '12';

    // 封面：粉笔一张张画上
    if (t > C0 - 0.5 && t < 53) chalk.draw(t);
    chalk.c.style.display = t > C0 - 0.5 ? '' : 'none';
    deck.forEach((d, i) => {
      const m = pop(t, covT[i] + 0.55, 0.4);
      d.meta.style.opacity = t < C0 ? 1 : Math.min(1, 0.0001 + m);
    });
  }
  return { update, layout: L };
}

/** 讲课视频的一帧：黑板上的抛物线和一串往下走的点。 */
function lectureFrame(parent, w, h) {
  const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, style: 'position:absolute;left:0;top:0' }, parent);
  const ch = 'rgba(238,242,236,0.82)';
  const X = (u) => w * 0.5 + u * w * 0.3;
  const Y = (u) => h * 0.82 - (1 - u * u) * h * 0.52;
  let d = '';
  for (let i = 0; i <= 40; i++) { const u = -1 + (2 * i) / 40; d += (i ? ' L' : 'M') + `${X(u).toFixed(1)} ${(h * 0.3 + u * u * h * 0.5).toFixed(1)}`; }
  svg('path', { d, fill: 'none', stroke: ch, 'stroke-width': 4, 'stroke-linecap': 'round' }, s);
  [-0.85, -0.55, -0.32, -0.16, -0.05].forEach((u, i) => {
    svg('circle', { cx: X(u), cy: h * 0.3 + u * u * h * 0.5, r: 7, fill: ch, opacity: 0.5 + i * 0.1 }, s);
  });
  const tx = svg('text', { x: w * 0.06, y: h * 0.16, fill: ch, 'font-family': 'Newsreader Variable, Noto Serif SC', 'font-size': h * 0.07, 'font-style': 'italic' }, s);
  tx.textContent = 'θ ← θ − η∇L(θ)';
}

/** AI 给每个学科画的几笔（校验过的形状），再写上关键术语。 */
function drawSubject(w, c, cx, cy, cw, ch, t0, plain) {
  const s = Math.min(cw / 340, ch / 200);
  const P = (x, y) => ({ x: cx + x * s, y: cy + y * s });
  const line = (pts, t, dur, width = 4.5) => w.addStroke(pts.map(([x, y]) => P(x, y)), { t0: t, dur, width });
  const arc = (x, y, r, a0, a1, t, dur, width = 4.5) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) { const a = a0 + ((a1 - a0) * i) / 40; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
    return line(pts, t, dur, width);
  };
  let t = t0;
  if (c.subj === '数学') {
    line([[-120, 60], [120, 60]], t, 0.18); line([[-100, 80], [-100, -70]], t + 0.12, 0.16);
    const pts = []; for (let i = 0; i <= 30; i++) { const x = -90 + i * 7; pts.push([x, 50 - ((x + 10) ** 2) / 90 * -1 * -1 + 0]); }
    const cur = []; for (let i = 0; i <= 30; i++) { const x = -90 + i * 6.5; cur.push([x, 55 - (x + 90) ** 2 / 230]); }
    line(cur, t + 0.3, 0.4);
    line([[-10, 40], [110, -40]], t + 0.72, 0.2, 3);
  } else if (c.subj === '化学') {
    const hex = []; for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 3; hex.push([Math.cos(a) * 58, Math.sin(a) * 58]); }
    line(hex, t, 0.55);
    arc(0, 0, 34, 0, Math.PI * 2, t + 0.58, 0.32, 3.5);
  } else if (c.subj === '计算机') {
    const L1 = [[-100, -40], [-100, 40]], L2 = [[0, -60], [0, 0], [0, 60]], L3 = [[100, 0]];
    let tt = t;
    for (const a of L1) for (const b of L2) { line([a, b], tt, 0.08, 2.6); tt += 0.035; }
    for (const a of L2) for (const b of L3) { line([a, b], tt, 0.08, 2.6); tt += 0.035; }
    [...L1, ...L2, ...L3].forEach(([x, y], i) => arc(x, y, 11, 0, Math.PI * 2, tt + i * 0.03, 0.12, 3.5));
  } else if (c.subj === '物理') {
    line([[-110, -70], [-10, -70]], t, 0.15);
    line([[-60, -70], [-20, 20]], t + 0.15, 0.2, 3);
    arc(-20, 32, 13, 0, Math.PI * 2, t + 0.35, 0.15);
    const wv = []; for (let i = 0; i <= 40; i++) { const x = 10 + i * 3; wv.push([x, 10 + Math.sin(i / 40 * Math.PI * 3) * 32]); }
    line(wv, t + 0.5, 0.35);
  } else {
    line([[-130, 20], [130, 20]], t, 0.25);
    [-90, -10, 70].forEach((x, i) => line([[x, 6], [x, 34]], t + 0.25 + i * 0.06, 0.06, 3.5));
    w.addLine('1840', plain, { x: cx + (-118) * s, y: cy - 14 * s, size: 44 * s, t0: t + 0.45, width: 3.2, speed: 900 });
    w.addLine('1911', plain, { x: cx + 40 * s, y: cy - 14 * s, size: 44 * s, t0: t + 0.7, width: 3.2, speed: 900 });
  }
  if (c.terms) w.addHan(c.terms, { x: cx - cw / 2 + 16, y: cy - ch / 2 + 12, size: 30 * s, gap: 1.06, t0: t0 + 0.9, speed: 900, strokeGap: 0.008, charGap: 0.03, overhead: 0.006 });
}

function mixHex(a, b, t) {
  const p = (h) => {
    h = h.trim();
    if (h.startsWith('rgb')) return h.match(/[\d.]+/g).slice(0, 3).map(Number);
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const A = p(a), B = p(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], clamp(t)))).join(',')})`;
}
