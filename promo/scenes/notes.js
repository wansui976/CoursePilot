// 0:52–1:04 笔记：纸张换横线 / 方格 / 点阵 / 米字格；长笔记右边一排硬卡纸索引标签；AI 铅笔批注，Clawd 用橡皮擦掉
import { clamp, lerp, prog, ease, el, rng } from '../lib/core.js';
import { tf, box, pop } from '../lib/scene.js';
import { ChalkWriter, ChalkCanvas } from '../lib/chalk.js';

export const NOTE_CHARS = '震荡时学习率减半';

export function buildNotes(ctx) {
  const { N, portrait: P, cue } = ctx;
  const W = N.W, H = N.H;
  const root = N.el;
  const page = box(root, { x: 0, y: 0, w: W, h: H, cls: 'note' });
  const barH = P ? 92 : 72;

  // ---------- 纸张 ----------
  const LH = P ? 70 : 68; // 一行的高度，横线就画在每行底下
  const sheet = box(page, { x: 0, y: barH, w: W, h: H - barH, cls: 'sheet' });
  const mizi = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${LH * 2}" height="${LH * 2}"><g fill="none" stroke="#e1e4df" stroke-width="1.4"><rect x="0.7" y="0.7" width="${LH * 2 - 1.4}" height="${LH * 2 - 1.4}"/><g stroke-dasharray="5 5"><path d="M0 ${LH}H${LH * 2}M${LH} 0V${LH * 2}M0 0L${LH * 2} ${LH * 2}M${LH * 2} 0L0 ${LH * 2}"/></g></g></svg>`);
  const papers = [
    { name: '空白', bg: 'none' },
    { name: '横线', bg: `linear-gradient(to bottom, transparent ${LH - 1.5}px, var(--border-subtle) ${LH - 1.5}px)`, size: `100% ${LH}px` },
    { name: '方格', bg: `linear-gradient(to bottom, transparent ${LH / 2 - 1}px, var(--border-faint) ${LH / 2 - 1}px), linear-gradient(to right, transparent ${LH / 2 - 1}px, var(--border-faint) ${LH / 2 - 1}px)`, size: `${LH / 2}px ${LH / 2}px` },
    { name: '点阵', bg: `radial-gradient(circle, #cfd3ce 1.8px, transparent 2.4px)`, size: `${LH / 2}px ${LH / 2}px` },
    { name: '米字格', bg: `url("data:image/svg+xml,${mizi}")`, size: `${LH * 2}px ${LH * 2}px` },
  ];
  const layers = papers.map((p) => box(sheet, { x: 0, y: 0, w: W, h: H - barH, style: { backgroundImage: p.bg, backgroundSize: p.size || 'auto', backgroundPosition: `0 0`, background: undefined } }));
  layers.forEach((l, i) => { if (papers[i].bg !== 'none') { l.style.backgroundImage = papers[i].bg; l.style.backgroundSize = papers[i].size; } l.style.background = 'var(--surface-card)'; l.style.backgroundImage = papers[i].bg === 'none' ? 'none' : papers[i].bg; l.style.backgroundSize = papers[i].size || 'auto'; });
  const paperT = [53.7, 54.4, 55.0, 55.6];
  paperT.forEach((t) => cue(t, 'page'));

  // ---------- 格式条 ----------
  const bar = box(page, { x: 0, y: 0, w: W, h: barH, cls: 'bar', style: { padding: `0 ${P ? 36 : 40}px`, fontSize: (P ? 24 : 24) + 'px' } });
  el('span', { class: 'serif', text: '梯度下降 · 笔记', style: { color: 'var(--text-strong)', fontWeight: 600, fontSize: (P ? 30 : 28) + 'px' } }, bar);
  const seg = el('div', { class: 'seg', style: { fontSize: (P ? 22 : 22) + 'px' } }, bar);
  const segs = papers.map((p) => el('span', { text: p.name }, seg));
  const ops = el('div', { class: 'ops' }, bar);
  const opEls = (P ? ['记一笔', '批注', '导出'] : ['记一笔', '历史', '批注', '导出', '重新生成']).map((n) => el('span', { text: n }, ops));
  const pizhu = opEls.find((e) => e.textContent === '批注');

  // ---------- 正文 ----------
  const X0 = P ? 64 : 280;
  const TW = P ? 820 : 1160;
  const fs = P ? 36 : 36;
  const lines = [
    ['h1', '梯度下降'],
    ['gap'],
    ['p', '沿着损失下降最快的方向，一小步一小步走到谷底。', '03:12'],
    ['gap'],
    ['h2', '一、学习率'],
    ['p', '学习率决定每一步迈多大。太小，收敛很慢；'],
    ['pw', '太大，<span class="wv">参数会在谷底两侧来回震荡</span>，甚至发散。', '12:48'],
    ['gap'],
    ['h2', '二、动量'],
    ['p', '把上一步的方向带进这一步，像小球滚下山坡。', '18:05'],
    ['gap'],
    ['h2', '三、正则化'],
    ['p', '给过大的权重一点惩罚，模型更平滑，不容易过拟合。', '24:30'],
    ['gap'],
    ['h2', '四、小结'],
    ['p', '先看损失曲线：抖得厉害就调小学习率。', '31:02'],
  ];
  let row = 1;
  let wavySpan = null;
  let wavyRow = 0;
  for (const [kind, text, ts] of lines) {
    if (kind === 'gap') { row += 0.0; continue; }
    const h = kind === 'h1' ? LH * 2 : LH;
    const y = barH + row * LH;
    const n = box(page, { x: X0, y, w: TW, h, style: { display: 'flex', alignItems: 'flex-end', paddingBottom: (kind === 'h1' ? 14 : 12) + 'px', whiteSpace: P ? 'normal' : 'nowrap' } });
    const tag = kind === 'h1' ? 'h1' : kind === 'h2' ? 'h2' : 'p';
    const t = el(tag, { html: text + (ts ? ` <span class="ts" style="font-size:0.82em">${ts}</span>` : '') }, n);
    t.style.fontSize = (kind === 'h1' ? fs * 1.9 : kind === 'h2' ? fs * 1.2 : fs) + 'px';
    t.style.lineHeight = '1.2';
    if (kind === 'pw') { wavySpan = t.querySelector('.wv'); wavyRow = row; }
    row += kind === 'h1' ? 2 : 1;
    if (P && kind !== 'h1' && kind !== 'h2' && [...text.replace(/<[^>]+>/g, '')].length * fs > TW - 80) row += 1;
  }

  // ---------- 索引标签 ----------
  const tabs = ['梯度下降', '学习率', '动量', '正则化', '小结'];
  const tabW = P ? 54 : 50;
  const scrollbar = 16;
  let ty = barH + (P ? 120 : 70);
  const tabEls = tabs.map((name, i) => {
    const h = [...name].length * (P ? 36 : 33) + 30;
    const cur = i === 1;
    const e = box(page, { x: W - scrollbar - tabW - (cur ? 14 : 0), y: ty, w: tabW + (cur ? 14 : 0), h, cls: 'idx' + (cur ? ' cur' : ''), html: [...name].map((c) => `<span>${c}</span>`).join(''), style: { fontSize: (P ? 30 : 27) + 'px', zIndex: 3 } });
    const y0 = ty;
    ty += h + 12;
    return { e, cur, y0, h };
  });
  const tabT = 56.7;
  tabEls.forEach((_, i) => cue(tabT + i * 0.18, 'tick'));

  // ---------- 铅笔批注 ----------
  const wvRect = () => {
    let x = 0, y = 0, n = wavySpan;
    while (n && n !== page) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: wavySpan.offsetWidth, h: wavySpan.offsetHeight };
  };
  const wr = wvRect();
  const wv = box(page, { x: wr.x, y: wr.y + wr.h - 2, w: wr.w, h: 12, style: { overflow: 'hidden', zIndex: 2 } });
  const wvs = el('div', { style: { position: 'absolute', left: 0, top: 0, width: wr.w + 'px', height: '12px', backgroundImage: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><path d="M0 6 Q4 1 8 6 T16 6" fill="none" stroke="#6f7471" stroke-width="1.8"/></svg>')}")`, backgroundRepeat: 'repeat-x' } }, wv);
  const pen = new ChalkCanvas(page, { x: 0, y: barH, w: W - scrollbar - tabW - 20, h: H - barH, res: 1.4, grain: false, z: 2 });
  const pw = new ChalkWriter({ color: '#6f7471', seed: 77 });
  const PN0 = 60.0;
  let noteBox;
  if (P) {
    const nx = 900, ny = barH + wavyRow * LH - 40;
    const sz = 40;
    pw.addHan('震荡时', { x: nx + 46, y: ny, size: sz, gap: 1.05, dir: 'v', t0: PN0, speed: 1500, strokeGap: 0.008, charGap: 0.03, overhead: 0.008 });
    pw.addHan('学习率减半', { x: nx, y: ny, size: sz, gap: 1.05, dir: 'v', t0: PN0 + 0.75, speed: 1500, strokeGap: 0.008, charGap: 0.03, overhead: 0.008 });
    noteBox = { x: nx - 6, y: ny - 10, w: 100, h: sz * 5.4 + 20 };
  } else {
    const nx = X0 + TW + 40, ny = barH + wavyRow * LH - 34;
    const sz = 38;
    pw.strokes.length = 0;
    pw.addStroke([{ x: wr.x + wr.w * 0.92, y: wr.y + wr.h + 10 }, { x: wr.x + wr.w + 60, y: wr.y + wr.h + 26 }, { x: nx - 14, y: ny + sz * 0.9 }], { t0: PN0 - 0.3, dur: 0.28, width: 2.6 });
    pw.addHan('震荡时', { x: nx, y: ny, size: sz, gap: 1.02, t0: PN0, speed: 1500, strokeGap: 0.008, charGap: 0.03, overhead: 0.008 });
    pw.addHan('学习率减半', { x: nx, y: ny + sz * 1.25, size: sz, gap: 1.02, t0: PN0 + 0.7, speed: 1500, strokeGap: 0.008, charGap: 0.03, overhead: 0.008 });
    noteBox = { x: nx - 20, y: ny - 10, w: sz * 5.2 + 40, h: sz * 2.6 + 20 };
  }
  for (const s of pw.strokes) { s.width = Math.min(s.width, P ? 6.5 : 6); s.opacity = 0.95; }
  pen.writers.push(pw);
  // 橡皮：Clawd 推着它擦过去，留下橡皮屑
  const ER0 = 62.25, ER1 = 63.15;
  cue(ER0, 'rub', { dur: ER1 - ER0 });
  const rub = box(page, { x: 0, y: 0, w: 70, h: 40, style: { background: '#efe9df', border: '1px solid #ddd5c8', borderRadius: '6px', zIndex: 4, boxShadow: '0 4px 10px rgba(0,0,0,0.08)' } });
  el('div', { style: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '26px', background: 'var(--tag-blue)', opacity: 0.85, borderRadius: '0 6px 6px 0' } }, rub);
  const crumbs = [];
  const cr = rng(12);
  for (let i = 0; i < 14; i++) {
    const c = box(page, { x: noteBox.x + cr() * noteBox.w, y: noteBox.y + noteBox.h * (0.2 + cr() * 0.9) - barH * 0 , w: 4 + cr() * 6, h: 3 + cr() * 4, cls: 'crumb', style: { zIndex: 3, transform: `rotate(${cr() * 90}deg)` } });
    crumbs.push({ c, t: lerp(ER0, ER1, cr()) });
  }
  const rubPath = (k) => {
    // 来回三趟擦过批注
    const rows = 3;
    const seg = Math.min(rows - 1e-6, k * rows);
    const r = Math.floor(seg), f = seg - r;
    const left = noteBox.x - 10, right = noteBox.x + noteBox.w + 10;
    const x = r % 2 ? lerp(left, right, f) : lerp(right, left, f);
    const y = noteBox.y + 16 + (noteBox.h - 30) * (r + f * 0.4) / rows;
    return P ? { x: noteBox.x + noteBox.w / 2 + (r % 2 ? 1 : -1) * (f - 0.5) * 40, y: lerp(noteBox.y, noteBox.y + noteBox.h, (r + f) / rows) } : { x, y };
  };

  // ---------- Clawd ----------
  const keys = [
    { t: 52.4, x: W * 0.62, y: H + 60, u: P ? 8 : 7, hide: true },
    { t: 53.2, x: W * (P ? 0.72 : 0.78), y: barH, hop: 420, dur: 0.7, u: P ? 8 : 7, spin: -1, look: -0.4 },
    { t: tabT - 0.1, x: W - scrollbar - tabW / 2, y: tabEls[0].y0 - 4, hop: 160, dur: 0.5, u: P ? 7 : 6, look: -0.8 },
    { t: 59.6, x: noteBox.x + noteBox.w + (P ? -30 : 10), y: noteBox.y - 8, hop: 220, dur: 0.6, u: P ? 7 : 6.5, look: -0.7 },
    { t: ER0, x: () => rubPath(0).x + (P ? 0 : 60), y: () => rubPath(0).y + 26, hop: 120, dur: 0.4, u: P ? 7 : 6.5, look: -1 },
    { t: ER1, x: () => rubPath(1).x + (P ? 0 : -60), y: () => rubPath(1).y + 26, walk: true, dur: ER1 - ER0, u: P ? 7 : 6.5 },
    { t: 63.7, x: noteBox.x + noteBox.w / 2, y: noteBox.y + noteBox.h + 40, hop: 120, dur: 0.4, u: P ? 7 : 6.5, wave: 0.9 },
  ];
  ctx.track(N, keys, 52.3, 64.4);

  // 镜头
  ctx.cam(53.3, N.cam(W / 2, H / 2, 1));
  ctx.cam(55.9, N.cam(W / 2, H / 2, P ? 1.02 : 1.03));
  ctx.cam(57.0, P ? N.cam(600, 760, 1.12) : N.cam(1010, 520, 1.06));
  ctx.cam(59.4, P ? N.cam(620, 800, 1.16) : N.cam(1080, 560, 1.13));
  ctx.cam(63.9, P ? N.cam(640, 820, 1.2) : N.cam(1100, 570, 1.18));

  // 竖屏：一开始只露出和封面一样的 16:9 那一块
  const clip0 = P ? (H - (W * 9) / 16) / 2 : 0;

  function update(t) {
    // 从摊开的那一讲翻进笔记
    const inK = ease.inOut(prog(t, 52.2, 53.0));
    page.style.opacity = inK;
    const cl = clip0 * (1 - ease.inOut(prog(t, 52.6, 53.6)));
    root.style.clipPath = cl > 0.5 ? `inset(${cl}px 0 ${cl}px 0 round 12px)` : 'none';
    // 纸张一层层盖上去：从右往左扫
    layers.forEach((l, i) => {
      if (i === 0) return;
      const k = ease.inOut(prog(t, paperT[i - 1], paperT[i - 1] + 0.45));
      l.style.clipPath = `inset(0 0 0 ${(1 - k) * 100}%)`;
      l.style.display = k > 0 ? '' : 'none';
    });
    const cur = paperT.filter((x) => t >= x + 0.2).length;
    segs.forEach((s, i) => s.classList.toggle('on', i === cur));
    // 索引标签
    tabEls.forEach((tb, i) => {
      const k = pop(t, tabT + i * 0.18, 0.45);
      const rot = (i % 2 ? 0.8 : -0.6) * (i + 1) * 0.5;
      tf(tb.e, { x: (1 - Math.min(1, k)) * 90, r: rot, o: clamp(k * 3) });
    });
    // 批注
    pizhu.classList.toggle('on', t > 59.2);
    const wk = ease.inOut(prog(t, 59.7, 60.3));
    wv.style.width = wk * wr.w + 'px';
    wv.style.opacity = 1 - prog(t, ER1 - 0.2, ER1 + 0.1);
    if (t > PN0 - 0.5) {
      const ek = ease.inOut(prog(t, ER0, ER1));
      pen.draw(t, null, ek > 0 ? (c) => {
        c.save();
        c.globalCompositeOperation = 'destination-out';
        c.lineCap = c.lineJoin = 'round';
        c.lineWidth = P ? 80 : 56;
        c.beginPath();
        const n = 40;
        for (let i = 0; i <= n * ek; i++) {
          const p = rubPath(i / n);
          if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y);
        }
        c.stroke();
        c.restore();
      } : null);
    }
    pen.c.style.display = t > PN0 - 0.5 ? '' : 'none';
    // 橡皮跟着 Clawd
    const rk = prog(t, ER0 - 0.05, ER1);
    if (t > ER0 - 0.3 && t < ER1 + 0.35) {
      const p = rubPath(rk);
      tf(rub, { x: p.x - 35, y: p.y - 20, r: Math.sin(t * 30) * 4, o: 1 - prog(t, ER1, ER1 + 0.35) });
    } else tf(rub, { o: 0 });
    crumbs.forEach((c) => (c.c.style.opacity = t > c.t ? 0.9 : 0));
  }
  return { update };
}
