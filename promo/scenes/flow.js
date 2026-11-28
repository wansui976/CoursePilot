// 1:21–1:45 从网盘导入 → 按意思搜 → 复习资料 → 下载启动 23 秒到 0.2 秒
import { clamp, lerp, prog, ease, el, wobble } from '../lib/core.js';
import { tf, box, pop, typed } from '../lib/scene.js';

export function buildFlow(ctx) {
  const { I, portrait: P, cue } = ctx;
  const root = I.el;
  const W = I.W, H = I.H;

  // =============== 1. 从网盘导入 ===============
  const dR = P ? { x: 50, y: 230, w: 980, h: 1460 } : { x: 330, y: 100, w: 1260, h: 880 };
  const dlg = box(root, { ...dR, cls: 'dlg' });
  const hdH = P ? 96 : 84;
  const hd = box(dlg, { x: 0, y: 0, w: dR.w, h: hdH, cls: 'hd', text: '从网盘导入', style: { paddingLeft: '40px', fontSize: (P ? 38 : 34) + 'px' } });
  const drives = [['夸克网盘', 'Cookie 直连'], ['百度网盘', '经 OpenList'], ['阿里云盘', '经 OpenList'], ['群晖 NAS', 'WebDAV'], ['坚果云', 'WebDAV']];
  const driveT = [82.5, 83.1, 83.6, 84.1, 84.45];
  driveT.forEach((t) => cue(t, 'pop2'));
  const drvEls = drives.map(([n, sub], i) => {
    const r = P
      ? { x: 30 + (i % 3) * 312, y: hdH + 26 + Math.floor(i / 3) * 128, w: 296, h: 112 }
      : { x: 30, y: hdH + 26 + i * 122, w: 340, h: 108 };
    return box(dlg, { ...r, cls: 'drv', html: `<span style="font-size:${P ? 30 : 28}px;font-weight:600">${n}</span><small style="font-size:${P ? 22 : 20}px;margin-top:4px">${sub}</small>`, style: { padding: '0 24px' } });
  });
  const fx = P ? 30 : 400, fy = P ? hdH + 300 : hdH + 26;
  const fw = P ? dR.w - 60 : dR.w - 430;
  const crumb = box(dlg, { x: fx, y: fy, w: fw, h: 40, cls: 'sans', text: '夸克网盘 / 2027 申论系统班', style: { fontSize: (P ? 26 : 24) + 'px', color: 'var(--text-muted)' } });
  const files = [['第 1 讲 · 申论是什么', '438 MB'], ['第 2 讲 · 归纳概括', '412 MB'], ['第 3 讲 · 提出对策', '455 MB'], ['第 4 讲 · 综合分析', '470 MB'], ['第 5 讲 · 大作文', '486 MB']];
  const rowH = P ? 112 : 96;
  const rows = files.map(([n, sz], i) => {
    const r = box(dlg, { x: fx, y: fy + 56 + i * rowH, w: fw, h: rowH, cls: 'frow', style: { gap: '22px', fontSize: (P ? 30 : 27) + 'px' } });
    const cb = el('div', { class: 'cbx', html: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M5 11.5 L9.5 16 L17 6.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>', style: { width: (P ? 38 : 34) + 'px', height: (P ? 38 : 34) + 'px' } }, r);
    el('span', { text: n, style: { flex: 1 } }, r);
    el('span', { class: 'mono', text: sz, style: { color: 'var(--text-muted)', fontSize: '0.85em' } }, r);
    return { r, cb };
  });
  const checkT = [85.35, 85.65, 85.95, 86.25, 86.55];
  checkT.forEach((t) => cue(t, 'tick'));
  const ftH = P ? 120 : 96;
  const ft = box(dlg, { x: 0, y: dR.h - ftH, w: dR.w, h: ftH, cls: 'ft', style: { padding: '0 32px', fontSize: (P ? 26 : 24) + 'px' } });
  const segEl = el('div', { class: 'seg', html: '<span class="on">下载到本机</span><span>在线看</span>' }, ft);
  const selTxt = el('span', { class: 'mono', text: '已选 0 个' }, ft);
  const btn = el('div', { class: 'btn-primary', text: '导入', style: { width: (P ? 170 : 170) + 'px', height: (P ? 64 : 56) + 'px', fontSize: (P ? 28 : 26) + 'px' } }, ft);
  if (P) { segEl.style.display = 'none'; }
  const IMP = 87.0;
  cue(IMP, 'click');

  // 导进来变成一门课：黑板封面写着「申论」
  const ccR = P ? { x: 290, y: 640, w: 500, h: 520 } : { x: 760, y: 300, w: 400, h: 420 };
  const course = box(root, { ...ccR, cls: 'deckcard', style: { zIndex: 4 } });
  const covH = ccR.h * 0.56;
  const cov = box(course, { x: 0, y: 0, w: ccR.w, h: covH, cls: 'cov' });
  box(cov, { x: 0, y: covH / 2 - 60, w: ccR.w, h: 120, text: '申论', style: { fontFamily: 'var(--font-display)', fontSize: '84px', color: 'var(--chalk)', textAlign: 'center', letterSpacing: '0.1em', opacity: 0.92 } });
  el('div', { class: 'ledge3' }, cov);
  box(course, { x: 24, y: covH + 22, w: ccR.w - 48, h: 44, cls: 'ttl', text: '2027 申论系统班', style: { fontSize: '32px' } });
  box(course, { x: 24, y: covH + 76, w: ccR.w - 48, h: 36, cls: 'meta', text: '5 讲 · 已按讲次排好', style: { fontSize: '24px' } });
  const courseLines = [1, 2, 3, 4, 5].map((n, i) => box(course, { x: 24, y: covH + 124 + i * 0, w: ccR.w - 48, h: 30, cls: 'meta', text: '', style: { fontSize: '20px' } }));
  cue(IMP + 0.75, 'thud');

  // =============== 2. 按意思搜 ===============
  const sR = P ? { x: 50, y: 300, w: 980, h: 1240 } : { x: 230, y: 90, w: 1460, h: 900 };
  const panel = box(root, { ...sR, cls: 'paper-card', style: { zIndex: 5 } });
  const q = '为什么步子太大会来回跳';
  const sb = box(panel, { x: 36, y: 36, w: sR.w - 72, h: P ? 96 : 84, cls: 'search', style: { padding: '0 26px', fontSize: (P ? 36 : 34) + 'px', gap: '16px' } });
  el('span', { html: '<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="13" cy="13" r="9" fill="none" stroke="var(--text-muted)" stroke-width="3"/><path d="M20 20 L27 27" stroke="var(--text-muted)" stroke-width="3" stroke-linecap="round"/></svg>', style: { display: 'flex' } }, sb);
  const qText = el('span', { text: '' }, sb);
  const caret = el('span', { class: 'caret', style: { height: (P ? 40 : 36) + 'px' } }, sb);
  const tlines = [
    ['12:31', '我们先回顾一下，梯度指向的是上升最快的方向。'],
    ['12:39', '所以要往反方向走，每一步迈多大，由学习率决定。'],
    ['12:48', '学习率过大，参数就会在谷底两侧来回震荡，'],
    ['12:55', '甚至越走越远，损失不降反升。'],
    ['13:04', '实践里一般先从一个较小的值开始试。'],
  ];
  const tl0 = P ? 190 : 170;
  const tlH = P ? 150 : 92;
  const tEls = tlines.map(([tm, tx], i) => {
    const r = box(panel, { x: 36, y: tl0 + i * tlH, w: sR.w - 72, h: tlH, cls: 'tline', style: { gap: '28px', fontSize: (P ? 34 : 32) + 'px', lineHeight: 1.5, alignItems: 'baseline' } });
    const a = el('span', { class: 'tm', text: tm, style: { fontSize: '0.8em' } }, r);
    const b = el('span', { class: 'tx', html: `<span class="sent">${tx}</span>` }, r);
    return { r, a, b, sent: b.querySelector('.sent') };
  });
  const hitLb = box(panel, { x: 36, y: tl0 + tlines.length * tlH + 20, w: sR.w - 72, h: 44, cls: 'sans', html: '<span class="chip" style="font-size:24px">按意思找到 · 原话里没有你搜的这几个字</span>', style: { fontSize: '24px' } });
  const SQ0 = 88.9, SQ1 = SQ0 + [...q].length / 7.5;
  const HIT = SQ1 + 0.35;
  cue(SQ0, 'type', { dur: SQ1 - SQ0 });
  cue(HIT, 'chime');

  // =============== 3. 复习资料 ===============
  const bR = P ? { x: 50, y: 220, w: 980, h: 1480 } : { x: 160, y: 80, w: 1600, h: 920 };
  const book = box(root, { ...bR, cls: 'book', style: { zIndex: 6 } });
  const tocW = P ? 0 : 380;
  if (!P) {
    const toc = box(book, { x: 0, y: 0, w: tocW, h: bR.h, cls: 'toc', style: { padding: '40px 24px', fontSize: '26px' } });
    el('div', { class: 'serif', text: '复习资料', style: { fontSize: '34px', fontWeight: 600, color: 'var(--text-strong)', marginBottom: '28px', paddingLeft: '14px' } }, toc);
    ['第 1 章 梯度下降', '第 2 章 正则化', '第 3 章 神经网络', '第 4 章 优化器'].forEach((n, i) => el('div', { text: n, class: i === 0 ? 'on' : '', style: { padding: '12px 14px', marginBottom: '6px' } }, toc));
  }
  const cx0 = tocW + (P ? 50 : 70);
  box(book, { x: cx0, y: P ? 50 : 56, w: bR.w - cx0 - 60, h: 70, cls: 'sec-title', text: P ? '复习资料 · 第 1 章 梯度下降' : '第 1 章 梯度下降', style: { fontSize: (P ? 40 : 44) + 'px' } });
  box(book, { x: cx0, y: P ? 150 : 160, w: 600, h: 40, cls: 'sans', text: '要点', style: { fontSize: '26px', color: 'var(--text-muted)', fontWeight: 600 } });
  const pts = [
    ['梯度指向上升最快的方向，所以往反方向走', '03:12'],
    ['学习率太大会来回震荡，太小会收敛很慢', '12:48'],
    ['动量把上一步的方向带进这一步', '18:05'],
    ['给过大的权重一点惩罚，不容易过拟合', '24:30'],
    ['看损失曲线判断学习率合不合适', '31:02'],
  ];
  const ptH = P ? 150 : 96;
  const ptEls = pts.map(([tx, tm], i) => {
    const e = box(book, { x: cx0, y: (P ? 210 : 220) + i * ptH, w: bR.w - cx0 - 60, h: ptH, cls: 'pt', html: `<span style="flex:1">${tx}</span><span class="ts" style="font-size:0.82em;align-self:flex-start">${tm}</span>`, style: { fontSize: (P ? 36 : 34) + 'px', alignItems: 'baseline' } });
    return { e, ts: e.querySelector('.ts') };
  });
  const BK0 = 94.3;
  const ptT = pts.map((_, i) => BK0 + 0.7 + i * 0.42);
  ptT.forEach((t) => cue(t, 'tick'));
  const JUMP = 98.3;
  cue(JUMP, 'click');
  // 点一下时间戳：小窗里的视频跳到那一秒
  const pipR = P ? { x: 520, y: 1040, w: 460, h: 300 } : { x: 1080, y: 560, w: 520, h: 330 };
  const pip = box(book, { ...pipR, cls: 'lec', style: { boxShadow: 'var(--shadow-pop)', zIndex: 3 } });
  const pipT = box(pip, { x: 20, y: pipR.h - 64, w: 300, h: 40, cls: 'mono', text: '12:48', style: { fontSize: '30px', color: '#fff' } });
  const pipBar = box(pip, { x: 20, y: pipR.h - 18, w: pipR.w - 40, h: 4, cls: 'prog' });
  const pipFill = el('i', {}, pipBar);
  const pipHead = el('b', {}, pipBar);
  box(pip, { x: 26, y: 24, w: pipR.w - 52, h: 120, html: '<span style="font-family:var(--font-reading);font-size:30px;color:rgba(238,242,236,0.92);line-height:1.5">学习率过大，<br>参数就会在谷底两侧来回震荡</span>' });

  // =============== 4. 快 ===============
  const spd = box(root, { x: 0, y: 0, w: W, h: H, style: { zIndex: 8 } });
  const spLb = box(spd, { x: 0, y: H * (P ? 0.3 : 0.2), w: W, h: 60, cls: 'sans', text: '视频下载 · 启动用时', style: { fontSize: (P ? 44 : 42) + 'px', color: 'var(--text-muted)', textAlign: 'center' } });
  const spN = box(spd, { x: 0, y: H * (P ? 0.36 : 0.3), w: W, h: P ? 300 : 320, cls: 'big-num', text: '23.0 秒', style: { fontSize: (P ? 230 : 300) + 'px', textAlign: 'center', lineHeight: 1 } });
  const spSub = box(spd, { x: 0, y: H * (P ? 0.36 : 0.3) + (P ? 330 : 350), w: W, h: 50, cls: 'sans', text: 'Mac · Windows 上，打开下载器不用再等', style: { fontSize: (P ? 34 : 34) + 'px', color: 'var(--text-muted)', textAlign: 'center' } });
  const lines = [0, 1, 2, 3, 4, 5].map((i) => box(spd, { x: 0, y: 0, w: 300, h: 4, cls: 'speedline' }));
  const SP0 = 100.3, SLAM = 103.45;
  cue(SLAM - 0.4, 'riser', { dur: 0.4 });
  cue(SLAM, 'hit');
  cue(103.9, 'zip');

  // =============== 镜头 ===============
  ctx.cam(81.3, ctx.devCamAtPhone());
  ctx.cam(82.2, I.cam(W / 2, H / 2, 1.0));
  ctx.cam(84.8, I.cam(W / 2, H / 2, 1.0));
  ctx.cam(85.4, I.cam(P ? 540 : fx + dR.x + fw / 2 - 40, P ? 1100 : 560, P ? 1.12 : 1.18));
  ctx.cam(86.8, I.cam(P ? 540 : fx + dR.x + fw / 2 - 20, P ? 1120 : 580, P ? 1.12 : 1.18));
  ctx.cam(87.6, I.cam(W / 2, H / 2, 1.0));
  ctx.cam(91.0, I.cam(W / 2, P ? 900 : 500, 1.05));
  ctx.cam(93.6, I.cam(W / 2, P ? 900 : 480, 1.12));
  ctx.cam(94.6, I.cam(W / 2, H / 2, 1.0));
  ctx.cam(97.8, I.cam(W / 2, H / 2, 1.03));
  ctx.cam(98.6, I.cam(P ? 700 : 1200, P ? 1150 : 620, 1.15));
  ctx.cam(99.9, I.cam(P ? 700 : 1200, P ? 1150 : 620, 1.18));
  ctx.cam(100.6, I.cam(W / 2, H / 2, 1.0));
  ctx.cam(103.4, I.cam(W / 2, H / 2, 1.06));
  ctx.cam(103.55, I.cam(W / 2, H / 2, 1.0), ease.outExpo);
  ctx.cam(104.6, I.cam(W / 2, H / 2, 0.98));

  // =============== Clawd ===============
  const cbPos = (i) => ({ x: dR.x + fx + (P ? 19 : 17), y: dR.y + fy + 56 + i * rowH + rowH / 2 - (P ? 19 : 17) });
  const u = P ? 7.5 : 6.5;
  const btnPos = () => ({ x: dR.x + dR.w - 32 - 85, y: dR.y + dR.h - ftH / 2 - (P ? 32 : 28) });
  const keys = [
    { t: 81.2, x: () => ctx.devPhoneTopInI().x, y: () => ctx.devPhoneTopInI().y, u: P ? 9 : 6.5 },
    { t: 82.3, x: dR.x + dR.w - 120, y: dR.y, hop: 300, dur: 0.7, u, look: -0.5 },
    ...checkT.map((t, i) => ({ t: t - 0.02, x: cbPos(i).x, y: cbPos(i).y, hop: i === 0 ? 260 : 80, dur: i === 0 ? 0.55 : 0.28, u: P ? 5 : 4.2 })),
    { t: IMP - 0.02, x: btnPos().x, y: btnPos().y, hop: 220, dur: 0.4, u: P ? 6 : 5.5 },
    { t: IMP + 0.75, x: ccR.x + ccR.w / 2, y: ccR.y, hop: 260, dur: 0.6, u: P ? 8 : 7, spin: 1, wave: 0.8 },
    // 搜索：坐在搜索框的右端，往下看那句
    { t: SQ0 - 0.1, x: sR.x + sR.w - 120, y: sR.y + 36, hop: 220, dur: 0.6, u: P ? 7 : 6, look: -0.6 },
    { t: HIT + 0.9, x: sR.x + 36 + (P ? 140 : 140), y: sR.y + tl0 + 2 * tlH + (P ? 20 : 14), hop: 160, dur: 0.5, u: P ? 6 : 5, look: 1 },
    // 复习资料：跳上那条要点的时间戳，点下去
    { t: BK0 + 0.6, x: bR.x + bR.w - 200, y: bR.y, hop: 260, dur: 0.6, u: P ? 7 : 6 },
    { t: JUMP, x: () => tsPos(1).x, y: () => tsPos(1).y, hop: 200, dur: 0.5, u: P ? 5.5 : 4.8, look: -0.3 },
    { t: 99.8, x: bR.x + pipR.x + pipR.w / 2, y: bR.y + pipR.y, hop: 140, dur: 0.45, u: P ? 7 : 6, wave: 0.6 },
    // 快：站在大数字底下仰头看，数字砸下来时冲出画面，带着速度线
    { t: 100.7, x: W * 0.5, y: H * (P ? 0.72 : 0.84), hop: 260, dur: 0.6, u: P ? 9 : 8, look: 0 },
    { t: 103.75, x: W * 0.5, y: H * (P ? 0.72 : 0.84), u: P ? 9 : 8 },
    { t: 104.2, x: W + 300, y: H * (P ? 0.72 : 0.84), walk: true, dur: 0.45, u: P ? 9 : 8 },
  ];
  ctx.track(I, keys, 81.2, 104.25);
  function tsPos(i) {
    const e = ptEls[i];
    let x = 0, y = 0, n = e.ts;
    while (n && n !== book) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x: bR.x + x + e.ts.offsetWidth / 2, y: bR.y + y + 2 };
  }

  function update(t) {
    // ---- 导入 ----
    const dIn = ease.outCubic(prog(t, 81.2, 82.0));
    const ph = ctx.devPhoneRectInI();
    const sx = lerp(ph.w / dR.w, 1, dIn), sy = lerp(ph.h / dR.h, 1, dIn);
    const dx = lerp(ph.x + ph.w / 2 - (dR.x + dR.w / 2), 0, dIn), dy = lerp(ph.y + ph.h / 2 - (dR.y + dR.h / 2), 0, dIn);
    const imp = ease.inOut(prog(t, IMP + 0.15, IMP + 0.7));
    tf(dlg, { x: dx, y: dy, sx: sx * lerp(1, 0.6, imp), sy: sy * lerp(1, 0.6, imp), o: clamp(dIn * 3) * (1 - imp) });
    dlg.style.display = t < 81.15 || t > IMP + 0.8 ? 'none' : '';
    drvEls.forEach((d, i) => {
      const k = pop(t, driveT[i], 0.4);
      tf(d, { x: (1 - Math.min(1, k)) * -40, o: clamp(k * 3) });
      d.classList.toggle('sel', i === 0 && t > 84.75);
    });
    crumb.style.opacity = prog(t, 84.8, 85.0);
    rows.forEach((r, i) => {
      tf(r.r, { y: (1 - ease.outCubic(prog(t, 84.85 + i * 0.07, 85.25 + i * 0.07))) * 30, o: prog(t, 84.85 + i * 0.07, 85.1 + i * 0.07) });
      r.cb.classList.toggle('on', t > checkT[i]);
      r.cb.style.transform = `scale(${1 + 0.25 * Math.max(0, Math.exp(-12 * (t - checkT[i])) * (t > checkT[i] ? 1 : 0))})`;
    });
    const nSel = checkT.filter((x) => t > x).length;
    const gb = [0, 0.43, 0.84, 1.29, 1.75, 2.2][nSel];
    selTxt.textContent = nSel ? `已选 ${nSel} 个 · ${gb.toFixed(1)} GB` : '已选 0 个';
    btn.style.transform = `scale(${t > IMP && t < IMP + 0.15 ? 0.94 : 1})`;
    // 一门课
    const cIn = ease.outCubic(prog(t, IMP + 0.35, IMP + 0.85));
    const cOut = ease.inOut(prog(t, 88.3, 88.9));
    tf(course, { s: lerp(0.4, 1, cIn) * lerp(1, 1.3, cOut), o: clamp(cIn * 2) * (1 - cOut) });
    course.style.display = t > IMP + 0.3 && t < 89 ? '' : 'none';
    // ---- 搜索 ----
    const pIn = ease.outCubic(prog(t, 88.4, 89.0));
    const pOut = ease.inOut(prog(t, 94.2, 94.8));
    tf(panel, { s: lerp(0.92, 1, pIn) * lerp(1, 0.9, pOut), x: lerp(0, P ? 0 : -300, pOut), o: pIn * (1 - pOut) });
    panel.style.display = t > 88.3 && t < 95 ? '' : 'none';
    qText.textContent = typed(q, t, SQ0, 7.5);
    caret.style.opacity = t < SQ1 + 0.3 ? (Math.floor(t * 2.5) % 2 ? 0.2 : 1) : 0;
    tEls.forEach((e, i) => {
      const hit = i === 2;
      const dim = t > HIT ? (hit ? 1 : 0.38) : 1;
      e.r.style.opacity = dim * prog(t, 88.7 + i * 0.05, 89.0 + i * 0.05);
      if (hit) {
        const k = ease.outCubic(prog(t, HIT, HIT + 0.45));
        e.sent.style.background = k > 0 ? `linear-gradient(90deg, var(--accent-weak) ${k * 100}%, transparent ${k * 100}%)` : 'none';
        e.sent.style.borderRadius = '3px';
        e.a.classList.toggle('hl-tm', t > HIT);
      }
    });
    hitLb.style.opacity = prog(t, HIT + 0.3, HIT + 0.6);
    // ---- 复习资料 ----
    const bIn = ease.outCubic(prog(t, BK0, BK0 + 0.6));
    const bOut = ease.inOut(prog(t, 100.0, 100.5));
    tf(book, { x: lerp(P ? 0 : 300, 0, bIn), s: lerp(1, 0.9, bOut), o: bIn * (1 - bOut) });
    book.style.display = t > BK0 - 0.05 && t < 100.6 ? '' : 'none';
    ptEls.forEach((p, i) => {
      const k = ease.outCubic(prog(t, ptT[i], ptT[i] + 0.45));
      tf(p.e, { x: (1 - k) * -80, o: k });
    });
    const pressed = t > JUMP && t < JUMP + 0.2;
    ptEls[1].ts.style.transform = `scale(${pressed ? 0.9 : 1})`;
    ptEls[1].ts.style.boxShadow = t > JUMP ? '0 0 0 3px var(--accent-weak-2)' : 'none';
    const pk = pop(t, JUMP + 0.1, 0.45);
    tf(pip, { s: lerp(0.5, 1, Math.min(1, pk)), o: clamp(pk * 2) });
    const jp = ease.inOut(prog(t, JUMP + 0.3, JUMP + 0.8));
    pipFill.style.width = lerp(8, 41, jp) + '%';
    pipHead.style.left = lerp(8, 41, jp) + '%';
    pipT.textContent = jp < 0.98 ? '03:40 → 12:48' : '12:48';
    // ---- 快 ----
    const spIn = prog(t, SP0, SP0 + 0.4);
    spd.style.display = t > SP0 && t < 105.6 ? '' : 'none';
    spd.style.opacity = spIn * (1 - prog(t, 104.6, 105.2));
    spLb.style.opacity = prog(t, SP0 + 0.2, SP0 + 0.6);
    const n0 = pop(t, 101.6, 0.5);
    let val;
    if (t < SLAM - 0.35) val = 23.0;
    else val = lerp(23.0, 0.2, ease.inExpo(prog(t, SLAM - 0.35, SLAM)));
    spN.textContent = `${val.toFixed(1)} 秒`;
    const punch = t > SLAM ? 1 + 0.22 * Math.exp(-9 * (t - SLAM)) * Math.cos((t - SLAM) * 18) : 1;
    tf(spN, { s: lerp(0.6, 1, Math.min(1, n0)) * punch, o: clamp(n0 * 2) });
    spN.style.color = t > SLAM ? 'var(--accent-text)' : 'var(--text-strong)';
    spSub.style.opacity = prog(t, SLAM + 0.2, SLAM + 0.5);
    // 速度线跟着 Clawd
    lines.forEach((l, i) => {
      const k = prog(t, 103.7 + i * 0.02, 104.25 + i * 0.02);
      const x = lerp(W * 0.5 - 200, W + 200, ease.inOut(k)) - 260 - i * 40;
      tf(l, { x, y: H * (P ? 0.72 : 0.84) - 70 + i * 12, sx: 0.6 + (i % 3) * 0.25, o: k > 0 && k < 1 ? 0.7 : 0 });
    });
  }
  return { update };
}
