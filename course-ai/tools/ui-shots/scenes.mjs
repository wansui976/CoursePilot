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
  // 打开视频走共享元素过渡，工作台要等过渡回调里的导航落地才出现。
  await page.locator("[data-video-player]").first().waitFor({ timeout: 5000 });
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
    // 课程「…」菜单：颜色行（第二门课已标青色）。
    name: "course-menu",
    devices: ALL,
    run: async ({ page, shot }) => {
      if (!(await sidebarShell(page))) await nav(page, "课程", "课程");
      const row = page.locator(".ca-nav .ca-nav-item", { hasText: "线性代数的本质" }).first();
      await row.hover();
      await row.getByRole("button", { name: "课程操作" }).click();
      await shot();
    },
  },
  {
    // 课程内文件夹：根目录（两章 + 两个散落的视频）、进入第2章（面包屑 + 子文件夹）、文件夹菜单、移动对话框。
    name: "folders",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-folders", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openCourse(page);
      await page.getByRole("button", { name: "打开文件夹 第1章 基础" }).waitFor();
      await shot("root");
      await page.getByRole("button", { name: "列表视图" }).click();
      await shot("root-list");
      await page.getByRole("button", { name: "网格视图" }).click();
      await page.getByRole("button", { name: "打开文件夹 第2章 神经网络" }).click();
      await page.getByRole("navigation", { name: "文件夹路径" }).waitFor();
      await shot("inside");
      const card = page.locator(".ca-folder").first();
      await card.hover();
      await card.getByRole("button", { name: "文件夹操作" }).click();
      await shot("menu");
      await page.keyboard.press("Escape");
      const video = page.locator("article.ca-card:not(.ca-folder)").first();
      await video.hover();
      await video.getByRole("button", { name: "视频操作" }).click();
      await page.getByRole("menuitem", { name: "移动到…" }).click();
      await page.getByRole("dialog").waitFor();
      await shot("move-dialog");
    },
  },
  {
    // 侧栏文件夹树：展开课程、展开第2章，从侧栏打开 2.1；再打开一个视频看工作台里的章节分组。
    name: "sidebar-tree",
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-folders", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: "展开 机器学习导论" }).click();
      await page.getByRole("button", { name: "展开 第2章 神经网络" }).click();
      await shot("expanded");
      await page.getByRole("button", { name: "2.1 反向传播", exact: true }).click();
      await page.getByRole("navigation", { name: "文件夹路径" }).waitFor();
      await shot("open-folder");
      await page.getByRole("button", { name: /反向传播推导/ }).first().click();
      await page.locator("[data-video-player]").first().waitFor({ timeout: 5000 });
      const expand = page.getByRole("button", { name: "展开侧栏" });
      if (await expand.isVisible().catch(() => false)) await expand.click();
      await shot("workbench");
    },
  },
  {
    // 批量选择：选中一个文件夹和两个视频，底部出现操作条。
    name: "selection",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-folders", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openCourse(page);
      await page.getByRole("button", { name: "打开文件夹 第1章 基础" }).waitFor();
      await page.getByRole("button", { name: "选择", exact: true }).click();
      await page.getByRole("button", { name: "选择 第2章 神经网络" }).click();
      await page.getByRole("button", { name: /^选择 08/ }).click();
      await page.getByRole("button", { name: /^选择 09/ }).click();
      await shot();
      await page.getByRole("button", { name: "列表视图" }).click();
      await shot("list");
    },
  },
  {
    // 拖着视频悬停在文件夹上：文件夹卡描边高亮。
    name: "folder-drop",
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-folders", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openCourse(page);
      const folder = page.getByRole("button", { name: "打开文件夹 第1章 基础" });
      await folder.waitFor();
      const video = page.locator("article.ca-card:not(.ca-folder)").first();
      const from = await video.boundingBox();
      const to = await folder.boundingBox();
      await page.mouse.move(from.x + 60, from.y + 60);
      await page.mouse.down();
      await page.mouse.move(from.x + 70, from.y + 70, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await shot("hover");
      await page.mouse.up();
      await shot("dropped");
    },
  },
  {
    // 侧栏拖动排序：把第一门课拖到最后，拍拖动中和松手后。
    name: "course-drag",
    run: async ({ page, shot }) => {
      const rows = page.locator(".ca-nav .ca-nav-item");
      const from = await rows.nth(0).boundingBox();
      const to = await rows.nth(2).boundingBox();
      const x = from.x + 60;
      await page.mouse.move(x, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 3 });
      await page.mouse.move(x, to.y + to.height / 2 + 6, { steps: 10 });
      await shot("dragging");
      await page.mouse.up();
      await shot("dropped");
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
    // 新手引导：空课程库 → 空课程 → 第一次进工作台，每组逐步拍下来。
    name: "tour",
    devices: ALL,
    run: async ({ page, shot }) => {
      const bubble = page.locator(".ca-tour-bubble");
      const walk = async (prefix) => {
        for (let i = 1; i <= 4; i += 1) {
          await bubble.waitFor({ timeout: 4000 });
          await page.waitForTimeout(250);
          await shot(`${prefix}-${i}`);
          const next = bubble.getByRole("button", { name: /下一步|知道了/ });
          const label = await next.textContent();
          await next.click();
          if (label?.includes("知道了")) break;
        }
        await bubble.waitFor({ state: "detached", timeout: 2000 });
      };
      await page.evaluate(() => {
        localStorage.setItem("__shot-tours", "1");
        localStorage.setItem("__shot-empty", "1");
      });
      await page.reload({ waitUntil: "networkidle" });
      await walk("library");
      // 有课了：进一门还没有视频的课
      await page.evaluate(() => localStorage.removeItem("__shot-empty"));
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("button", { name: /^线性代数的本质/ }).first().click();
      await walk("course");
      // 手机上进了课程页就看不到课程列表了：回首页再打开视频
      await page.reload({ waitUntil: "networkidle" });
      await openVideo(page);
      await walk("workbench");
      await page.evaluate(() => localStorage.removeItem("__shot-tours"));
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
    name: "downloads",
    devices: ALL,
    run: async ({ page, shot }) => {
      // 打开假下载队列后刷新：后端快照经过 useDownloadsSync 填进 store。
      await page.evaluate(() => localStorage.setItem("__shot-downloads", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openCourse(page);
      await shot("course");
      await nav(page, "处理队列", "队列");
      await shot("queue");
      await page.evaluate(() => localStorage.removeItem("__shot-downloads"));
    },
  },
  {
    name: "workbench",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      await shot();
      // 分栏布局下再拍一张收起学习面板的样子（开关在标题行右端）。
      const collapse = page.getByRole("button", { name: "收起学习资料面板" });
      if (await collapse.count()) {
        await collapse.click();
        await shot("collapsed");
        // 专注阅读：面板占满、正文居中。
        await page.getByRole("button", { name: "专注阅读" }).click();
        await page.getByRole("tab", { name: /笔记/ }).click();
        await shot("focus");
        await page.keyboard.press("Escape");
      }
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
    name: "take-note",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      // 「记一笔」：按 N → 暂停、切到笔记、末尾插入当前时间，光标停在后面。
      await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press("n");
      // 等笔记装载完、时间戳插进去、光标就位，再接着写。
      await page.locator(".tiptap-notes:focus").waitFor({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type("这里是梯度下降的关键一步");
      await shot();
    },
  },
  {
    name: "notes-editor",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      await openNotes(page);
      const editor = page.locator(".tiptap-notes").first();
      await editor.waitFor({ timeout: 5000 });
      // 末尾用 Markdown 语法敲一段：标题、待办、代码块，再截一帧画面。
      await editor.click();
      await editor.evaluate((node) => node.editor?.commands.focus("end"));
      await page.keyboard.press("Enter");
      await page.keyboard.type("## 课后\n[ ] 推一遍梯度公式\n\n");
      await page.keyboard.type("``` lr = 0.01");
      await page.keyboard.press("ArrowDown");
      await page.getByRole("button", { name: "截取当前画面" }).click();
      await page.locator(".ca-note-image[data-state=ready]").first().waitFor({ timeout: 5000 }).catch(() => {});
      await page.keyboard.type("这一帧是损失曲面");
      await page.locator(".ca-note-image").first().scrollIntoViewIfNeeded().catch(() => {});
      await shot();
      await page.getByRole("button", { name: "更多格式" }).click();
      await shot("more");
    },
  },
  {
    name: "transcript-select",
    devices: ["desktop"],
    run: async ({ page, shot }) => {
      await openVideo(page);
      await page.getByRole("tab", { name: /文稿/ }).first().click();
      const row = page.locator(".ca-transcript-text").nth(2);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      if (!box) throw new Error("找不到文稿句子");
      // 真实拖选：句子是 role="button"，全局样式曾把它设成不可选中，拖不出选区。
      await page.mouse.move(box.x + 70, box.y + 12);
      await page.mouse.down();
      await page.mouse.move(box.x + 230, box.y + 12, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
      if (!selected) throw new Error("文稿拖不出选区");
      await page.getByRole("button", { name: "摘到笔记" }).waitFor({ timeout: 3000 });
      await shot();
    },
  },
  {
    name: "notes-link",
    devices: ["desktop"],
    run: async ({ page, shot }) => {
      await openVideo(page);
      await openNotes(page);
      const editor = page.locator(".tiptap-notes").first();
      await editor.waitFor({ timeout: 5000 });
      // 选中末尾两个字，点格式条上的「链接」：地址框必须拿到焦点，否则接着打的网址会盖掉选中的正文。
      await editor.evaluate((node) => {
        const ed = node.editor;
        let end = 0;
        ed.state.doc.descendants((child, pos) => {
          if (child.isText) end = pos + child.nodeSize;
        });
        ed.chain().focus().setTextSelection({ from: end - 2, to: end }).run();
      });
      await page.getByRole("button", { name: "链接", exact: true }).click();
      await page.waitForTimeout(300);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className);
      if (focused !== "链接地址") throw new Error(`链接地址框没有拿到焦点，焦点在：${focused}`);
      await page.keyboard.type("example.com");
      await page.keyboard.press("Enter");
      const href = await editor.evaluate((node) => node.editor.getAttributes("link").href ?? null);
      await editor.evaluate((node) => {
        const ed = node.editor;
        ed.commands.setTextSelection(ed.state.doc.content.size - 2);
      });
      if (href !== "https://example.com") throw new Error(`链接没加上：${href}`);
      await shot();
    },
  },
  {
    name: "assistant",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      // 桌面布局从左侧工具栏打开；窄屏没有工具栏，用右下角入口。
      if (await sidebarShell(page)) {
        await page.getByRole("button", { name: "切换 AI 助手" }).click();
      } else {
        await page.getByRole("button", { name: "打开 AI 助手" }).click();
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
      const bar = page.getByRole("slider", { name: "播放进度" }).first();
      if (await bar.isVisible().catch(() => false)) {
        const box = await bar.boundingBox();
        if (box) await page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2);
        else await bar.hover();
        await page.waitForTimeout(200);
        await shot("progress-hover");
      }
      // 播放设置：智能倍速 / 跳停顿 / 去黑边开关与字幕样式（窄播放器里还有倍速与弹幕）。
      const settings = page.getByRole("button", { name: "播放设置" });
      if (await settings.isVisible().catch(() => false)) {
        await settings.click();
        await page.waitForTimeout(250);
        await shot("settings");
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
  {
    // 界面密度「紧凑」：课程库、课程页、工作台各拍一张，和默认档对比看有没有挤压换行。
    name: "density-compact",
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("course-ai-density", "compact"));
      await page.reload({ waitUntil: "networkidle" });
      await shot("home");
      await openCourse(page);
      await shot("course");
      await page.getByRole("button", { name: VIDEO }).first().click();
      await shot("workbench");
    },
  },
  {
    // 课程库 ⇄ 工作台的共享元素过渡：把动画放慢到 3 秒，在中途各拍一帧（不停动画）。
    name: "vt-nav",
    run: async ({ page, device, theme, out }) => {
      await page.addStyleTag({
        content: `::view-transition-group(*),
          ::view-transition-old(*),
          ::view-transition-new(*) { animation-duration: 3s !important; }`,
      });
      await openCourse(page);
      await page.waitForTimeout(800);
      const raw = async (suffix) =>
        page.screenshot({ path: resolve(out, `${device}-${theme}-vt-nav-${suffix}.png`) });
      await page.getByRole("button", { name: VIDEO }).first().click();
      await page.waitForTimeout(900);
      await raw("open-mid");
      await page.waitForTimeout(2600);
      await raw("open-end");
      const back = page.getByRole("button", { name: "返回课程库" }).first();
      await back.click();
      await page.waitForTimeout(1200);
      await raw("close-mid");
      await page.waitForTimeout(2600);
      await raw("close-end");
    },
  },
  {
    // 后台任务：在工作台点「重新生成」摘要（mock 永不返回），回课程库看入口与列表。
    name: "bg-tasks",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-slow-ai", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openVideo(page);
      await page.getByRole("button", { name: "重新生成" }).first().click();
      await shot("workbench");
      await nav(page, "返回课程库", "返回");
      await shot("library");
      await page.getByRole("button", { name: /后台任务|个任务进行中/ }).first().click();
      await shot("list");
    },
  },
  {
    // 引导模式：开开关 → 提问 → 回答画成进度 / 选项 / 提示 → 点选项 → 收尾总结。
    name: "guided",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-guided", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openVideo(page);
      await nav(page, "切换 AI 助手", "打开 AI 助手");
      await page.getByRole("button", { name: /^引导$/ }).first().click();
      await page.getByLabel("对 AI 助手说").fill("学习率太大会怎样？");
      await page.getByLabel("发送").click();
      await page.getByText("第 1 / 3 步").waitFor({ timeout: 4000 });
      await page.getByRole("button", { name: "给我个提示" }).click();
      await shot("step");
      await page.getByRole("button", { name: "迈得很远" }).click();
      await page.getByText("你自己推出了").waitFor({ timeout: 4000 });
      await shot("done");
    },
  },
  {
    // 拍题找讲解：课程页「找讲解」→ 手打题目 → 结果 → 依次播放 → 工作台顶部的队列条。
    name: "find-explanation",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: "找讲解" }).first().click();
      await shot("pick");
      await page.getByRole("button", { name: "没有图？直接输入题目" }).click();
      await page.getByPlaceholder("输入或粘贴题目文字").fill("学习率 η=1.2 时梯度下降会怎样？");
      await page.getByRole("dialog").getByRole("button", { name: "找讲解" }).click();
      await page.getByRole("list", { name: "讲这道题的地方" }).waitFor({ timeout: 4000 });
      await shot("results");
      await page.getByRole("button", { name: /依次播放这/ }).click();
      await page.getByRole("region", { name: "依次播放" }).waitFor({ timeout: 6000 });
      await shot("queue");
    },
  },
  {
    // 精华版：播放设置里切到「跳过」→ 进度条斜纹、文稿水分句变淡。
    name: "highlights",
    // 手机上控制栏要先点画面唤出，设置菜单走另一套；这里只拍桌面与平板。
    devices: ["desktop", "tablet"],
    run: async ({ page, shot }) => {
      await openVideo(page);
      const stage = page.getByLabel("视频播放区").first();
      await stage.hover().catch(() => {});
      await page.getByRole("button", { name: "播放设置" }).first().click();
      await page.getByRole("menuitemradio", { name: "跳过" }).click();
      await shot("menu");
      await page.keyboard.press("Escape");
      const tab = page.getByRole("tab", { name: /文稿/ });
      if (await tab.count()) await tab.first().click();
      await stage.hover().catch(() => {});
      await shot("transcript");
    },
  },
  {
    // 费曼复述：章节标题行「费曼复述」选一章 → 打字讲一遍 → 对照结果。
    name: "feynman",
    devices: ALL,
    run: async ({ page, shot }) => {
      await openVideo(page);
      // 章节标题行「费曼复述」→ 选一章。
      await page.getByRole("button", { name: "费曼复述" }).first().click();
      await page.getByRole("dialog").getByRole("button").filter({ hasText: "梯度与最速下降方向" }).first().click();
      await page.getByRole("dialog").filter({ hasText: "讲给我听" }).waitFor({ timeout: 4000 });
      await shot("speak");
      const typeInstead = page.getByRole("button", { name: "不方便出声？打字也行" });
      if (await typeInstead.count()) await typeInstead.click();
      await page
        .getByLabel("你讲的内容")
        .fill("梯度下降就是每一步都沿着负梯度的方向走一小步，走多远由学习率决定。学习率越大收敛越快。");
      await page.getByRole("button", { name: "对照课程看看" }).click();
      await page.getByText(/讲到 2 \/ 3 个要点/).waitFor({ timeout: 4000 });
      await shot("result");
    },
  },
  {
    // 本地识别：SenseVoice / Qwen3-ASR 的模型清单，选了 Qwen3-ASR 时的热词框。
    name: "local-asr",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => {
        localStorage.setItem(
          "__shot-settings",
          JSON.stringify({
            asr_backend: "whisper",
            whisper_model: "qwen3-asr",
            asr_language: "zh",
            volcengine_asr_hotwords: "梯度下降, 反向传播, 损失函数, Transformer, softmax, 正则化",
          }),
        );
      });
      await page.reload({ waitUntil: "networkidle" });
      await nav(page, "设置", "设置");
      await page.getByRole("button", { name: "语音识别" }).first().click();
      await page.getByText("本地识别模型").first().waitFor({ timeout: 4000 });
      await shot();
      await page.getByText("本地识别模型").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot("models");
    },
  },
  {
    // 手机内存放不下 Qwen3-ASR：模型清单上标出来。
    name: "local-asr-lowmem",
    devices: ["phone"],
    run: async ({ page, shot }) => {
      await page.evaluate(() => {
        localStorage.setItem("__shot-lowmem", "1");
        localStorage.setItem("__shot-settings", JSON.stringify({ asr_backend: "whisper", whisper_model: "sensevoice" }));
      });
      await page.reload({ waitUntil: "networkidle" });
      await nav(page, "设置", "设置");
      await page.getByRole("button", { name: "语音识别" }).first().click();
      await page.getByText("本地识别模型").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot();
    },
  },
  {
    // 处理队列：本地识别进行中。
    name: "local-asr-queue",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-local-asr", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await nav(page, "处理队列", "队列");
      await page.getByText(/本地识别/).first().waitFor({ timeout: 4000 });
      await shot();
    },
  },
  {
    // 导入文件夹：认出 B 站客户端的离线缓存。
    name: "bilibili-cache",
    devices: ["desktop"],
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-folder", "/Users/demo/Movies/bilibili"));
      await page.reload({ waitUntil: "networkidle" });
      await openCourse(page);
      await page.getByRole("button", { name: /^导入/ }).first().click();
      await page.getByRole("menuitem", { name: /导入整个文件夹/ }).click();
      await page.getByRole("dialog", { name: "导入文件夹视频" }).waitFor({ timeout: 4000 });
      await shot();
    },
  },
  {
    // 练习：作答、逐项解析、改错题判分、「再出一套」对话框。
    name: "quiz",
    devices: ALL,
    run: async ({ page, shot }) => {
      await page.evaluate(() => localStorage.setItem("__shot-quiz", "1"));
      await page.reload({ waitUntil: "networkidle" });
      await openVideo(page);
      await page.getByRole("tab", { name: /更多/ }).click();
      await page.getByText(/损失曲线前几轮/).waitFor({ timeout: 5000 });
      await shot();
      await page.getByRole("button", { name: /数据量太少/ }).click();
      await shot("answered");
      const box = page.getByRole("textbox", { name: "指出错在哪，并写出正确的说法" });
      await box.scrollIntoViewIfNeeded();
      await box.fill("不是越大越快，太大反而不好");
      await page.getByRole("button", { name: "提交批改" }).first().click();
      await page.getByText("部分正确").first().waitFor({ timeout: 3000 });
      await shot("graded");
      await page.getByRole("button", { name: "再出一套" }).click();
      await page.getByRole("dialog").waitFor();
      await shot("new-set");
    },
  },
];
