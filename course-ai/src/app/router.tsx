import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Home } from "@/pages/Home";
import { VIEW_PATHS, validateHomeSearch } from "@/app/homeRoute";

// Home 是外壳，按当前路径从 app/mainViews 选主区组件；子路由只登记路径、不带组件
// （为什么不用 <Outlet /> 见 mainViews）。
const rootRoute = createRootRoute({
  component: Home,
  validateSearch: validateHomeSearch,
});

const routeTree = rootRoute.addChildren([
  ...Object.values(VIEW_PATHS).map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  ),
  // 设置分类子页：窄屏「分类列表 → 详情」的下钻就是 /settings ↔ /settings/$category。
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/$category" }),
]);

/** 桌面/移动 WebView 内不需要地址栏：用内存历史，刷新后回到课程库（与迁移前一致）。 */
export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
