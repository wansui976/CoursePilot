// 0:17–0:37 翻卡复习 → 左滑忘了 / 右滑记得 → 记忆曲线 → 错题本 → 收集册
import { clamp, lerp, prog, ease, el, svg } from '../lib/core.js';
import { kf, tf, box, pop } from '../lib/scene.js';

export function buildReview(ctx) {
  const { R, portrait: P, BW, BH, cue } = ctx;
  const root = R.el;
  // 黑板背面那张卡在 R 里的位置：原生大小 BW×BH，缩放 1/s。
  const c0 = R.l(0, 0);
  const k0 = 1 / R.s;
  const kT = P ? 0.72 : 0.62; // 收小以后
  const cT = P ? { x: 540, y: 900 } : { x: 960, y: 560 };
  const qsz = P ? 74 : 76;

  const cards = [];
  const QS = [
    ['学习率过大时，梯度下降会出现什么现象？', '参数会在谷底两侧来回<b>震荡</b>，甚至发散，损失不降反升。'],
    ['动量法为什么能冲过小坑？', '它把上一步的方向带进这一步，像小球滚下山坡，<b>惯性</b>带着它越过局部的小起伏。'],
    ['L2 正则化在惩罚什么？', '惩罚<b>过大的权重</b>：把权重的平方和加进损失，让模型更平滑、不过拟合。'],
    ['学习率太小会怎样？', '每一步都迈得很小，<b>收敛很慢</b>，可能还没走到谷底训练就结束了。'],
  ];
  const rates = [['重来', '1 分钟', 'again'], ['困难', '6 小时', 'hard'], ['良好', '2 天', 'good'], ['容易', '5 天', 'easy']];

  // 叠在后面的从下往上建，第一张在最上面。
  for (let i = QS.length - 1; i >= 0; i--) {
    const [q, a] = QS[i];
    const c = el('div', { class: 'rc', style: { left: c0.x - BW / 2 + 'px', top: c0.y - BH / 2 + 'px', width: BW + 'px', height: BH + 'px' } }, root);
    const fa = el('div', { class: 'side a' }, c);
    el('div', { class: 'q', text: q, style: { fontSize: qsz + 'px', maxWidth: (P ? 800 : 1500) + 'px' } }, fa);
    el('div', { class: 'rule', style: { width: (P ? 760 : 1460) + 'px', margin: `${qsz * 0.9}px 0 ${qsz * 0.6}px` } }, fa);
    el('div', { class: 'sans', text: '点按翻面看答案', style: { fontSize: (P ? 36 : 34) + 'px', color: 'var(--text-faint)' } }, fa);
    const fb = el('div', { class: 'side b', style: { justifyContent: 'flex-start', paddingTop: (P ? 150 : 90) + 'px' } }, c);
    el('div', { class: 'q', text: q, style: { fontSize: (P ? 60 : 62) + 'px', maxWidth: (P ? 820 : 1500) + 'px' } }, fb);
    el('div', { class: 'rule', style: { width: (P ? 820 : 1500) + 'px', margin: `${P ? 50 : 44}px 0` } }, fb);
    el('div', { class: 'a', html: a, style: { fontSize: (P ? 44 : 44) + 'px', maxWidth: (P ? 820 : 1400) + 'px' } }, fb);
    let curve = null;
    if (i === 2) curve = memoryCurve(fb, P);
    else el('div', { class: 'links', html: '<span>↺ 回看出处</span><span class="muted">⌇ 记忆曲线</span>', style: { fontSize: (P ? 34 : 32) + 'px', marginTop: (P ? 60 : 44) + 'px' } }, fb);
    const row = el('div', { class: 'rates', style: { position: 'absolute', bottom: (P ? 110 : 70) + 'px', gap: (P ? 16 : 22) + 'px' } }, fb);
    const btns = rates.map(([n, d, k], j) => {
      const b = el('div', { class: `rate ${k}`, style: { width: (P ? 196 : 330) + 'px', height: (P ? 150 : 150) + 'px', fontSize: (P ? 34 : 38) + 'px' } }, row);
      el('span', { class: 'n', text: n }, b);
      el('span', { class: 'd', text: d }, b);
      el('span', { class: 'k', text: String(j + 1) }, b);
      return b;
    });
    const stamp = el('div', { class: 'stamp', style: { fontSize: (P ? 90 : 96) + 'px', top: (P ? 70 : 60) + 'px' } }, fb);
    const edge = el('div', { class: 'wrong-edge', style: { width: '18px' } }, fb);
    cards[i] = { c, fa, fb, btns, stamp, edge, curve };
  }

  // ---------- 时间 ----------
  const T = {
    shrink0: 18.6, shrink1: 19.5,
    fan0: 19.3, flip0: 20.15,
    forget: 21.75, adv1: 22.35, remember: 23.0, adv2: 23.55, curve0: 24.2,
    adv3: 27.05, again: 27.85, toBook: 28.35, inBook: 29.0,
    open0: 29.9, open1: 30.9,
  };
  cue(T.flip0, 'flip');
  cue(T.forget, 'swipe');
  cue(T.remember, 'swipe');
  cue(T.adv2 + 0.25, 'flip');
  cue(T.adv3 + 0.4, 'flip');
  cue(T.again, 'click');
  cue(T.toBook, 'whoosh', { dur: 0.6 });
  cue(T.inBook, 'thud');
  cue(T.open0, 'page');

  // ---------- 错题本 ----------
  const wbR = P ? { x: 640, y: 1500, w: 380, h: 300 } : { x: 1500, y: 700, w: 340, h: 280 };
  const wb = box(root, { ...wbR, cls: 'wb' });
  box(wb, { x: 0, y: 0, w: 16, h: wbR.h, cls: 'spine' });
  box(wb, { x: 44, y: 34, w: 280, h: 60, cls: 'title', text: '错题本', style: { fontSize: '44px' } });
  const wbCount = box(wb, { x: 44, y: 120, w: 280, h: 90, cls: 'count', text: '8', style: { fontSize: '84px' } });
  box(wb, { x: 44, y: 216, w: 300, h: 40, cls: 'sub', text: '道题 · 只复习错题', style: { fontSize: '24px' } });

  // ---------- 收集册 ----------
  const cR = P ? { x: 60, y: 300, w: 960, h: 1360 } : { x: 170, y: 120, w: 1580, h: 860 };
  const coll = box(root, { ...cR, cls: 'coll' });
  const pad = P ? 56 : 64;
  box(coll, { x: pad, y: pad - 6, w: cR.w - pad * 2, h: 60, cls: 'sec-title', text: '收集册', style: { fontSize: (P ? 46 : 44) + 'px' } });
  const stats = [['5', '/ 8', '已点亮'], ['1', '', '正在褪色'], ['2', '', '还没出过题']];
  const statEls = stats.map(([n, d, l], i) => {
    const s = box(coll, { x: pad + i * (P ? 290 : 300), y: pad + 90, w: 280, h: 120, cls: 'stat', html: `<span class="sn">${n}</span><span style="font-size:0.5em;color:var(--text-muted)"> ${d}</span><small>${l}</small>`, style: { fontSize: (P ? 78 : 74) + 'px' } });
    return s;
  });
  const topics = ['梯度下降', '学习率', '动量', '正则化', '过拟合', '反向传播', '交叉熵', '批归一化'];
  const cols = P ? 2 : 4;
  const gx = P ? 24 : 26;
  const mbW = (cR.w - pad * 2 - gx * (cols - 1)) / cols;
  const mbH = P ? 210 : 220;
  const gy0 = pad + (P ? 260 : 250);
  const boards = topics.map((name, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const x = pad + c * (mbW + gx), y = gy0 + r * (mbH + (P ? 26 : 26));
    const b = box(coll, { x, y, w: mbW, h: mbH, cls: 'mb' });
    const nm = box(b, { x: 28, y: 34, w: mbW - 56, h: 60, cls: 'nm', text: name, style: { fontSize: (P ? 44 : 42) + 'px' } });
    const bar = box(b, { x: 28, y: mbH - 54, w: mbW - 56, h: 4, cls: 'bar' });
    const fill = el('i', {}, bar);
    const tag = box(b, { x: mbW - 170, y: 40, w: 150, h: 36, cls: 'tag', text: '该复习了', style: { fontSize: '24px', width: 'auto', left: 'auto', right: '24px', opacity: 0 } });
    box(b, { x: 0, y: mbH - 6, w: mbW, h: 6, cls: 'ledge2' });
    return { b, nm, fill, tag, x: x + cR.x, y: y + cR.y };
  });
  // 点亮的顺序和时间：Clawd 跳到哪块，哪块亮。
  const lightOrder = [0, 1, 2, 5, 3];
  const lightT = [31.3, 31.85, 32.4, 32.95, 33.5];
  const fadeIdx = 3; // 正则化：亮过又慢慢褪色
  const fadeT = 34.6;
  lightT.forEach((tt) => cue(tt, 'chime'));

  // 去课桌：收集册缩进课桌右边那一格。
  const D0 = 36.5, D1 = 37.6;

  // ---------- Clawd ----------
  const cardTop = (t) => cardPose(t, 0).y - (BH / 2) * cardPose(t, 0).k;
  const u0 = 14.4 / R.s; // 开场落地时的大小换算到局部
  const keys = [
    { t: 18.6, x: () => ctx.clawdLanding().x, y: () => ctx.clawdLanding().y, u: u0 },
    { t: 19.5, x: (t) => cardPose(t, 0).x + (P ? 220 : 380) * cardPose(t, 0).k, y: cardTop, u: P ? 11 : 10, hop: 0, walk: true, dur: 0.9 },
    // 跳到卡片右侧，把它推向左边
    { t: T.forget - 0.05, x: (t) => cardPose(t, 0).x + (BW / 2) * cardPose(t, 0).k + 70, y: cT.y + (P ? 470 : 230), u: P ? 11 : 10, hop: 160, dur: 0.45, look: -1 },
    // 换到左边，把下一张推向右边
    { t: T.remember - 0.05, x: (t) => cT.x - (BW / 2) * kT - 70, y: cT.y + (P ? 470 : 230), hop: 220, dur: 0.5, spin: 1, look: 1 },
    // 跳上记忆曲线的起点，顺着曲线滑下去
    { t: T.curve0 + 0.5, x: () => curvePt(0).x, y: () => curvePt(0).y, hop: 200, dur: 0.5, u: P ? 7 : 6.5 },
    { t: T.curve0 + 2.6, x: () => curvePt(1).x, y: () => curvePt(1).y, u: P ? 7 : 6.5, walk: true, dur: 2.0 },
    // 跳回卡片上沿，看着这道题
    { t: T.adv3 + 0.3, x: (t) => cT.x + 200 * kT * 2, y: () => cT.y - (BH / 2) * kT, hop: 220, dur: 0.5, u: P ? 10 : 9.5, look: -0.5 },
    // 跳到错题本上
    { t: T.inBook + 0.35, x: wbR.x + wbR.w / 2, y: wbR.y, hop: 260, dur: 0.6, u: P ? 10 : 9.5, look: -0.6 },
    // 收集册：一块一块跳过去点亮
    ...lightOrder.map((bi, j) => ({ t: lightT[j], x: () => boardTopCenter(bi).x, y: () => boardTopCenter(bi).y, hop: 120, dur: 0.42, u: P ? 7.5 : 7 })),
    { t: 35.4, x: () => boardTopCenter(7).x, y: () => boardTopCenter(7).y, hop: 120, dur: 0.5, u: P ? 7.5 : 7, wave: 0.8 },
  ];
  ctx.track(R, keys, 18.6, 37.4);

  // 镜头
  ctx.cam(18.6, R.cam(960, 540, 1));
  ctx.cam(20.0, R.cam(cT.x, cT.y + 20, P ? 1.08 : 1.1));
  ctx.cam(24.0, R.cam(cT.x, cT.y + 20, P ? 1.08 : 1.1));
  ctx.cam(25.2, R.cam(cT.x, cT.y + (P ? 260 : 120), P ? 1.25 : 1.3));
  ctx.cam(26.8, R.cam(cT.x, cT.y + (P ? 260 : 120), P ? 1.25 : 1.3));
  ctx.cam(27.6, R.cam(P ? 620 : 1060, P ? 1050 : 600, 1.0));
  ctx.cam(29.4, R.cam(P ? 640 : 1180, P ? 1200 : 640, 1.08));
  ctx.cam(30.9, R.cam(960 * (P ? 0.5625 : 1), P ? 960 : 545, 1.0));
  ctx.cam(36.3, R.cam(P ? 540 : 960, P ? 980 : 550, P ? 1.04 : 1.03));

  // ---------- 每一帧 ----------
  function cardPose(t, i) {
    // 第一张：收小 → 左滑；后面的：扇开、依次上前
    const idx = i - (t > T.adv1 ? 1 : 0) - (t > T.adv2 ? 1 : 0) - (t > T.adv3 ? 1 : 0);
    let k = kf(t, [[T.shrink0, k0], [T.shrink1, kT]]);
    let x = kf(t, [[T.shrink0, c0.x], [T.shrink1, cT.x]]);
    let y = kf(t, [[T.shrink0, c0.y], [T.shrink1, cT.y]]);
    if (i > 0) {
      const fan = ease.outCubic(prog(t, T.fan0 + i * 0.12, T.fan0 + 0.6 + i * 0.12));
      const back = Math.max(0, idx);
      const advT = [0, T.adv1, T.adv2, T.adv3][i];
      const adv = ease.outCubic(prog(t, advT, advT + 0.4));
      const depth = lerp(back + (t > advT ? 1 : 0), back, adv);
      k = kT * (1 - 0.05 * depth) * lerp(0.9, 1, fan);
      x = cT.x + depth * (P ? 0 : 16);
      y = cT.y - depth * (P ? 34 : 30) * fan;
      return { x, y, k, r: 0, o: fan, ry: 0, z: -depth };
    }
    return { x, y, k, r: 0, o: 1, ry: 0, z: 0 };
  }
  function curvePt(which) {
    const cp = cardPose(T.curve0 + 0.5, 2);
    const p = cards[2].curve.pts[which === 0 ? 0 : cards[2].curve.pts.length - 1];
    return { x: cp.x + (p.x - BW / 2) * cp.k, y: cp.y + (p.y - BH / 2) * cp.k };
  }
  function boardTopCenter(i) {
    const b = boards[i];
    return { x: b.x + mbW / 2, y: b.y + 4 };
  }

  function update(t) {
    // 卡片
    cards.forEach((cd, i) => {
      const p = cardPose(t, i);
      let { x, y, k } = p;
      let r = 0, o = p.o, flip = 0;
      if (i === 0) flip = ease.inOut(prog(t, T.flip0, T.flip0 + 0.65));
      else {
        const advT = [0, T.adv1, T.adv2, T.adv3][i];
        flip = ease.inOut(prog(t, advT + 0.2, advT + 0.6));
      }
      // 滑走
      const swipe = [[T.forget, -1], [T.remember, 1], [99, 0], [99, 0]][i];
      const sp = ease.inCubic(prog(t, swipe[0], swipe[0] + 0.55));
      if (sp > 0) {
        x += swipe[1] * sp * (P ? 1300 : 1800);
        y += sp * 80;
        r = swipe[1] * sp * 18;
      }
      // 错题：收小飞进错题本
      if (i === 3) {
        const fp = ease.inOut(prog(t, T.toBook, T.inBook));
        if (fp > 0) {
          x = lerp(x, wbR.x + wbR.w / 2, fp);
          y = lerp(y, wbR.y + wbR.h / 2, fp);
          k = lerp(k, 0.06, fp);
          r = -10 * Math.sin(Math.PI * fp);
          o = 1 - prog(t, T.inBook - 0.1, T.inBook);
        }
      }
      const gone = (i === 0 && t > T.forget + 0.6) || (i === 1 && t > T.remember + 0.6) || (i === 2 && t > T.adv3 + 0.3) || (i === 3 && t > T.inBook);
      cd.c.style.display = gone ? 'none' : '';
      cd.c.style.zIndex = String(20 + Math.round(p.z * 2));
      tf(cd.c, { x: x - c0.x, y: y - c0.y, s: k, r, ry: flip * 180, o, persp: 3200 });
      // 印章
      const stp = i === 0 ? pop(t, T.forget - 0.05, 0.35) : i === 1 ? pop(t, T.remember - 0.05, 0.35) : 0;
      if (stp > 0) {
        cd.stamp.textContent = i === 0 ? '忘了' : '记得';
        cd.stamp.className = 'stamp ' + (i === 0 ? 'forget' : 'remember');
        cd.stamp.style[i === 0 ? 'right' : 'left'] = '70px';
        cd.stamp.style.transform = `rotate(${i === 0 ? 12 : -12}deg) scale(${lerp(1.6, 1, Math.min(1, stp))})`;
        cd.stamp.style.opacity = Math.min(1, stp);
      } else cd.stamp.style.opacity = 0;
      // 评分键
      const press = i === 0 ? (t > T.forget - 0.25 ? 0 : -1) : i === 1 ? (t > T.remember - 0.25 ? 2 : -1) : i === 2 ? (t > T.curve0 + 2.4 ? 2 : -1) : i === 3 ? (t > T.again ? 0 : -1) : -1;
      cd.btns.forEach((b, j) => {
        b.classList.toggle('on', press === j && j !== 0);
        b.classList.toggle('press-again', press === j && j === 0);
      });
      cd.edge.style.opacity = i === 3 ? prog(t, T.again, T.again + 0.2) : 0;
      if (cd.curve) cd.curve.update(t - T.curve0);
    });

    // 错题本
    const wbIn = ease.outCubic(prog(t, T.adv3 + 0.4, T.adv3 + 1.0));
    const bump = t > T.inBook ? Math.exp(-7 * (t - T.inBook)) * Math.sin((t - T.inBook) * 30) * 0.06 : 0;
    wbCount.textContent = t > T.inBook ? '9' : '8';
    // 打开成收集册
    const op = ease.inOut(prog(t, T.open0, T.open1));
    const wbTo = { x: cR.x + cR.w / 2 - (wbR.x + wbR.w / 2), y: cR.y + cR.h / 2 - (wbR.y + wbR.h / 2) };
    tf(wb, { x: wbTo.x * op, y: (1 - wbIn) * 400 + wbTo.y * op, s: (1 + bump) * lerp(1, cR.w / wbR.w, op), o: wbIn * (1 - prog(t, T.open0, T.open0 + 0.22)) });
    wb.style.zIndex = 30;

    const collIn = prog(t, T.open0, T.open0 + 0.25);
    const collK = lerp(wbR.w / cR.w, 1, op);
    // 课桌：缩到右边那一格
    const dk = ease.camera(prog(t, D0, D1));
    const tgt = ctx.deskSlot(); // R 局部坐标里的目标框
    const cx = lerp(cR.x + cR.w / 2, tgt.x + tgt.w / 2, dk) - (cR.x + cR.w / 2);
    const cy = lerp(cR.y + cR.h / 2, tgt.y + tgt.h / 2, dk) - (cR.y + cR.h / 2);
    const lerpOp = (a, b) => lerp(a, b, op);
    tf(coll, {
      x: lerpOp(wbR.x + wbR.w / 2 - (cR.x + cR.w / 2), 0) + cx,
      y: lerpOp(wbR.y + wbR.h / 2 - (cR.y + cR.h / 2), 0) + cy,
      s: collK * lerp(1, tgt.w / cR.w, dk),
      o: collIn * (1 - prog(t, D1 - 0.35, D1)),
    });
    coll.style.zIndex = 31;
    // 点亮
    boards.forEach((b, i) => {
      const j = lightOrder.indexOf(i);
      let lit = j >= 0 ? ease.outCubic(prog(t, lightT[j] - 0.02, lightT[j] + 0.35)) : 0;
      if (i === fadeIdx) lit *= lerp(1, 0.28, ease.inOut(prog(t, fadeT, fadeT + 1.4)));
      b.nm.style.opacity = lerp(0.22, 1, lit);
      b.nm.style.textShadow = lit > 0.5 ? `0 0 ${18 * lit}px rgba(238,242,236,${0.35 * lit})` : 'none';
      b.b.style.boxShadow = `inset 0 0 0 ${lit > 0.02 ? 2 : 1}px rgba(238,242,236,${0.05 + 0.4 * lit})`;
      b.fill.style.width = `${lit * (i === 5 ? 64 : i === 3 ? 100 : 86)}%`;
      b.tag.style.opacity = i === fadeIdx ? prog(t, fadeT + 0.9, fadeT + 1.2) : 0;
    });
    const litNow = lightT.filter((x) => t >= x).length;
    statEls[0].querySelector('.sn').textContent = String(Math.max(1, litNow + (t > lightT[4] ? 1 : 0)));
    statEls[1].querySelector('.sn').textContent = t > fadeT + 0.9 ? '1' : '0';
  }

  return { update };
}

/** 记忆曲线：每次复习把记忆拉回顶端，往后掉得越来越慢；最后一个点是「2 天后」。 */
function memoryCurve(parent, P) {
  const w = P ? 820 : 1300, h = P ? 330 : 260;
  const wrap = el('div', { style: { position: 'relative', width: w + 'px', height: h + 'px', marginTop: (P ? 40 : 26) + 'px' } }, parent);
  const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, style: 'position:absolute;left:0;top:0;overflow:visible' }, wrap);
  const L = 70, Rr = w - 30, T = 20, B = h - 50;
  svg('line', { x1: L, y1: B, x2: Rr, y2: B, stroke: 'var(--border-strong)', 'stroke-width': 2 }, s);
  svg('line', { x1: L, y1: T, x2: L, y2: B, stroke: 'var(--border-strong)', 'stroke-width': 2 }, s);
  const days = [0, 1, 3, 7, 16];
  const X = (d) => L + (d / 18) * (Rr - L);
  const Y = (r) => B - r * (B - T);
  const pts = [];
  for (let seg = 0; seg < days.length; seg++) {
    const d0 = days[seg], d1 = seg + 1 < days.length ? days[seg + 1] : 18;
    const tau = [0.9, 2.2, 5, 11, 26][seg];
    for (let k = 0; k <= 24; k++) {
      const d = d0 + ((d1 - d0) * k) / 24;
      pts.push({ x: X(d), y: Y(Math.exp(-(d - d0) / tau)) });
    }
  }
  const dStr = 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
  const path = svg('path', { d: dStr, fill: 'none', stroke: 'var(--accent-text)', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, s);
  const len = path.getTotalLength();
  path.setAttribute('stroke-dasharray', `${len} ${len}`);
  const dots = days.map((d, i) => {
    const c = svg('circle', { cx: X(d), cy: Y(1), r: 8, fill: i === 1 ? 'var(--accent)' : 'var(--surface-card)', stroke: 'var(--accent-text)', 'stroke-width': 3 }, s);
    const lb = svg('text', { x: X(d), y: B + 36, 'text-anchor': 'middle', 'font-family': 'JetBrains Mono Variable', 'font-size': P ? 24 : 22, fill: 'var(--text-muted)' }, s);
    lb.textContent = d === 0 ? '今天' : `${d} 天`;
    return { c, lb };
  });
  const pill = el('div', { class: 'badge', text: '下次复习 · 2 天后', style: { position: 'absolute', left: X(1) + 26 + 'px', top: T - 6 + 'px', fontSize: (P ? 30 : 28) + 'px' } }, wrap);
  // 曲线在卡片里的位置（卡片原生坐标），Clawd 要从顶点顺着第一段往下滑。
  let x = 0, y = 0, n = wrap;
  while (n && !n.classList.contains('rc')) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  const api = {
    pts: [{ x: x + X(0), y: y + Y(1) - 4 }, { x: x + X(1) - 6, y: y + Y(Math.exp(-1 / 0.9)) - 4 }],
    update(lt) {
      const k = clamp(lt / 1.4);
      path.setAttribute('stroke-dashoffset', String(len * (1 - ease.inOut(k))));
      dots.forEach((d, i) => {
        const shown = k >= days[i] / 18 ? 1 : 0;
        d.c.setAttribute('opacity', shown);
        d.lb.setAttribute('opacity', shown);
      });
      const pp = pop(lt, 1.6, 0.4);
      pill.style.opacity = Math.min(1, pp);
      pill.style.transform = `scale(${lerp(0.6, 1, Math.min(1, pp))})`;
    },
  };
  return api;
}
