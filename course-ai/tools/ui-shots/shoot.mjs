#!/usr/bin/env node
/**
 * 界面截图：vite dev + 本机 Chrome（headless）+ 伪造 Tauri IPC，按场景逐页截图。
 *
 *   pnpm shots                              # 全部场景，桌面，浅色+深色
 *   pnpm shots --scenes home,workbench      # 只拍指定场景
 *   pnpm shots --device phone --theme dark  # 设备：desktop | phone | tablet | all
 *   pnpm shots --out /tmp/shots             # 默认输出到 ui-shots/（已忽略）
 *
 * 端口 1420 已有 dev server 就复用，否则自己起一个、结束时关掉。
 * 有场景失败或页面抛错时以非零码退出；未处理的 IPC 命令会列出来，便于补假数据。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
  const opts = { scenes: null, device: "desktop", theme: "both", out: resolve(ROOT, "ui-shots") };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=");
    const value = inline ?? argv[++i];
    if (key === "--scenes") opts.scenes = value.split(",").filter(Boolean);
    else if (key === "--device") opts.device = value;
    else if (key === "--theme") opts.theme = value;
    else if (key === "--out") opts.out = resolve(value);
    else if (key !== "--") throw new Error(`未知参数 ${key}`);
  }
  return opts;
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
          const name = [device, theme, scene.name, suffix].filter(Boolean).join("-");
          await page.screenshot({ path: resolve(opts.out, `${name}.png`) });
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
process.exitCode = failures.length || pageErrors.size ? 1 : 0;
