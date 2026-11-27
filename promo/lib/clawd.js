// Clawd：Claude Code 的像素小吉祥物，照终端里那三行方块字拼出来。
//  ▐▛███▜▌
// ▝▜█████▛▘
//   ▘▘ ▝▝
// 一个字符拆成 2×2 的格子；终端字符是 1:2 的竖长条，所以每格宽 1、高 2。
import { svg } from './core.js';

const ROWS = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'];
const Q = { ' ': 0, '█': 15, '▐': 0b0101, '▌': 0b1010, '▛': 0b1110, '▜': 0b1101, '▝': 0b0100, '▘': 0b1000 };
export const CLAWD_ORANGE = '#d97757';

function cells() {
  const out = [];
  ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const m = Q[ch] ?? 0;
      if (m & 0b1000) out.push([2 * c, 2 * r]);
      if (m & 0b0100) out.push([2 * c + 1, 2 * r]);
      if (m & 0b0010) out.push([2 * c, 2 * r + 1]);
      if (m & 0b0001) out.push([2 * c + 1, 2 * r + 1]);
    });
  });
  return out;
}

/**
 * 画在 SVG 里的 Clawd。原点在两脚中间的地面上，宽 18 格（1 格 = unit 像素），高 10 格。
 * update 的参数：
 *  x, y      落脚点
 *  scale     整体大小
 *  squash    >0 压扁、<0 拉长（落地 / 起跳）
 *  blink     0..1 闭眼程度
 *  step      走路相位（腿交替抬）
 *  wave      0..1 右手举起
 *  look      -1..1 眼睛往左 / 右看
 *  tilt      身体倾斜（度）
 */
export class Clawd {
  constructor(parent, { unit = 10 } = {}) {
    this.unit = unit;
    this.root = svg('g', { 'shape-rendering': 'crispEdges' }, parent);
    this.shadow = svg('ellipse', { cx: 0, cy: 0, rx: 8 * unit, ry: 1.1 * unit, fill: 'rgba(0,0,0,0.35)' }, this.root);
    this.body = svg('g', {}, this.root);
    const all = cells();
    const isLeg = ([, y]) => y >= 4;
    const isArmL = ([x, y]) => y === 2 && x < 3;
    const isArmR = ([x, y]) => y === 2 && x > 14;
    const add = (list, parentG) => {
      const g = svg('g', {}, parentG);
      for (const [x, y] of list) svg('rect', { x: x - 9, y: y * 2 - 10, width: 1.04, height: 2.04, fill: CLAWD_ORANGE }, g);
      return g;
    };
    this.torso = add(all.filter((c) => !isLeg(c) && !isArmL(c) && !isArmR(c)), this.body);
    this.armL = add(all.filter(isArmL), this.body);
    this.armR = add(all.filter(isArmR), this.body);
    // 挥手时右手换成举起的两帧（像素动画不转角度，换造型）。
    this.armUpA = add([[15, 1], [16, 0]], this.body);
    this.armUpB = add([[15, 1], [16, 1]], this.body);
    this.legs = all.filter(isLeg).map((c) => add([c], this.body));
    // 眼睛：两个 1×2 的空格。画成深色方块，好控制眨眼和看向。
    for (const x of [5, 12]) svg('rect', { x: x - 9, y: -8, width: 1.04, height: 2.04, fill: CLAWD_ORANGE }, this.torso);
    this.eyes = [5, 12].map((x) => svg('rect', { x: x - 9, y: 1 * 2 - 10, width: 1, height: 2, fill: '#141816' }, this.body));
  }

  update({ x = 0, y = 0, scale = 1, squash = 0, blink = 0, step = 0, wave = 0, waveFlip = false, look = 0, tilt = 0, opacity = 1, shadow = 1 }) {
    const u = this.unit * scale;
    this.root.setAttribute('transform', `translate(${x} ${y})`);
    this.root.setAttribute('opacity', opacity);
    this.shadow.setAttribute('rx', 8 * u * (1 + squash * 0.3));
    this.shadow.setAttribute('ry', 1.1 * u);
    this.shadow.setAttribute('opacity', shadow);
    const sx = 1 + squash * 0.18;
    const sy = 1 - squash * 0.22;
    this.body.setAttribute('transform', `rotate(${tilt}) scale(${u * sx} ${u * sy})`);
    this.legs.forEach((g, i) => {
      const up = Math.max(0, Math.sin(step * Math.PI * 2 + (i % 2 ? Math.PI : 0))) * 0.9;
      g.setAttribute('transform', `translate(0 ${-up})`);
    });
    const up = wave > 0.3;
    const flip = waveFlip;
    this.armR.style.display = up ? 'none' : '';
    this.armUpA.style.display = up && flip ? '' : 'none';
    this.armUpB.style.display = up && !flip ? '' : 'none';
    const h = 2 * (1 - blink * 0.85);
    this.eyes.forEach((e, i) => {
      e.setAttribute('height', h);
      e.setAttribute('y', -8 + (2 - h) / 2);
      e.setAttribute('x', [5, 12][i] - 9 + look * 0.45);
    });
  }
}
