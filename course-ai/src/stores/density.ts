import { create } from "zustand";

/**
 * 界面密度：舒适（默认）/ 紧凑。紧凑档把 Tailwind 的间距基数 --spacing 调小，
 * 全应用的内边距、间隙、图标按钮一起收紧，小屏笔记本上一屏能多放几行。
 * 只在精确指针（鼠标 / 触控板）下生效，见 styles/app-theme.css——触屏的点按目标不能跟着缩。
 */
export type Density = "comfortable" | "compact";

const STORAGE_KEY = "course-ai-density";

export const DENSITIES: { key: Density; i18nKey: string }[] = [
  { key: "comfortable", i18nKey: "settings.appearance.densityComfortable" },
  { key: "compact", i18nKey: "settings.appearance.densityCompact" },
];

function read(): Density {
  try {
    return localStorage.getItem(STORAGE_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** 写到 <html> 上：Portal 出去的对话框、菜单也要跟着同一档。 */
function apply(density: Density) {
  if (typeof document === "undefined") return;
  if (density === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
}

interface DensityState {
  density: Density;
  setDensity: (density: Density) => void;
}

export const useDensity = create<DensityState>((set) => {
  const initial = read();
  apply(initial);
  return {
    density: initial,
    setDensity: (density) => {
      try {
        localStorage.setItem(STORAGE_KEY, density);
      } catch {
        // 存不下只是下次启动回到默认。
      }
      apply(density);
      set({ density });
    },
  };
});
