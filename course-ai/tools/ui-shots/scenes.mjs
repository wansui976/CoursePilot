/**
 * 截图场景。每个场景从首页（内存路由，刷新即回到 /）独立出发，一个场景可以拍多张。
 * `devices` 缺省表示只在桌面拍；手机/平板的导航是底部 Tab，入口与桌面 rail 不同。
 */

const COURSE = /^机器学习导论/;
const VIDEO = /梯度下降的直觉/;

/** 桌面走 rail 的按钮，手机/平板走底部 Tab。 */
async function nav(page, railLabel, tabLabel) {
  const rail = page.getByRole("button", { name: railLabel, exact: true });
  if (await rail.first().isVisible().catch(() => false)) return rail.first().click();
  return page.getByRole("button", { name: tabLabel, exact: true }).first().click();
}

async function openCourse(page) {
  await page.getByRole("button", { name: COURSE }).first().click();
}

async function openVideo(page) {
  await openCourse(page);
  await page.getByRole("button", { name: VIDEO }).first().click();
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
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: "列表视图" }).click();
      await shot();
    },
  },
  {
    name: "card-menu",
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
    run: async ({ page, shot }) => {
      await openCourse(page);
      await page.getByRole("button", { name: /^导入/ }).first().click();
      await shot("menu");
      await page.getByRole("menuitem", { name: /下载网络视频/ }).click();
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
    run: async ({ page, shot }) => {
      await openVideo(page);
      for (const [label, suffix] of [["文稿", "transcript"], ["笔记", "notes"], ["更多", "more"]]) {
        await page.getByRole("tab", { name: new RegExp(label) }).click();
        await shot(suffix);
      }
    },
  },
  {
    name: "assistant",
    run: async ({ page, shot }) => {
      await openVideo(page);
      await page.getByRole("button", { name: "打开助手" }).click();
      await shot();
    },
  },
  {
    name: "concepts",
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
    run: async ({ page, shot, device }) => {
      await nav(page, "设置", "设置");
      await shot();
      if (device !== "desktop") return;
      for (const [label, suffix] of [["语音识别", "asr"], ["大模型", "llm"], ["存储", "storage"]]) {
        await page.getByRole("button", { name: label }).first().click();
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
    run: async ({ page, shot }) => {
      await nav(page, "学习面板", "学习");
      await page.getByRole("button", { name: "开始复习" }).first().click();
      await shot();
      await page.getByRole("button", { name: /显示答案/ }).first().click();
      await shot("answer");
    },
  },
  {
    name: "trash",
    run: async ({ page, shot }) => {
      await nav(page, "回收站", "回收站");
      await shot();
    },
  },
];
