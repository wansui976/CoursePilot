import { beforeEach, describe, expect, it, vi } from "vitest";

// 平台判断的关键场景：iPadOS 桌面模式 UA 伪装成 Mac，唯一可靠的区别是
// 硬件触摸仍在（touch 事件可用）；MacBook 触控板只有 Pointer Events。
function setPlatformEnv({
  platform = "MacIntel",
  maxTouchPoints = 0,
  ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  touch = false,
  hoverNone = false,
}: {
  platform?: string;
  maxTouchPoints?: number;
  ua?: string;
  touch?: boolean;
  // 真触摸设备（iPad 桌面模式）报 (hover: none)；MacBook 触控板是 (hover: hover)。
  hoverNone?: boolean;
} = {}) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    get: () => maxTouchPoints,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => ua,
  });
  Object.defineProperty(window, "ontouchstart", {
    configurable: true,
    get: () => (touch ? (() => {}) : undefined),
  });
  window.matchMedia = (query: string) =>
    ({ matches: query === "(hover: none)" ? hoverNone : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as unknown as MediaQueryList);
}

describe("platform", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("MacBook（触控板，无 touch 事件）不被误判为 iOS/平板", async () => {
    // Tauri macOS WKWebView：platform=MacIntel；MacBook 触控板 maxTouchPoints>1，
    // 但没有 touch 事件（只有 Pointer Events）。
    setPlatformEnv({ maxTouchPoints: 5, touch: false });
    const platform = await import("./platform");
    expect(platform.isIOS()).toBe(false);
    expect(platform.isTablet()).toBe(false);
    expect(platform.isMobile()).toBe(false);
    expect(platform.isDesktop()).toBe(true);
  });

  it("macOS 上即使暴露 touch 接口但鼠标为主（hover:hover）也不误判为 iPad", async () => {
    // Tauri macOS WKWebView 会在非 iPhone/iPad 的 Mac 上暴露 ontouchstart，
    // 值甚至是函数（不等于 undefined）——这正是此前控制栏悬停失效的根因。
    // 只要媒体查询是 (hover: hover)（MacBook 触控板），就不算 iPad 桌面模式。
    setPlatformEnv({ maxTouchPoints: 5, touch: true, hoverNone: false });
    const platform = await import("./platform");
    expect(platform.isIOS()).toBe(false);
    expect(platform.isTablet()).toBe(false);
    expect(platform.isDesktop()).toBe(true);
  });

  it("iMac（无触控板）不被误判", async () => {
    setPlatformEnv({ maxTouchPoints: 0, touch: false });
    const platform = await import("./platform");
    expect(platform.isIOS()).toBe(false);
    expect(platform.isTablet()).toBe(false);
  });

  it("真 iPadOS 桌面模式（touch 事件可用）仍识别为 iPad", async () => {
    // iPadOS 13+ 桌面模式：UA 与 Mac 相同，但硬件触摸仍在。
    setPlatformEnv({ maxTouchPoints: 5, touch: true, hoverNone: true });
    const platform = await import("./platform");
    expect(platform.isIOS()).toBe(true);
    expect(platform.isTablet()).toBe(true);
  });

  it("iPhone UA 识别为 iOS 而非平板", async () => {
    setPlatformEnv({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" });
    const platform = await import("./platform");
    expect(platform.isIOS()).toBe(true);
    expect(platform.isTablet()).toBe(false);
    expect(platform.isMobile()).toBe(true);
  });

  it("Android UA 识别为移动端", async () => {
    setPlatformEnv({ ua: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36" });
    const platform = await import("./platform");
    expect(platform.isAndroid()).toBe(true);
    expect(platform.isMobile()).toBe(true);
  });
});
