#!/usr/bin/env node
/**
 * 界面截图：vite dev + 本机 Chrome（headless）+ 伪造 Tauri IPC，按场景逐页截图。
 *
 *   pnpm shots                              # 全部场景，桌面，浅色+深色
 *   pnpm shots --scenes home,workbench      # 只拍指定场景
 *   pnpm shots --device phone --theme dark  # 设备：desktop | phone | tablet | all
 *   pnpm shots --out /tmp/shots             # 默认输出到 ui-shots/（已忽略）
 *   pnpm shots --update-baseline            # 拍完把这批图存为基准（ui-shots-baseline/，已忽略）
 *   pnpm shots --compare [--threshold 0.5]  # 拍完与基准逐像素比对，变化超过 0.5% 的列出并出差异图
 *   pnpm shots --audit                      # 顺带做布局审计（如图标被挤成独占一行），问题列在最后
 *
 * 端口 1420 已有 dev server 就复用，否则自己起一个、结束时关掉。
 * 有场景失败或页面抛错时以非零码退出；未处理的 IPC 命令会列出来，便于补假数据。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { compareWithBaseline, updateBaseline } from "./compare.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { installMockIpc } from "./mock-ipc.mjs";
import { scenes } from "./scenes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "http://localhost:1420/";

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

function parseArgs(argv) {
  const opts = {
    scenes: null,
    device: "desktop",
    theme: "both",
    out: resolve(ROOT, "ui-shots"),
    baseline: resolve(ROOT, "ui-shots-baseline"),
    updateBaseline: false,
    compare: false,
    threshold: 0.5,
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=");
    if (key === "--update-baseline") {
      opts.updateBaseline = true;
      continue;
    }
    if (key === "--audit") {
      opts.audit = true;
      continue;
    }
    if (key === "--compare") {
      opts.compare = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (key === "--scenes") opts.scenes = value.split(",").filter(Boolean);
    else if (key === "--device") opts.device = value;
    else if (key === "--theme") opts.theme = value;
    else if (key === "--out") opts.out = resolve(value);
    else if (key === "--baseline") opts.baseline = resolve(value);
    else if (key === "--threshold") opts.threshold = Number(value);
    else if (key !== "--") throw new Error(`未知参数 ${key}`);
  }
  return opts;
}

/** 在页面里跑：等媒体就绪、再等所有滚动容器的位置连续几次不变（文稿「跟随」是平滑滚动，
 *  截到半路的话两次截图就对不上）。各最多等 3 秒。 */
async function waitForScrollIdle() {
  // 先等媒体就绪：播放器在 loadedmetadata 时才跳到上次进度，文稿据此才开始跟随滚动。
  for (let i = 0; i < 30; i++) {
    const media = [...document.querySelectorAll("video, audio")];
    if (media.every((el) => el.readyState >= 1)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  const positions = () =>
    [document.scrollingElement, ...document.querySelectorAll("*")]
      .filter((el) => el && el.scrollHeight > el.clientHeight)
      .map((el) => `${el.scrollTop},${el.scrollLeft}`)
      .join("|");
  let last = positions();
  let stable = 0;
  for (let i = 0; i < 30 && stable < 3; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = positions();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

/**
 * 在页面里跑的布局审计，查两类问题：
 *   1. 图标（svg，预设样式是 display:block）和文字并排放在非 flex / grid 容器里——图标会
 *      独占一行，把文字挤到下面、把卡片撑高；
 *   2. 写了 Tailwind 显示类却没生效（被未分层的全局规则压掉）；
 *   3. 文字被裁掉却没有省略号；
 *   4. 文字与背景对比度过低（< 3:1）。
 * 返回问题元素的简短描述。
 */
function auditLayout() {
  const issues = [];
  const describe = (el) => {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3).join(".") : "";
    return `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> "${text}"`;
  };
  for (const svg of document.querySelectorAll("svg")) {
    const parent = svg.parentElement;
    const svgStyle = getComputedStyle(svg);
    if (!parent || svgStyle.display !== "block") continue;
    // 绝对定位的图标（下拉箭头、角标）不参与排版，不会挤占文字。
    if (svgStyle.position === "absolute" || svgStyle.position === "fixed") continue;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const display = getComputedStyle(parent).display;
    if (/flex|grid/.test(display)) continue;
    const hasText = [...parent.childNodes].some(
      (node) =>
        (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) ||
        (node.nodeType === Node.ELEMENT_NODE && node !== svg && getComputedStyle(node).display.startsWith("inline") && node.textContent.trim()),
    );
    if (hasText) issues.push(describe(parent));
  }
  // 第二类：元素上写了 Tailwind 的显示类（flex / grid / hidden …），实际 display 却不是——
  // 说明被某条未分层的全局规则压掉了（未分层规则优先于 @layer utilities）。
  // 带变体前缀的（sm:flex、data-[…]:hidden）依赖状态，不判。
  const DISPLAY = {
    flex: "flex",
    "inline-flex": "inline-flex",
    grid: "grid",
    "inline-grid": "inline-grid",
    block: "block",
    "inline-block": "inline-block",
    hidden: "none",
  };
  for (const el of document.querySelectorAll("[class]")) {
    if (typeof el.className !== "string") continue;
    const classes = el.className.split(/\s+/);
    if (classes.some((c) => /:(flex|inline-flex|grid|inline-grid|block|inline-block|inline|hidden|contents|table)$/.test(c))) continue;
    const wanted = classes.filter((c) => c in DISPLAY);
    if (wanted.length !== 1) continue;
    // inline-flex 与 flex（inline-grid 与 grid）只差外层是行内还是块级，内部排版相同；
    // 而 flex / grid 容器的子项本来就会被「块级化」。两者都按同一种算。
    const outerless = (d) => d.replace(/^inline-(flex|grid)$/, "$1");
    let parent = el.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    let expected = outerless(DISPLAY[wanted[0]]);
    if (parent && /flex|grid/.test(getComputedStyle(parent).display) && expected === "inline-block") {
      expected = "block";
    }
    const actual = outerless(getComputedStyle(el).display);
    if (actual !== expected) {
      issues.push(`${describe(el)} 写了 ${wanted[0]}，实际 display:${actual}`);
    }
  }
  // 第三类：文字被裁掉却没有省略号（overflow 隐藏、不换行、内容超宽、没设 ellipsis），
  // 看上去像字被生生切掉一截。
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
    if (style.whiteSpace !== "nowrap" || style.textOverflow === "ellipsis") continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!ownText) continue;
    const rect = el.getBoundingClientRect();
    // sr-only 等仅供读屏的文字本来就被裁成 1px，不算。
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (el.scrollWidth > el.clientWidth + 1) issues.push(`${describe(el)} 文字被截断却没有省略号`);
  }
  // 第四类：文字与背景对比度过低（< 3:1）。背景取最近的不透明底色；途中遇到渐变或
  // 图片背景就跳过（算不准）。禁用态与仅供读屏的文字不算。
  // 计算样式里的颜色可能是 oklab()/oklch()/color-mix() 等：画到 1px 画布上再读回 RGBA，
  // 任何写法都能统一换算（只认 rgb() 的话会跳过这层背景，误判对比度）。
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const parseColor = (value) => {
    if (!value || value === "transparent") return [0, 0, 0, 0];
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "rgba(0,0,0,0)";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const luminance = ([r, g, b]) => {
    const ch = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const backgroundOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== "none") return null;
      const color = parseColor(style.backgroundColor);
      if (color && color[3] >= 0.95) return color;
      if (color && color[3] > 0.05) return null;
    }
    return [255, 255, 255, 1];
  };
  for (const el of document.querySelectorAll("body *")) {
    const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!ownText || el.closest("[disabled], [aria-disabled='true']")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden") continue;
    // 自动隐藏的控件（如播放器控制条）是祖先透明：沿途累乘透明度，看不见的不算。
    let opacity = 1;
    for (let node = el; node && opacity >= 0.9; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    if (opacity < 0.9) continue;
    const fg = parseColor(style.color);
    const bg = backgroundOf(el);
    if (!fg || !bg || fg[3] < 0.9) continue;
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    if (ratio < 3) issues.push(`${describe(el)} 对比度 ${ratio.toFixed(2)}:1`);
  }
  return [...new Set(issues)];
}

async function serverUp() {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
}

/** 没有现成 dev server 就起一个；返回关闭函数（复用现成的则什么都不做）。 */
async function ensureServer() {
  if (await serverUp()) return () => {};
  const vite = spawn(resolve(ROOT, "node_modules/.bin/vite"), ["--port", "1420", "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (await serverUp()) return () => vite.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
  vite.kill();
  throw new Error("dev server 30 秒内没起来");
}

const opts = parseArgs(process.argv.slice(2));
const devices = opts.device === "all" ? Object.keys(DEVICES) : opts.device.split(",");
const themes = opts.theme === "both" ? ["light", "dark"] : [opts.theme];
for (const device of devices) if (!DEVICES[device]) throw new Error(`未知设备 ${device}`);
const unknownScenes = (opts.scenes ?? []).filter((name) => !scenes.some((s) => s.name === name));
if (unknownScenes.length) throw new Error(`未知场景 ${unknownScenes.join(", ")}`);

mkdirSync(opts.out, { recursive: true });
const stopServer = await ensureServer();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = [];
const pageErrors = new Set();
const unknownCmds = new Set();
let count = 0;
const shotNames = [];
const auditIssues = new Set();

try {
  for (const device of devices) {
    for (const theme of themes) {
      const selected = scenes.filter(
        (s) => (s.devices ?? ["desktop"]).includes(device) && (!opts.scenes || opts.scenes.includes(s.name)),
      );
      for (const scene of selected) {
        // 每个场景一个全新上下文：localStorage 不跨场景残留（列表视图、助手展开等偏好
        // 会写进存储，带到下一个场景就会挡住按钮或换掉布局）。
        const context = await browser.newContext({ ...DEVICES[device], locale: "zh-CN" });
        await context.addInitScript(installMockIpc, { theme });
        const page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.add(String(error)));
        page.on("console", (msg) => {
          if (msg.type() === "error") pageErrors.add(msg.text());
        });
        const shot = async (suffix) => {
          await page.waitForTimeout(700); // 等入场动画与异步封面落定
          await page.evaluate(waitForScrollIdle);
          const name = [device, theme, scene.name, suffix].filter(Boolean).join("-");
          // 停掉动画（无限循环的直接取消、有限的快进到终态），同一界面两次截图才逐像素一致。
          await page.screenshot({ path: resolve(opts.out, `${name}.png`), animations: "disabled" });
          shotNames.push(`${name}.png`);
          if (opts.audit) {
            for (const issue of await page.evaluate(auditLayout)) auditIssues.add(`${name}: ${issue}`);
          }
          count++;
        };
        try {
          await page.goto(BASE, { waitUntil: "networkidle" });
          await scene.run({ page, shot, device, theme, out: opts.out });
        } catch (error) {
          failures.push(`${device}/${theme}/${scene.name}: ${String(error).split("\n")[0]}`);
        }
        for (const cmd of (await page.evaluate(() => window.__unknownCmds ?? []).catch(() => []))) unknownCmds.add(cmd);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  stopServer();
}

console.log(`截图 ${count} 张 → ${opts.out}`);
if (unknownCmds.size) console.log(`未处理的 IPC 命令（返回了空值）：${[...unknownCmds].sort().join(", ")}`);
if (failures.length) console.log(`场景失败：\n  ${failures.join("\n  ")}`);
if (pageErrors.size) console.log(`页面错误：\n  ${[...pageErrors].slice(0, 10).join("\n  ")}`);
if (opts.audit) {
  console.log(
    auditIssues.size
      ? `布局审计发现 ${auditIssues.size} 处问题：\n  ${[...auditIssues].join("\n  ")}`
      : "布局审计：没有发现问题",
  );
}
let regressions = 0;
if (opts.updateBaseline) {
  console.log(`已把 ${updateBaseline(shotNames, opts.out, opts.baseline)} 张存为基准 → ${opts.baseline}`);
}
if (opts.compare) {
  const { changed, missing, compared } = compareWithBaseline(
    shotNames,
    opts.out,
    opts.baseline,
    opts.threshold / 100,
  );
  console.log(`与基准比对 ${compared} 张（阈值 ${opts.threshold}%）`);
  if (missing.length) console.log(`没有基准（先跑 --update-baseline）：${missing.join(", ")}`);
  if (changed.length) {
    console.log(`有变化（差异图在 ${resolve(opts.out, "diff")}）：`);
    for (const { name, ratio } of changed.sort((a, b) => b.ratio - a.ratio)) {
      console.log(`  ${(ratio * 100).toFixed(2).padStart(6)}%  ${name}`);
    }
  } else if (compared) {
    console.log("全部与基准一致");
  }
  regressions = changed.length;
}
process.exitCode = failures.length || pageErrors.size || regressions ? 1 : 0;
