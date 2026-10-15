import type { FunctionComponent } from "react";
import type { MainView } from "@/app/homeRoute";
import {
  ConceptsRouteView,
  DashboardRouteView,
  DevRouteView,
  LibraryRouteView,
  QueueRouteView,
  RecycleRouteView,
  SettingsRouteView,
} from "@/app/views";

/**
 * 每个顶层视图（= 一条路径）对应的主区组件。
 *
 * 不挂成 TanStack 路由的 `component`：那样主区要等路由器异步解析完匹配才换，
 * 而外壳（rail / 底栏 / 入场动画 key）读的是同步位置——两边差一拍，同一个视图会在
 * 旧路由下挂一次、新路由下再挂一次（工作台的播放器因此重挂）。外壳按位置同步选组件，
 * 一次渲染里全部到位。
 */
export const MAIN_VIEW_COMPONENTS: Record<MainView, FunctionComponent> = {
  library: LibraryRouteView,
  dashboard: DashboardRouteView,
  queue: QueueRouteView,
  concepts: ConceptsRouteView,
  settings: SettingsRouteView,
  recycle: RecycleRouteView,
  dev: DevRouteView,
};
