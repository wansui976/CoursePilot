// CoursePilot 0.4.2 / 0.4.3 宣传片。一镜到底：画面只由 t 决定，seek(t) 就是那一帧。
import { clamp, lerp, prog, ease, spring, wobble, rng, noise1, svg, el, cue, events } from './lib/core.js';
import { loadHanzi, loadLineFont, grainCanvas, ChalkWriter, Dust } from './lib/chalk.js';
import { Clawd } from './lib/clawd.js';
import { Scene, camLerp } from './lib/scene.js';
import { clawdAt, cueTrack } from './lib/track.js';
import { buildReview } from './scenes/review.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export async function build(stage, A) {
  const { W, H, portrait } = A;
  const narration = (await (await fetch('script/narration.json')).json()).lines;
  await loadHanzi('学而时习之论语');
  const script = await loadLineFont('EMSAllure');
  const plain = await loadLineFont('EMSReadability');
  const allText = narration.map((l) => l.sub).join('') + '学习率过大时，梯度下降会出现什么现象？点按翻面看答案';
  await Promise.all([
    document.fonts.load('500 40px "Noto Serif SC"', allText),
    document.fonts.load('700 40px "Noto Serif SC"', allText),
    document.fonts.load('400 40px "Noto Sans SC"', allText),
    document.fonts.load('500 40px "Noto Sans SC"', allText),
    document.fonts.load('500 40px "Newsreader Variable"', 'CoursePilot'),
    document.fonts.load('500 40px "Instrument Sans Variable"', 'CoursePilot Wi-Fi Mac'),
    document.fonts.load('500 40px "JetBrains Mono Variable"', '0123456789:.'),
  ]);
  await document.fonts.ready;

  // ---------- 舞台 ----------
  const paper = css('--surface-app');
  const world = el('div', { class: 'world' }, stage);
  const persp = el('div', { class: 'abs', style: { perspective: '2600px', transformStyle: 'preserve-3d' } }, world);

  const BW = portrait ? 990 : 1760;
  const BH = portrait ? 1640 : 990;
  const board3d = el('div', { class: 'board3d', style: { left: -BW / 2 + 'px', top: -BH / 2 + 'px', width: BW + 'px', height: BH + 'px' } }, persp);
  const front = el('div', { class: 'face' }, board3d);
  const back = el('div', { class: 'face back' }, board3d);

  const surface = el('div', { class: 'board-surface' }, front);
  surface.style.backgroundImage = `url(${boardTexture(BW, BH)})`;
  const sheen = el('div', { class: 'layer', style: { borderRadius: '6px', overflow: 'hidden' } }, front);
  const sheenBar = el('div', { class: 'abs', style: { width: '60%', height: '100%', background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.045) 45%, rgba(255,255,255,0.07) 50%, rgba(255,255,255,0.045) 55%, transparent)' } }, sheen);

  const ledge = el('div', { class: 'ledge', style: { top: BH - 8 + 'px' } }, front);
  // 槽里放一截备用粉笔和板擦。
  // 粉笔层：一张画布。推近时放大到 1.3 倍左右，按 1.5 倍分辨率画。
  const RES = 1.5;
  const CH = BH + 120;
  const chalkCanvas = el('canvas', { width: Math.round(BW * RES), height: Math.round(CH * RES), style: { position: 'absolute', left: 0, top: 0, width: BW + 'px', height: CH + 'px' } }, front);
  const cctx = chalkCanvas.getContext('2d');
  const grainC = grainCanvas(chalkCanvas.width, chalkCanvas.height);
  const propsSVG = svg('svg', { width: BW, height: BH + 120, viewBox: `${-BW / 2} ${-BH / 2} ${BW} ${BH + 120}`, style: 'position:absolute;left:0;top:0;overflow:visible' }, front);

  // ---------- 1. 学而时习之 ----------
  const main = new ChalkWriter({ seed: 3 });
  const size = portrait ? 200 : 212;
  const gap = portrait ? 1.12 : 1.14;
  const span = 5 * size * gap - size * (gap - 1);
  const mainRes = portrait
    ? main.addHan('学而时习之', { x: -size / 2, y: -span / 2 - 150, size, gap, dir: 'v', t0: 0.75, speed: 3000, overhead: 0.022, strokeGap: 0.022 })
    : main.addHan('学而时习之', { x: -span / 2, y: -size / 2 - 50, size, gap, dir: 'h', t0: 0.75, speed: 3000, overhead: 0.022, strokeGap: 0.022 });
  const boxes = mainRes.boxes;

  // 出处：一道短横 + 「论语」。
  const attr = new ChalkWriter({ seed: 5 });
  const asz = portrait ? 74 : 66;
  if (portrait) {
    const ax = size / 2 + 70;
    const ay = span / 2 - 150 - asz * 2.2;
    attr.addStroke([{ x: ax + asz / 2, y: ay - 70 }, { x: ax + asz / 2 + 2, y: ay - 18 }], { t0: 4.2, dur: 0.16, width: 6 });
    attr.addHan('论语', { x: ax, y: ay, size: asz, gap: 1.1, dir: 'v', t0: 4.4, speed: 2000, charGap: 0.06 });
  } else {
    const ax = span / 2 - asz * 2.2;
    const ay = size / 2 + 10;
    attr.addStroke([{ x: ax - 92, y: ay + asz * 0.52 }, { x: ax - 22, y: ay + asz * 0.5 }], { t0: 4.2, dur: 0.16, width: 6 });
    attr.addHan('论语', { x: ax, y: ay, size: asz, gap: 1.1, t0: 4.4, speed: 2000, charGap: 0.06 });
  }

  // 「学」「习」各圈一下，跟着旁白落在那个字上。
  const loops = new ChalkWriter({ seed: 9 });
  const ring = (b, t0, seed) =>
    loops.addLoop({ cx: b.x + size / 2, cy: b.y + size * 0.47, rx: size * 0.66, ry: size * 0.6, t0, dur: 0.42, width: 7.5, seed });
  ring(boxes[0], 8.55, 2);
  ring(boxes[3], 10.25, 6);

  // ---------- 2. 板擦 ----------
  const ERASE0 = 11.05;
  const ERASE1 = 11.95;
  const zig = [];
  if (portrait) {
    const xs = [-330, -230, -130, -30, 70, 170, 270, 360];
    xs.forEach((x, i) => zig.push({ x, y: i % 2 ? 760 : -840 }));
  } else {
    const ys = [-280, -185, -90, 5, 100, 195, 290];
    ys.forEach((y, i) => zig.push({ x: i % 2 ? -800 : 800, y }));
  }
  const zigLen = zig.reduce((s, p, i) => (i ? s + Math.hypot(p.x - zig[i - 1].x, p.y - zig[i - 1].y) : 0), 0);
  const wipe = new Path2D();
  zig.forEach((p, i) => (i ? wipe.lineTo(p.x, p.y) : wipe.moveTo(p.x, p.y)));
  const eraser = svg('g', {}, propsSVG);
  svg('rect', { x: -125, y: -42, width: 250, height: 84, rx: 8, fill: css('--eraser') }, eraser);
  svg('rect', { x: -125, y: 20, width: 250, height: 22, rx: 5, fill: '#cfc9bd', opacity: 0.85 }, eraser);
  svg('rect', { x: -116, y: -37, width: 232, height: 8, rx: 4, fill: 'rgba(255,255,255,0.12)' }, eraser);
  cue(ERASE0, 'erase', { dur: ERASE1 - ERASE0 });
  cue(10.85, 'riser', { dur: 1.2 });
  cue(12.05, 'hit');

  // ---------- 3. CoursePilot ----------
  const logo = new ChalkWriter({ seed: 21 });
  let lsz = portrait ? 300 : 380;
  let lw = ChalkWriter.measureLine('CoursePilot', script, lsz);
  const maxW = BW * (portrait ? 0.74 : 0.7);
  if (lw > maxW) { lsz *= maxW / lw; lw = maxW; }
  const base = portrait ? -40 : 40;
  const logoRes = logo.addLine('CoursePilot', script, { x: -lw / 2, y: base, size: lsz, t0: 12.05, width: portrait ? 9 : 10.5, speed: 4300, overhead: 0.012, strokeGap: 0.008, charGap: 0.01 });
  const vsz = portrait ? 120 : 128;
  const vw = ChalkWriter.measureLine('0.4.3', plain, vsz, 6);
  const vx = lw / 2 - vw;
  const vy = base + (portrait ? 190 : 175);
  const verRes = logo.addLine('0.4.3', plain, { x: vx, y: vy, size: vsz, t0: logoRes.t1 + 0.12, width: 7, speed: 1800, tracking: 6 });
  logo.addStroke([{ x: vx - 10, y: vy + 26 }, { x: vx + vw * 0.5, y: vy + 30 }, { x: vx + vw + 14, y: vy + 24 }], { t0: verRes.t1 + 0.05, dur: 0.22, width: 6 });
  const LOGO_DONE = logo.t1;

  // ---------- 粉笔头 ----------
  const stick = svg('g', {}, propsSVG);
  svg('rect', { x: -4, y: -8, width: 74, height: 16, rx: 6, fill: '#e9ede6' }, stick);
  svg('rect', { x: -4, y: -8, width: 12, height: 16, rx: 5, fill: '#ffffff' }, stick);
  svg('rect', { x: 10, y: 3, width: 58, height: 4, rx: 2, fill: 'rgba(0,0,0,0.08)' }, stick);
  const writers = [main, attr, loops, logo];
  // 粉笔出场的几个时段（之外淡出），以及不写时停的位置。
  const stickWindows = [
    [0.45, attr.t1 + 0.25],
    [8.3, loops.t1 + 0.3],
    [11.9, LOGO_DONE + 0.25],
  ];

  const dust = new Dust(13);
  for (const w of writers) dust.fromWriter(w, { rate: 30 });
  for (let i = 1; i < zig.length; i++) {
    const tt = ERASE0 + ((ERASE1 - ERASE0) * i) / (zig.length - 1);
    dust.burst(tt, zig[i].x * 0.92, zig[i].y * 0.92, 34, 3);
  }

  // ---------- 4. 卡片（黑板翻过来） ----------
  const card = el('div', { class: 'card' }, back);
  const qsz = portrait ? 74 : 76;
  el('div', { class: 'q', text: '学习率过大时，梯度下降会出现什么现象？', style: { fontSize: qsz + 'px', maxWidth: (portrait ? 800 : 1500) + 'px' } }, card);
  el('div', { class: 'rule', style: { width: (portrait ? 760 : 1460) + 'px', margin: `${qsz * 0.9}px 0 ${qsz * 0.6}px` } }, card);
  el('div', { class: 'hint', text: '点按翻面看答案', style: { fontSize: (portrait ? 36 : 34) + 'px' } }, card);

  // ---------- Clawd ----------
  const clawdSVG = svg('svg', { width: 8000, height: 8000, viewBox: '-4000 -4000 8000 8000', style: 'position:absolute;left:-4000px;top:-4000px;overflow:visible' }, world);
  const ledgeTop = BH / 2 - 8;
  // 后面各场景的容器放在 Clawd 下面一层。
  const scenesLayer = el('div', { class: 'abs' });
  world.insertBefore(scenesLayer, clawdSVG);
  const cdefs = svg('defs', {}, clawdSVG);
  const cclip = svg('clipPath', { id: 'aboveLedge', clipPathUnits: 'userSpaceOnUse' }, cdefs);
  const cclipRect = svg('rect', { x: -4000, y: -4000, width: 8000, height: 4000 + ledgeTop }, cclip);
  const clawdG = svg('g', { 'clip-path': 'url(#aboveLedge)' }, clawdSVG);
  const clawd = new Clawd(clawdG, { unit: 9 });
  const CX0 = BW / 2 - (portrait ? 190 : 260);
  const CX1 = BW / 2 - (portrait ? 230 : 340);
  const CY1 = -BH / 2 - 1;
  const POP = 12.95;
  const CROUCH = 15.7;
  const JUMP = 15.95;
  const LAND = 17.38;
  cue(POP, 'pop');
  cue(14.55, 'chirp');
  cue(JUMP, 'jump');
  cue(LAND, 'land');

  // ---------- 翻面 ----------
  const FLIP0 = 16.25;
  const FLIP1 = 17.35;
  cue(FLIP0, 'whoosh', { dur: FLIP1 - FLIP0 });

  // ---------- 屏幕层：暗角、胶片颗粒、字幕、黑场 ----------
  const vignette = el('div', { class: 'layer', style: { background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)' } }, stage);
  const grain = el('div', { class: 'layer', style: { backgroundImage: `url(${grainTile()})`, mixBlendMode: 'overlay', opacity: 0.09 } }, stage);
  const subsBox = el('div', { class: 'subs', style: { bottom: (portrait ? 290 : 64) + 'px' } }, stage);
  const subsSpan = el('span', { style: { fontSize: (portrait ? 44 : 40) + 'px' } }, subsBox);
  if (!A.subs) subsBox.style.display = 'none';
  const black = el('div', { class: 'layer', style: { background: '#000' } }, stage);

  const zFill = Math.max(W / BW, H / BH);

  function camera(t) {
    let z, cx, cy, r = 0;
    if (t < 11.0) {
      z = zFill * (portrait ? lerp(1.0, 1.05, ease.inOut(prog(t, 0, 11))) : lerp(1.1, 1.2, ease.inOut(prog(t, 0, 11))));
      const k = ease.inOut(prog(t, 0.6, 4.2));
      cx = portrait ? 0 : lerp(-50, 40, k);
      cy = portrait ? lerp(-120, -40, k) : lerp(-10, 10, k);
    } else if (t < 15.0) {
      const k = ease.inOut(prog(t, 11.0, 12.4));
      const k2 = ease.inOut(prog(t, 12.6, 14.2));
      z = zFill * lerp(lerp(portrait ? 1.05 : 1.2, portrait ? 1.02 : 1.09, k), 1.0, k2);
      cx = portrait ? 0 : lerp(40, 0, k);
      cy = portrait ? lerp(lerp(-40, 0, k), 70, k2) : lerp(lerp(10, 30, k), 75, k2);
    } else {
      const k1 = ease.camera(prog(t, 15.0, 16.6));
      const k2 = ease.camera(prog(t, 16.5, 18.6));
      const zFar = (W / BW) * 0.44;
      const zCard = (W / BW) * (portrait ? 0.78 : 0.7);
      z = k2 > 0 ? lerp(zFar, zCard, k2) : lerp(zFill * 1.0, zFar, k1);
      cx = 0;
      cy = lerp(portrait ? 70 : 75, portrait ? -120 : -60, ease.inOut(prog(t, 15, 18.6)));
      r = -1.6 * Math.sin(Math.PI * prog(t, 15.0, 17.6));
    }
    // 推近的时候不让画面露出黑板外面。
    if (t < 15.0) {
      const mx = Math.max(0, BW / 2 - W / (2 * z));
      cx = clamp(cx, -mx, mx);
      cy = clamp(cy, -BH / 2 + H / (2 * z), Math.max(-BH / 2 + H / (2 * z), BH / 2 + 60 - H / (2 * z)));
    }
    // 板擦撞上黑板那一下的轻震。
    const shake = wobble(t - ERASE0, 9, 9) * 4;
    // 手持的微晃。
    const hx = noise1(t * 0.6, 1) * 3.2 + shake;
    const hy = noise1(t * 0.6, 2) * 2.4;
    const hr = noise1(t * 0.5, 3) * 0.12;
    return { z, cx: cx + hx / z, cy: cy + hy / z, r: r + hr };
  }

  function seek(t) {
    // 镜头
    let c = camera(t);
    if (t >= 18.6) {
      const k = sceneCamera(t);
      const hx = noise1(t * 0.6, 1) * 3.2, hy = noise1(t * 0.6, 2) * 2.4, hr = noise1(t * 0.5, 3) * 0.12;
      c = { z: k.z, cx: k.x + hx / k.z, cy: k.y + hy / k.z, r: (k.r || 0) + hr };
    }
    board3d.style.display = t < 18.6 ? '' : 'none';
    for (const sc of scenes) sc.show(t);
    for (const u of updaters) u(t);
    world.style.transform = `translate(${W / 2}px, ${H / 2}px) scale(${c.z}) rotate(${c.r}deg) translate(${-c.cx}px, ${-c.cy}px)`;

    // 板面的一道反光，慢慢扫过去。
    sheenBar.style.transform = `translateX(${lerp(-70, 190, t / 18) * BW / 100}px)`;

    // 粉笔字：先写会被擦掉的，擦，再写 CoursePilot，最后盖一层颗粒，粉尘画在颗粒之上。
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, chalkCanvas.width, chalkCanvas.height);
    cctx.setTransform(RES, 0, 0, RES, (BW / 2) * RES, (BH / 2) * RES);
    main.draw(cctx, t);
    attr.draw(cctx, t);
    loops.draw(cctx, t);
    const eAmt = ease.inOut(prog(t, ERASE0, ERASE1));
    if (eAmt > 0) {
      cctx.save();
      cctx.globalCompositeOperation = 'destination-out';
      cctx.strokeStyle = 'rgba(0,0,0,0.975)';
      cctx.lineWidth = 240;
      cctx.lineCap = cctx.lineJoin = 'round';
      if (eAmt < 1) cctx.setLineDash([eAmt * zigLen, zigLen + 1000]);
      cctx.stroke(wipe);
      cctx.restore();
    }
    logo.draw(cctx, t);
    cctx.save();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(grainC, 0, 0);
    cctx.restore();
    cctx.setTransform(RES, 0, 0, RES, (BW / 2) * RES, (BH / 2) * RES);
    dust.draw(cctx, t);

    let pen = null;
    for (const w of writers) {
      const p = w.update(t);
      if (p && (!pen || (p.down && !pen.down))) pen = p;
    }
    // 粉笔头：写字时跟着笔尖，不写时淡出。
    let vis = 0;
    for (const [a, b] of stickWindows) vis = Math.max(vis, prog(t, a, a + 0.2) * (1 - prog(t, b - 0.05, b + 0.25)));
    if (pen) {
      const lift = pen.down ? 0 : pen.lift || 0;
      const jitter = pen.down ? Math.sin(t * 90) * 0.6 : 0;
      stick.setAttribute('transform', `translate(${pen.x + lift * 8 + jitter} ${pen.y - lift * 16}) rotate(-38)`);
      stick.setAttribute('opacity', vis);
    } else stick.setAttribute('opacity', 0);

    // 板擦：沿之字形擦过去。
    const ep = prog(t, ERASE0, ERASE1);
    const e = ease.inOut(ep);
    if (t > ERASE0 - 0.35 && t < ERASE1 + 0.45) {
      let pos;
      if (t < ERASE0) {
        const k = ease.outCubic(prog(t, ERASE0 - 0.35, ERASE0));
        pos = { x: lerp(zig[0].x + (portrait ? 0 : 500), zig[0].x, k), y: lerp(zig[0].y + (portrait ? -400 : -200), zig[0].y, k) };
      } else if (t > ERASE1) {
        const k = ease.inCubic(prog(t, ERASE1, ERASE1 + 0.45));
        const last = zig[zig.length - 1];
        pos = { x: lerp(last.x, last.x + (portrait ? 500 : -400), k), y: lerp(last.y, last.y + (portrait ? 300 : 400), k) };
      } else {
        // 按长度走
        let want = e * zigLen;
        pos = zig[zig.length - 1];
        for (let i = 1; i < zig.length; i++) {
          const seg = Math.hypot(zig[i].x - zig[i - 1].x, zig[i].y - zig[i - 1].y);
          if (want <= seg) { const k = want / seg; pos = { x: lerp(zig[i - 1].x, zig[i].x, k), y: lerp(zig[i - 1].y, zig[i].y, k) }; break; }
          want -= seg;
        }
      }
      const rot = portrait ? 90 + Math.sin(t * 22) * 4 : Math.sin(t * 22) * 4;
      eraser.setAttribute('transform', `translate(${pos.x} ${pos.y}) rotate(${rot})`);
      eraser.setAttribute('opacity', 1);
    } else eraser.setAttribute('opacity', 0);


    // 黑板翻成卡片
    const fp = ease.inOut(prog(t, FLIP0, FLIP1));
    const lift = Math.sin(Math.PI * fp);
    board3d.style.transform = `translateZ(${lift * 260}px) rotateX(${lift * 6}deg) rotateY(${fp * 180}deg)`;
    // 背景从夜里的墙慢慢亮成纸色
    const bgk = ease.inOut(prog(t, FLIP0 + 0.2, FLIP1 + 0.4));
    stage.style.background = mixColor('#0b0e0d', paper, bgk);
    vignette.style.opacity = lerp(1, 0.18, bgk);
    grain.style.opacity = lerp(0.09, 0.05, bgk);

    // Clawd
    updateClawd(t);

    // 胶片颗粒按 24 格每秒跳。
    const gf = Math.floor(t * 24);
    const gr = rng(gf + 1);
    grain.style.backgroundPosition = `${Math.floor(gr() * 256)}px ${Math.floor(gr() * 256)}px`;

    // 开头从黑里浮出来。
    black.style.opacity = 1 - ease.outCubic(prog(t, 0.0, 1.3));

    // 字幕（预览用）
    if (A.subs) {
      const line = narration.find((l) => t >= l.start && t <= l.end + 0.2);
      if (line) {
        subsSpan.textContent = line.sub;
        subsSpan.style.opacity = Math.min(prog(t, line.start, line.start + 0.15), 1 - prog(t, line.end, line.end + 0.2));
        subsBox.style.display = 'flex';
      } else subsBox.style.display = 'none';
    }
  }

  function updateClawd(t) {
    if (t < POP) { clawd.update({ opacity: 0 }); return; }
    if (t >= 18.6) { cclipRect.setAttribute('height', 8000); clawd.update(sceneClawd(t)); return; }
    let x = CX0, y = ledgeTop, squash = 0, tilt = 0, blink = 0, look = 0, wave = 0, step = 0, scale = 1, shadow = 1;
    // 从槽后面冒出来
    const up = spring(t - POP, 1.5, 0.45);
    y = ledgeTop + (1 - up) * 120;
    squash = -0.35 * wobble(t - POP - 0.15, 3, 4);
    cclipRect.setAttribute('height', 4000 + ledgeTop);
    // 眨眼
    for (const b of [13.75, 15.15, 18.1]) blink = Math.max(blink, 1 - Math.abs(t - b) / 0.07 > 0 ? 1 - Math.abs(t - b) / 0.07 : 0);
    // 抬头看写好的字
    look = -0.9 * prog(t, 13.85, 14.05) * (1 - prog(t, 14.9, 15.1));
    // 挥手打招呼，顺带一个小跳
    const wp = prog(t, 14.5, 15.3);
    wave = wp > 0 && wp < 1 ? 1 : 0;
    const waveFlip = Math.sin(t * Math.PI * 2 * 4.5) > 0;
    const hop = Math.max(0, Math.sin(Math.PI * prog(t, 14.55, 14.85)));
    y -= hop * 26;
    // 蹲下 → 起跳 → 空翻 → 落在卡片上沿
    if (t >= CROUCH) squash = 0.65 * ease.outCubic(prog(t, CROUCH, JUMP));
    if (t >= JUMP) {
      const k = prog(t, JUMP, LAND);
      const apex = portrait ? 620 : 520;
      x = lerp(CX0, CX1, ease.inOut(k));
      const y0 = ledgeTop, y1 = CY1;
      y = lerp(y0, y1, k) - apex * 4 * k * (1 - k);
      squash = t < JUMP + 0.25 ? -0.5 * (1 - prog(t, JUMP, JUMP + 0.25)) : 0;
      tilt = -360 * ease.inOut(prog(t, JUMP + 0.15, LAND - 0.2));
      shadow = 0;
      scale = 1 + 0.6 * ease.inOut(prog(t, JUMP, LAND));
    }
    if (t >= LAND) {
      x = CX1; y = CY1; tilt = 0; shadow = 0.6; scale = 1.6;
      squash = 0.55 * wobble(t - LAND, 3.2, 5) + 0.25 * Math.exp(-8 * (t - LAND));
      look = 0.3 * prog(t, 17.9, 18.1);
    }
    clawd.update({ x, y, squash, tilt, blink, look, wave, waveFlip, step, scale, shadow });
  }

  // ================= 后面的场景 =================
  const zCard = (W / BW) * (portrait ? 0.78 : 0.7);
  const R = new Scene(scenesLayer, { cx: 0, cy: portrait ? -120 : -60, s: 1 / zCard, W, H, name: 'review' }).live(18.6, 37.8);
  const scenes = [R];
  const camKeys = [];
  const tracks = [];
  const ctx = {
    A, W, H, portrait, BW, BH, R, cue, css, script, plain,
    layer: scenesLayer,
    cam: (t, c, e) => camKeys.push({ t, ...c, e }),
    track: (scene, keys, t0, t1) => { tracks.push({ scene, keys, t0, t1 }); cueTrack(keys.slice(1), cue); },
    clawdLanding: () => R.l(CX1, CY1),
    deskSlot: () => ({ x: 1500, y: 700, w: 340, h: 280 }),
  };
  const updaters = [buildReview(ctx).update];
  camKeys.sort((a, b) => a.t - b.t);

  function sceneCamera(t) {
    if (t <= camKeys[0].t) return camKeys[0];
    for (let i = 1; i < camKeys.length; i++) {
      if (t <= camKeys[i].t) {
        const a = camKeys[i - 1], b = camKeys[i];
        const k = (b.e || ease.camera)(clamp((t - a.t) / (b.t - a.t)));
        return camLerp(a, b, k);
      }
    }
    return camKeys[camKeys.length - 1];
  }

  function sceneClawd(t) {
    for (const tr of tracks) {
      if (t < tr.t0 || t > tr.t1) continue;
      const st = clawdAt(t, tr.keys);
      if (!st) continue;
      const p = tr.scene.w(st.x, st.y);
      return { ...st, x: p.x, y: p.y, scale: (st.u * tr.scene.s) / 9, opacity: st.hide ? 0 : 1 };
    }
    return { opacity: 0 };
  }

  // 用到的字都先加载好。
  const usedText = stage.innerText + narration.map((l) => l.sub).join('');
  await Promise.all(['500', '600', '700'].map((w) => document.fonts.load(`${w} 40px "Noto Serif SC"`, usedText)).concat(['400', '500', '600'].map((w) => document.fonts.load(`${w} 40px "Noto Sans SC"`, usedText))));
  await document.fonts.ready;

  const duration = A.until || 120.0;
  return { duration, seek, events, narration, marks: { mainEnd: mainRes.t1, attrEnd: attr.t1, logoEnd: LOGO_DONE } };
}

// ---------- 程序化的纹理 ----------
function boardTexture(BW, BH) {
  const k = 1.5;
  const c = document.createElement('canvas');
  c.width = BW * k;
  c.height = BH * k;
  const x = c.getContext('2d');
  x.scale(k, k);
  const g = x.createLinearGradient(0, 0, 0, BH);
  g.addColorStop(0, '#1a251f');
  g.addColorStop(0.55, '#17211c');
  g.addColorStop(1, '#131b17');
  x.fillStyle = g;
  x.fillRect(0, 0, BW, BH);
  const r = rng(42);
  // 以前擦过的痕迹：大片很淡的弧形抹痕
  x.filter = 'blur(14px)';
  for (let i = 0; i < 46; i++) {
    x.strokeStyle = `rgba(230,240,232,${0.007 + r() * 0.013})`;
    x.lineWidth = 50 + r() * 120;
    x.lineCap = 'round';
    x.beginPath();
    const cx = r() * BW, cy = r() * BH, rad = 120 + r() * 380, a0 = r() * 6.28;
    x.arc(cx, cy, rad, a0, a0 + 0.6 + r() * 1.4);
    x.stroke();
  }
  x.filter = 'none';
  // 细粉末
  for (let i = 0; i < 9000; i++) {
    x.fillStyle = `rgba(235,242,236,${0.02 + r() * 0.06})`;
    x.fillRect(r() * BW, r() * BH, 1 + r() * 1.4, 1 + r() * 1.4);
  }
  return c.toDataURL('image/jpeg', 0.93);
}

function grainTile() {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d');
  const img = x.createImageData(n, n);
  const r = rng(99);
  for (let i = 0; i < n * n; i++) {
    const v = 128 + (r() - 0.5) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function mixColor(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b.startsWith('#') ? b : '#fbfbfa');
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], t))).join(',')})`;
}
