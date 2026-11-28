// 1:04–1:21 多设备同步（坚果云 / WebDAV）与局域网直连播放
import { clamp, lerp, prog, ease, el, svg } from '../lib/core.js';
import { tf, box, pop } from '../lib/scene.js';

export const DEV = (P) =>
  P
    ? {
        src: 'iphone',
        devs: {
          mac: { kind: 'laptop', x: 120, y: 170, w: 560, h: 340, label: 'Mac' },
          win: { kind: 'monitor', x: 730, y: 200, w: 300, h: 200, label: 'Windows' },
          android: { kind: 'phone', x: 90, y: 1000, w: 250, h: 470, label: 'Android' },
          iphone: { kind: 'phone', x: 378, y: 888, w: 324, h: 557, label: 'iPhone', inset: 12 },
        },
        cloud: { x: 540, y: 680 },
        lanCam: [540, 820, 0.92],
      }
    : {
        src: 'mac',
        devs: {
          win: { kind: 'monitor', x: 110, y: 340, w: 440, h: 268, label: 'Windows' },
          mac: { kind: 'laptop', x: 645, y: 315, w: 630, h: 370, label: 'Mac', inset: 15 },
          android: { kind: 'phone', x: 1370, y: 380, w: 170, h: 320, label: 'Android' },
          iphone: { kind: 'phone', x: 1600, y: 370, w: 180, h: 340, label: 'iPhone' },
        },
        cloud: { x: 960, y: 150 },
        lanCam: [1250, 470, 1.32],
      };

/** 源设备的屏幕框（局部坐标），笔记页正好嵌在这里。 */
export function srcScreen(P) {
  const L = DEV(P);
  const d = L.devs[L.src];
  const i = d.inset ?? (d.kind === 'phone' ? 10 : 14);
  return { x: d.x + i, y: d.y + i, w: d.w - 2 * i, h: (d.kind === 'laptop' ? d.h : d.h) - 2 * i };
}

export function buildDevices(ctx) {
  const { V, portrait: P, cue } = ctx;
  const L = DEV(P);
  const root = V.el;
  const lines = svg('svg', { width: V.W, height: V.H, viewBox: `0 0 ${V.W} ${V.H}`, style: 'position:absolute;left:0;top:0;overflow:visible' }, root);

  // ---------- 云 ----------
  const cl = L.cloud;
  const cloud = box(root, { x: cl.x - 130, y: cl.y - 90, w: 260, h: 170, cls: 'cloud' });
  const cs = svg('svg', { width: 180, height: 100, viewBox: '0 0 180 100' }, cloud);
  svg('path', { d: 'M40 88 H140 a32 32 0 0 0 0-64 a44 44 0 0 0-84-4 a34 34 0 0 0-16 68 Z', fill: 'var(--surface-card)', stroke: 'var(--accent-text)', 'stroke-width': 4, 'stroke-linejoin': 'round' }, cs);
  const cloudLb = el('div', { text: '坚果云 · WebDAV', style: { fontSize: '26px', marginTop: '6px', fontWeight: 600 } }, cloud);
  const cloudX = svg('line', { x1: cl.x - 90, y1: cl.y + 40, x2: cl.x + 90, y2: cl.y - 70, stroke: 'var(--status-err)', 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0 }, lines);

  // ---------- 设备 ----------
  const devs = {};
  for (const [key, d] of Object.entries(L.devs)) {
    const isSrc = key === L.src;
    const r = d.kind === 'phone' ? 30 : d.kind === 'laptop' ? 18 : 10;
    const frame = box(root, { x: d.x, y: d.y, w: d.w, h: d.h, cls: 'dev', style: { borderRadius: `${r}px ${r}px ${d.kind === 'laptop' ? 4 : r}px ${d.kind === 'laptop' ? 4 : r}px` } });
    const i = d.inset ?? (d.kind === 'phone' ? 10 : 14);
    const scr = box(frame, { x: i, y: i, w: d.w - 2 * i, h: d.h - 2 * i, cls: 'scr', style: { borderRadius: d.kind === 'phone' ? '22px' : '4px', background: isSrc ? 'transparent' : 'var(--surface-app)' } });
    if (isSrc) frame.style.background = '#1b1f1d';
    let extra = [];
    if (d.kind === 'laptop') extra.push(box(root, { x: d.x - 60, y: d.y + d.h, w: d.w + 120, h: 24, cls: 'dev-base' }));
    if (d.kind === 'monitor') {
      extra.push(box(root, { x: d.x + d.w / 2 - 30, y: d.y + d.h, w: 60, h: 46, cls: 'dev-stand' }));
      extra.push(box(root, { x: d.x + d.w / 2 - 90, y: d.y + d.h + 44, w: 180, h: 12, cls: 'dev-stand', style: { borderRadius: '6px' } }));
    }
    const lb = box(root, { x: d.x - 40, y: d.y + d.h + (d.kind === 'phone' ? 18 : 70), w: d.w + 80, h: 36, cls: 'dev-label', text: d.label, style: { fontSize: (P ? 28 : 26) + 'px' } });
    let player = null;
    if (!isSrc) player = miniPlayer(scr, d.w - 2 * i, d.h - 2 * i, d.kind === 'phone');
    // 云到设备的连线
    const top = { x: d.x + d.w / 2, y: d.y - 12 };
    const c0 = { x: cl.x, y: cl.y + 60 };
    const mid = { x: (top.x + c0.x) / 2, y: Math.min(top.y, c0.y) - (P ? 40 : 10) + (P && top.y > c0.y ? 160 : 0) };
    const path = svg('path', { d: `M${c0.x} ${c0.y} Q ${mid.x} ${mid.y} ${top.x} ${top.y}`, fill: 'none', stroke: 'var(--border-strong)', 'stroke-width': 3, 'stroke-dasharray': '2 10', 'stroke-linecap': 'round' }, lines);
    devs[key] = { d, frame, scr, extra, lb, player, path, top, isSrc, len: path.getTotalLength() };
  }
  const order = Object.keys(L.devs);
  const targets = order.filter((k) => k !== L.src);

  // ---------- 同步的包 ----------
  const S0 = 68.4;
  const packets = [['进度 12:48', 0], ['笔记 · 梯度下降', 0.75], ['复习卡 12', 1.5]].map(([text, dt]) => {
    const copies = targets.map(() => box(root, { x: 0, y: 0, w: P ? 250 : 230, h: 52, cls: 'packet', text, style: { fontSize: '24px', zIndex: 5 } }));
    const up = box(root, { x: 0, y: 0, w: P ? 250 : 230, h: 52, cls: 'packet', text, style: { fontSize: '24px', zIndex: 5 } });
    return { text, t0: S0 + dt, copies, up };
  });
  packets.forEach((p) => { cue(p.t0, 'swoosh'); cue(p.t0 + 1.0, 'blip'); });
  const src = devs[L.src];
  const srcTop = src.top;
  const ptOn = (path, len, k) => path.getPointAtLength(len * k);

  // ---------- 局域网直连 ----------
  const LAN0 = 75.2;
  const lanFrom = devs.mac, lanTo = devs.iphone;
  const rings = [0, 1, 2, 3].map(() => svg('circle', { fill: 'none', stroke: 'var(--accent-text)', 'stroke-width': 4, opacity: 0 }, lines));
  const lanBadge = box(root, { x: 0, y: 0, w: 420, h: 50, cls: 'badge', text: '局域网直连 · 192.168.1.5', style: { fontSize: '26px', zIndex: 6, width: 'auto' } });
  const b1 = box(root, { x: 0, y: 0, w: 200, h: 48, cls: 'badge', text: '不上传', style: { fontSize: '26px', zIndex: 6, width: 'auto' } });
  const b2 = box(root, { x: 0, y: 0, w: 200, h: 48, cls: 'badge', text: '不占手机空间', style: { fontSize: '26px', zIndex: 6, width: 'auto' } });
  cue(LAN0 + 0.2, 'ping');
  cue(77.4, 'pop2');
  cue(78.4, 'pop2');

  // ---------- 镜头 ----------
  const ss = srcScreen(P);
  ctx.cam(64.4, V.cam(ss.x + ss.w / 2, ss.y + ss.h / 2, V.W / ss.w * (P ? 1.2 : 1.18)));
  ctx.cam(66.2, V.cam(ss.x + ss.w / 2, ss.y + ss.h / 2 + (P ? 40 : 30), (V.W / ss.w) * (P ? 0.42 : 0.5)));
  ctx.cam(67.9, V.cam(V.W / 2, V.H / 2 + (P ? 20 : 10), 1.0));
  ctx.cam(74.6, V.cam(V.W / 2, V.H / 2 + (P ? 20 : 10), 1.04));
  ctx.cam(75.6, V.cam(...L.lanCam));
  ctx.cam(80.4, V.cam(L.lanCam[0], L.lanCam[1], L.lanCam[2] * 1.05));

  // ---------- Clawd：坐着第一个包上云，再落到 iPhone（竖屏落到 Mac）上 ----------
  const rideTo = P ? 'mac' : 'iphone';
  const rideIdx = targets.indexOf(rideTo);
  const pk0 = packets[0];
  const packetPos = (pk, t, ci) => {
    const k1 = ease.inOut(prog(t, pk.t0, pk.t0 + 0.9));
    if (ci === -1) {
      const p0 = srcTop, p1 = { x: cl.x, y: cl.y + 60 };
      return { x: lerp(p0.x, p1.x, k1), y: lerp(p0.y, p1.y, k1) - Math.sin(Math.PI * k1) * 60 };
    }
    const dv = devs[targets[ci]];
    const k2 = ease.inOut(prog(t, pk.t0 + 1.0, pk.t0 + 2.0));
    const p = ptOn(dv.path, dv.len, k2);
    return { x: p.x, y: p.y };
  };
  const u = P ? 9 : 7.5;
  const keys = [
    { t: 64.4, x: srcTop.x + 120, y: srcTop.y + 12, u, hide: true },
    { t: 66.4, x: srcTop.x + 120, y: srcTop.y + 12, u, hop: 200, dur: 0.6 },
    { t: S0 + 0.02, x: (t) => packetPos(pk0, t, -1).x, y: (t) => packetPos(pk0, t, -1).y - 26, u, hop: 90, dur: 0.35 },
    { t: S0 + 0.92, x: (t) => packetPos(pk0, t, -1).x, y: (t) => packetPos(pk0, t, -1).y - 26, u, walk: true, dur: 0.9 },
    { t: S0 + 2.0, x: (t) => packetPos(pk0, t, rideIdx).x, y: (t) => packetPos(pk0, t, rideIdx).y - 26, u, walk: true, dur: 1.0 },
    { t: S0 + 2.5, x: devs[rideTo].top.x, y: devs[rideTo].top.y + 12, u, hop: 100, dur: 0.45, wave: 1.0 },
    // 局域网：在 iPhone 上跟着节拍蹦
    { t: LAN0 + 0.9, x: lanTo.top.x, y: lanTo.top.y + 12, u: P ? 9 : 6.5, hop: P ? 300 : 260, dur: 0.6, spin: P ? 1 : 0 },
    { t: LAN0 + 2.2, x: lanTo.top.x, y: lanTo.top.y + 12, u: P ? 9 : 6.5, hop: 50, dur: 0.3 },
    { t: LAN0 + 3.2, x: lanTo.top.x, y: lanTo.top.y + 12, u: P ? 9 : 6.5, hop: 50, dur: 0.3 },
    { t: LAN0 + 4.4, x: lanTo.top.x, y: lanTo.top.y + 12, u: P ? 9 : 6.5, hop: 50, dur: 0.3, wave: 0.8 },
  ];
  ctx.track(V, keys, 64.4, 81.0);

  function update(t) {
    // 设备在拉远时一台台出现
    order.forEach((key, i) => {
      const dv = devs[key];
      const k = dv.isSrc ? 1 : pop(t, 66.4 + i * 0.18, 0.5);
      const o = dv.isSrc ? 1 : clamp(k * 2);
      tf(dv.frame, { y: (1 - Math.min(1, k)) * 60, o });
      dv.extra.forEach((e) => tf(e, { y: (1 - Math.min(1, k)) * 60, o: dv.isSrc ? clamp((t - 64.8) / 0.6) : o }));
      if (dv.isSrc) dv.frame.style.opacity = clamp((t - 64.6) / 0.5);
      dv.lb.style.opacity = clamp((t - 67.0 - i * 0.1) / 0.4);
      dv.path.style.opacity = clamp((t - 67.6) / 0.5) * (1 - 0.7 * prog(t, LAN0, LAN0 + 0.6));
      if (dv.player) {
        const got = t > S0 + 2.0;
        dv.player.set(got ? 0.41 + Math.max(0, t - S0 - 2.0) * 0.0006 : 0.12, got ? '12:48' : '04:10', t);
        if (key === 'iphone' && t > LAN0 + 0.6) dv.player.set(0.41 + (t - LAN0) * 0.012, fmt(768 + (t - LAN0) * 2.4), t, true);
      }
    });
    tf(cloud, { s: pop(t, 67.2, 0.5), o: clamp((t - 67.2) / 0.3) * (1 - 0.6 * prog(t, LAN0, LAN0 + 0.6)) });
    cloudX.setAttribute('opacity', ease.outCubic(prog(t, 77.3, 77.6)));
    const cxk = ease.outCubic(prog(t, 77.3, 77.6));
    cloudX.setAttribute('x2', lerp(cl.x - 90, cl.x + 90, cxk));
    cloudX.setAttribute('y2', lerp(cl.y + 40, cl.y - 70, cxk));
    // 包：先上云，再分到每台设备
    packets.forEach((pk) => {
      const pu = packetPos(pk, t, -1);
      const showUp = t > pk.t0 - 0.05 && t < pk.t0 + 1.0;
      tf(pk.up, { x: pu.x - pk.up.offsetWidth / 2, y: pu.y - 26, o: showUp ? 1 : 0, s: showUp ? 1 : 0.8 });
      pk.copies.forEach((c, ci) => {
        const p = packetPos(pk, t, ci);
        const on = t > pk.t0 + 1.0 && t < pk.t0 + 2.05;
        tf(c, { x: p.x - c.offsetWidth / 2, y: p.y - 26, o: on ? 1 - prog(t, pk.t0 + 1.9, pk.t0 + 2.05) : 0 });
      });
    });
    // 局域网的波纹：从 Mac 一圈圈漾到 iPhone
    const a = lanFrom.top, b = lanTo.top;
    const mx = { x: lanFrom.d.x + lanFrom.d.w / 2, y: lanFrom.d.y + lanFrom.d.h / 2 };
    rings.forEach((r, i) => {
      const ph = (((t - LAN0) * 0.8 + i / rings.length) % 1 + 1) % 1;
      const on = t > LAN0 && t < 81;
      r.setAttribute('cx', mx.x);
      r.setAttribute('cy', mx.y);
      r.setAttribute('r', 80 + ph * Math.hypot(b.x - mx.x, b.y - mx.y) * 1.05);
      r.setAttribute('opacity', on ? (1 - ph) * 0.5 * clamp((t - LAN0) / 0.4) : 0);
    });
    const bx = lanTo.d.x + lanTo.d.w / 2;
    const by = lanTo.d.y + (P ? -110 : -150);
    tf(lanBadge, { x: bx - lanBadge.offsetWidth / 2 - (P ? 0 : 120), y: by - 60, s: pop(t, LAN0 + 0.5, 0.4), o: t > LAN0 + 0.5 ? 1 : 0 });
    tf(b1, { x: bx - (P ? 430 : 560), y: by + (P ? 620 : 50), s: pop(t, 77.4, 0.4), o: t > 77.4 ? 1 : 0 });
    tf(b2, { x: bx - (P ? 230 : 400), y: by + (P ? 620 : 50), s: pop(t, 78.4, 0.4), o: t > 78.4 ? 1 : 0 });
  }
  return { update, devs, cloud };
}

function fmt(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** 设备屏幕里的小播放器：黑板画面 + 进度条（播放头用荧光黄）。 */
function miniPlayer(parent, w, h, phone) {
  const vh = phone ? w * 0.5625 : h - 56;
  const top = phone ? h * 0.18 : 0;
  const lec = box(parent, { x: 0, y: top, w, h: vh, cls: 'lec', style: { borderRadius: '0' } });
  const s = svg('svg', { width: w, height: vh, viewBox: `0 0 ${w} ${vh}`, style: 'position:absolute;left:0;top:0' }, lec);
  let d = '';
  for (let i = 0; i <= 30; i++) { const u = -1 + (2 * i) / 30; d += (i ? ' L' : 'M') + `${(w * 0.5 + u * w * 0.32).toFixed(1)} ${(vh * 0.25 + u * u * vh * 0.5).toFixed(1)}`; }
  svg('path', { d, fill: 'none', stroke: 'rgba(238,242,236,0.82)', 'stroke-width': Math.max(2, w / 160), 'stroke-linecap': 'round' }, s);
  const dot = svg('circle', { r: Math.max(3, w / 70), fill: 'rgba(238,242,236,0.9)' }, s);
  const bar = box(parent, { x: 12, y: top + vh + (phone ? 22 : 16), w: w - 24, h: 4, cls: 'prog', style: { background: 'var(--border-subtle)' } });
  const fill = el('i', {}, bar);
  const head = el('b', { style: { width: '10px', height: '10px', margin: '-5px 0 0 -5px' } }, bar);
  const tm = box(parent, { x: 12, y: top + vh + (phone ? 34 : 26), w: w - 24, h: 24, cls: 'mono', style: { fontSize: Math.max(14, w / 16) + 'px', color: 'var(--text-muted)' } });
  if (phone) {
    box(parent, { x: 16, y: top + vh + 74, w: w - 32, h: 22, cls: 'serif', text: '第 3 讲 梯度下降', style: { fontSize: Math.max(14, w / 13) + 'px', color: 'var(--text-strong)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' } });
  }
  let last = null;
  return {
    set(p, label, t, playing) {
      fill.style.width = p * 100 + '%';
      head.style.left = p * 100 + '%';
      tm.textContent = label;
      const u = playing ? Math.sin(t * 1.2) * 0.8 : -0.55;
      dot.setAttribute('cx', w * 0.5 + u * w * 0.32);
      dot.setAttribute('cy', vh * 0.25 + u * u * vh * 0.5);
    },
  };
}
