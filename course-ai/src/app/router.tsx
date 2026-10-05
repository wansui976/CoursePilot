import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Home } from "@/pages/Home";
import { VIEW_PATHS, validateHomeSearch } from "@/app/homeRoute";

// 过渡期：Home 仍是整个外壳并按当前路径渲染主区，子路由只登记路径、不带组件。
// 后续把各视图拆成独立路由组件时，再在 Home 主区放 <Outlet />。
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
