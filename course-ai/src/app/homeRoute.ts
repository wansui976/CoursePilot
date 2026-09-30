import { useCallback } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";

/** 主区顶层视图。每个视图对应一条路径；工作台不单独成视图——
 *  「library 视图 + 选中视频」即工作台，这样设置等整页叠在会话上时，
 *  返回仍能回到原来的视频。 */
export type MainView =
  | "library"
  | "dashboard"
  | "queue"
  | "concepts"
  | "settings"
  | "recycle"
  | "dev";

export const VIEW_PATHS = {
  library: "/",
  dashboard: "/dashboard",
  queue: "/queue",
  concepts: "/concepts",
  settings: "/settings",
  recycle: "/trash",
  dev: "/dev",
} as const satisfies Record<MainView, string>;

/** 课程 / 视频选择跨视图保留，放在 search 里。 */
export type HomeSearch = { course?: string; video?: string };

export type HomeLocation = {
  view: MainView;
  courseId: string | null;
  videoId: string | null;
  /** 设置页当前分类（`/settings/$category`）；null 表示设置根层，其它视图恒为 null。
   *  取值是否合法由设置页自己判定，路由层只搬运字符串。 */
  settingsCategory: string | null;
};

const SETTINGS_CATEGORY_PREFIX = `${VIEW_PATHS.settings}/`;

export function validateHomeSearch(search: Record<string, unknown>): HomeSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  return { course: pick(search.course), video: pick(search.video) };
}

const VIEW_BY_PATH = new Map<string, MainView>(
  (Object.entries(VIEW_PATHS) as [MainView, string][]).map(([view, path]) => [path, view]),
);

function toHomeLocation(location: {
  pathname: string;
  search: Record<string, unknown>;
}): HomeLocation {
  const search = validateHomeSearch(location.search);
  const settingsCategory = location.pathname.startsWith(SETTINGS_CATEGORY_PREFIX)
    ? decodeURIComponent(location.pathname.slice(SETTINGS_CATEGORY_PREFIX.length)) || null
    : null;
  return {
    view: settingsCategory ? "settings" : (VIEW_BY_PATH.get(location.pathname) ?? "library"),
    courseId: search.course ?? null,
    videoId: search.video ?? null,
    settingsCategory,
  };
}

/** 读写主区导航状态。`go` 以路由器**最新**位置为基准合并补丁，
 *  同一事件里连续多次调用（如先切课程、再开视频）也能正确叠加。 */
export function useHomeRoute() {
  const router = useRouter();
  const location = useLocation({
    select: (l) => toHomeLocation(l),
    structuralSharing: true,
  });

  const go = useCallback(
    (patch: Partial<HomeLocation>) => {
      const current = toHomeLocation(router.latestLocation);
      const next = { ...current, ...patch };
      // 分类只属于设置页：离开设置即清空；从别的视图进入设置默认回到根层。
      if (next.view !== "settings") next.settingsCategory = null;
      else if (patch.settingsCategory === undefined && current.view !== "settings") {
        next.settingsCategory = null;
      }
      if (
        next.view === current.view &&
        next.courseId === current.courseId &&
        next.videoId === current.videoId &&
        next.settingsCategory === current.settingsCategory
      ) {
        return;
      }
      const search = {
        course: next.courseId ?? undefined,
        video: next.videoId ?? undefined,
      };
      if (next.settingsCategory) {
        void router.navigate({
          to: "/settings/$category",
          params: { category: next.settingsCategory },
          search,
        });
        return;
      }
      void router.navigate({ to: VIEW_PATHS[next.view], search });
    },
    [router],
  );

  return { ...location, go };
}
