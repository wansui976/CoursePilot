/**
 * 截图场景。每个场景从首页（内存路由，刷新即回到 /）独立出发，一个场景可以拍多张。
 * `devices` 缺省表示只在桌面拍；手机/平板的导航是底部 Tab，入口与桌面 rail 不同。
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const COURSE = /^机器学习导论/;
const VIDEO = /梯度下降的直觉/;

/** 桌面走 rail 的按钮，手机/平板走底部 Tab。 */
async function nav(page, railLabel, tabLabel) {
  const rail = page.getByRole("button", { name: railLabel, exact: true });
  if (await rail.first().isVisible().catch(() => false)) return rail.first().click();
  return page.getByRole("button", { name: tabLabel, exact: true }).first().click();
}

/** 应用当前是桌面式侧栏布局，还是窄屏上下叠放 + 底部 Tab（与设备无关：iPad 横屏也是侧栏）。 */
async function sidebarShell(page) {
  return (await page.locator(".ca-app").first().getAttribute("data-shell")) === "sidebar";
}

async function openCourse(page) {
  await page.getByRole("button", { name: COURSE }).first().click();
}

async function openVideo(page) {
  await openCourse(page);
  await page.getByRole("button", { name: VIDEO }).first().click();
}

/** 切到笔记：平板竖屏分栏时笔记常驻右边，没有这个标签。 */
async function openNotes(page) {
  const tab = page.getByRole("tab", { name: /笔记/ });
  if (await tab.count()) await tab.click();
}

/** 写入字幕显示偏好后刷新：模式（original / bilingual / translation）与译文语言。 */
async function captionPrefs(page, mode, lang) {
  await page.evaluate(([m, l]) => {
    localStorage.setItem("course-ai-caption-mode", m);
    localStorage.setItem("course-ai-translation-lang", l);
  }, [mode, lang]);
  await page.reload({ waitUntil: "networkidle" });
}

/** 把 mock 截获的分享图（前端画好、交给后端保存的 PNG）落盘，便于直接审图。 */
async function dumpShareImages(page, out, prefix) {
  const images = await page.evaluate(() => window.__shareImages.splice(0));
  for (const [k, image] of images.entries()) {
    const suffix = images.length > 1 ? `-${k}` : "";
    writeFileSync(resolve(out, `${prefix}${suffix}.png`), Buffer.from(image.pngBase64, "base64"));
  }
  return images.length;
}

const ALL = ["desktop", "phone", "tablet"];

export const scenes = [
  { name: "home", devices: ALL, run: async ({ shot }) => shot() },
  {
    name: "course",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      await shot();
    },
  },
  {
    name: "course-list",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: "列表视图" }).click();
      await shot();
    },
  },
  {
    name: "card-menu",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      const card = page.locator("article.ca-card").nth(2);
      await card.hover();
      await shot("hover");
      await card.getByRole("button", { name: "视频操作" }).click();
      await shot("menu");
    },
  },
  {
    name: "import",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: /^导入/ }).first().click();
      await shot("menu");
      // 移动端只能上传本地文件（没有下载器、也不能导入文件夹）。
      const download = page.getByRole("menuitem", { name: /下载网络视频/ });
      if (!(await download.count())) return;
      await download.click();
      await page.getByRole("dialog").getByRole("textbox").first().fill("https://www.bilibili.com/video/BV1xx411c7mD");
      await shot("dialog");
    },
  },
  {
    name: "queue",
    devices: ALL,
    run: async ({ page, shot }) => {
      await nav(page, "处理队列", "队列");
      await shot();
    },
  },
  {
    name: "workbench",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      await shot();
    },
  },
  {
    name: "workbench-tabs",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      for (const [label, suffix] of [["文稿", "transcript"], ["笔记", "notes"], ["更多", "more"]]) {
        const tab = page.getByRole("tab", { name: new RegExp(label) });
        // 平板竖屏分栏时笔记常驻右边、不是标签。
        if (!(await tab.count())) continue;
        await tab.click();
        await shot(suffix);
      }
    },
  },
  {
    name: "assistant",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      // 桌面布局从左侧工具栏打开；窄屏没有工具栏，用右下角入口。
      if (await sidebarShell(page)) {
        await page.getByRole("button", { name: "切换助手" }).click();
      } else {
        await page.getByRole("button", { name: "打开助手" }).click();
      }
      await shot();
    },
  },
  {
    name: "concepts",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: "知识点" }).click();
      await shot();
      await page.getByRole("button", { name: /梯度下降/ }).first().click();
      await shot("open");
    },
  },
  {
    name: "settings",
    devices: ALL,
    run: async ({ page, shot }) => {
      await nav(page, "设置", "设置");
      await shot();
      // 设置页按自身宽度决定形态：宽时左侧分类导航常驻；窄时是「分类列表 → 下钻」，
      // 看完一个分类要先返回列表才点得到下一个。手机竖屏只拍列表。
      if (!(await sidebarShell(page))) return;
      for (const [label, suffix] of [["语音识别", "asr"], ["大模型", "llm"], ["存储", "storage"]]) {
        const category = page.getByRole("button", { name: label }).first();
        if (!(await category.isVisible())) {
          await page.getByRole("button", { name: "返回", exact: true }).first().click();
        }
        await category.click();
        await shot(suffix);
      }
    },
  },
  {
    name: "dashboard",
    devices: ALL,
    run: async ({ page, shot }) => {
      await nav(page, "学习面板", "学习");
      await shot();
    },
  },
  {
    name: "review",
    devices: ALL,
    run: async ({ page, shot }) => {
      await nav(page, "学习面板", "学习");
      await page.getByRole("button", { name: "开始复习" }).first().click();
      await shot();
      await page.getByRole("button", { name: /显示答案/ }).first().click();
      await shot("answer");
    },
  },
  {
    name: "subscriptions",
    devices: ALL,
    run: async ({ page, shot }) => {
      // 窄屏进了课程就离开了课程列表；直接在「课程」Tab 的列表上打开菜单。
      if (await sidebarShell(page)) await openCourse(page);
      await page.getByRole("button", { name: "课程操作" }).first().click();
      await page.getByRole("menuitem", { name: /订阅更新/ }).click();
      await shot();
    },
  },
  {
    name: "player",
    devices: ALL,
    run: async ({ page, shot }) => {
      await captionPrefs(page, "bilingual", "en");
      await openVideo(page);
      await page.waitForTimeout(800);
      await shot();
      // 鼠标移到画面底部的控制条区域唤出控制条（平时自动隐藏；画面中央有字幕层挡着）。
      const stage = await page.locator(".ca-stage").first().boundingBox();
      if (stage) {
        await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height - 12);
        await shot("controls");
      }
      const bar = page.locator("[role='slider']").first();
      if (await bar.isVisible().catch(() => false)) {
        await bar.hover();
        await shot("progress-hover");
      }
    },
  },
  {
    name: "translation",
    devices: ALL,
    run: async ({ page, shot }) => {
      await captionPrefs(page, "bilingual", "en");
      await openVideo(page);
      await page.getByRole("tab", { name: /文稿/ }).click();
      await shot();
    },
  },
  {
    name: "note-history",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      await openNotes(page);
      await page.getByRole("button", { name: "历史版本" }).filter({ visible: true }).first().click();
      await page.getByRole("dialog", { name: "笔记历史" }).waitFor();
      await shot();
    },
  },
  {
    name: "share",
    devices: ALL,
    run: async ({ page, shot, out, device, theme }) => {
      const prefix = `${device}-${theme}-share`;
      let saved = 0;
      // 每拍完一张就落盘：后面要刷新页面去仪表盘，mock 重新注入会清空截获列表。
      const collect = async (name) => {
        // 等分享图真正交给「后端」再落盘（画图有快有慢，固定等 1.5 秒偶尔会漏一张）。
        await page
          .waitForFunction(() => (window.__shareImages?.length ?? 0) > 0, null, { timeout: 8000 })
          .catch(() => {});
        saved += await dumpShareImages(page, out, `${prefix}-card-${name}`);
      };
      await openVideo(page);
      await openNotes(page);
      await page.getByRole("button", { name: "导出" }).filter({ visible: true }).first().click();
      await shot("notes-menu");
      await page.getByRole("menuitem", { name: /分享长图/ }).click();
      await collect("notes");
      await page.getByRole("tab", { name: /更多/ }).click();
      await page.getByRole("button", { name: /脑图/ }).first().click();
      await page.waitForTimeout(800);
      await shot("mindmap");
      await page.getByRole("button", { name: "导出" }).filter({ visible: true }).first().click();
      await page.getByRole("menuitem", { name: /分享图片/ }).click();
      await collect("mindmap");
      await page.goto(page.url(), { waitUntil: "networkidle" });
      await nav(page, "学习面板", "学习");
      await page.getByRole("button", { name: /周报图/ }).first().click();
      await collect("weekly");
      if (saved < 3) throw new Error(`分享图只截获到 ${saved} 张（应为 3）`);
    },
  },
  {
    name: "trash",
    devices: ALL,
    run: async ({ page, shot }) => {
      await nav(page, "回收站", "回收站");
      await shot();
    },
  },
];
