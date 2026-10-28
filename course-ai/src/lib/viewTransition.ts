/**
 * 课程库 ⇄ 工作台的共享元素过渡（View Transitions）。
 *
 * 打开视频：被点的封面放大成播放器舞台；返回课程库：舞台缩回那张封面。
 * 共享元素靠同一个 view-transition-name 配对，名字由这里在快照前一刻直接写到元素上、
 * 结束后摘掉——不常驻在 CSS 里，否则明暗切换的圆形揭开也会把播放器单独拎出来做交叉淡化。
 *
 * 导航本身是异步的（路由 navigate + React 提交），所以更新回调里要等 DOM 真的
 * 变成目标状态（播放器挂上 / 卸下）再交给浏览器拍新快照。等不到就按超时放行，最多是
 * 少一段动画，不会卡住导航。
 *
 * 不支持 View Transitions（macOS 14 及更早的 WebKit）或用户要求减弱动效时，直接导航。
 */

const HERO_NAME = "ca-hero";
const COMMIT_TIMEOUT_MS = 400;
/** finished 迟迟不落定时的兜底收尾（动画 0.36s + 余量）。 */
const CLEANUP_FALLBACK_MS = 1200;

type Direction = "open" | "close";

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function canTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !prefersReducedMotion()
  );
}

function coverFor(videoId: string): HTMLElement | null {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(videoId) : videoId;
  return document.querySelector<HTMLElement>(`[data-vt-video="${escaped}"]`);
}

function stage(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-vt-stage]");
}

/** 封面至少有一半露在视口里才配对；滚出屏外的卡片飞过去反而像出错。 */
function mostlyVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
  const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
  return visibleHeight >= rect.height / 2 && visibleWidth >= rect.width / 2;
}

/** 等到 predicate 成立（DOM 每变一次检查一遍），超时就放行。 */
function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (predicate()) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setTimeout(finish, timeoutMs);
  });
}

let running: { cleanup: () => void } | null = null;

function run(direction: Direction, from: HTMLElement | null, update: () => Promise<HTMLElement | null>) {
  running?.cleanup();
  const root = document.documentElement;
  const named = new Set<HTMLElement>();
  const name = (element: HTMLElement | null) => {
    if (!element) return;
    element.style.viewTransitionName = HERO_NAME;
    named.add(element);
  };
  let fallback = 0;
  const state = {
    cleanup: () => {
      for (const element of named) element.style.viewTransitionName = "";
      named.clear();
      delete root.dataset.vtNav;
      window.clearTimeout(fallback);
      if (running === state) running = null;
    },
  };
  running = state;
  root.dataset.vtNav = direction;
  name(from);

  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(async () => {
      const to = await update();
      // 新快照里同名元素只能有一个：旧的那个若还在 DOM 里（隐藏而未卸载），先摘掉。
      if (from && to) from.style.viewTransitionName = "";
      if (from && to) named.delete(from);
      name(to);
    });
  } catch {
    state.cleanup();
    void update();
    return;
  }
  transition.finished.then(state.cleanup, state.cleanup);
  fallback = window.setTimeout(state.cleanup, CLEANUP_FALLBACK_MS);
}

/** 从课程库打开视频：封面 → 播放器舞台。 */
export function transitionToVideo(videoId: string, navigate: () => void): void {
  if (!canTransition()) {
    navigate();
    return;
  }
  const cover = coverFor(videoId);
  run("open", cover && mostlyVisible(cover) ? cover : null, async () => {
    navigate();
    await waitFor(() => stage() != null, COMMIT_TIMEOUT_MS);
    return stage();
  });
}

/** 从工作台回到课程库：播放器舞台 → 这个视频的封面（不在可视区就只做整页淡入淡出）。 */
export function transitionToLibrary(videoId: string | null, navigate: () => void): void {
  // 播放器不在屏上（比如正叠着设置页）就没有可缩回的东西，直接走。
  if (!canTransition() || stage() == null) {
    navigate();
    return;
  }
  run("close", stage(), async () => {
    navigate();
    await waitFor(() => stage() == null, COMMIT_TIMEOUT_MS);
    const cover = videoId ? coverFor(videoId) : null;
    return cover && mostlyVisible(cover) ? cover : null;
  });
}
