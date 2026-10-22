import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "@/lib/platform";

type Insets = { top: number; right: number; bottom: number; left: number };

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * 把 Android 系统栏占掉的边距写进 `--native-inset-*`，CSS 里的 `--safe-*` 取它和
 * `env(safe-area-inset-*)` 的较大值。
 *
 * targetSdk 35 起 Android 强制全面屏，页面画到状态栏和导航栏下面；而 WebView 的
 * `env(safe-area-inset-*)` 只报挖孔、不报系统栏——底部导航被手势条压住，没有挖孔的
 * 机器上页头还会钻进状态栏。iOS 的 env() 本来就准，不需要这一步。
 */
export async function applyNativeInsets(target: HTMLElement = document.documentElement) {
  if (!isAndroid()) return;
  try {
    const insets = await invoke<Insets>("plugin:mobile-files|system_bar_insets");
    for (const side of SIDES) {
      target.style.setProperty(`--native-inset-${side}`, `${Math.max(0, insets[side] ?? 0)}px`);
    }
  } catch {
    // 拿不到就保持 0：退回只用 env()，至少不会比现在更糟。
  }
}

/** 启动时取一次，转屏 / 窗口变化时重取（横屏时导航栏会换到侧边）。 */
export function startNativeInsets() {
  if (!isAndroid()) return;
  void applyNativeInsets();
  window.addEventListener("resize", () => void applyNativeInsets());
}
