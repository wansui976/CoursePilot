function userAgent() {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent ?? "";
}

function isIPadOSDesktopClass() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  // iPadOS 桌面模式：UA 伪装成 Mac（platform=MacIntel），但硬件触摸仍在，
  // touch 事件可用（ontouchstart 有值）。MacBook 触控板只有 Pointer Events——
  // macOS Safari/WKWebView 会暴露 ontouchstart 接口，值却可能是函数而非 undefined，
  // 所以单靠 ontouchstart 会在桌面 Mac 上误判成 iPad。
  // 可靠的判别是 hover/pointer 媒体查询：真 iPad 桌面模式是触摸设备
  // （hover: none / pointer: coarse），MacBook 触控板是 (hover: hover) / (pointer: fine)。
  const coarse = typeof window.matchMedia === "function"
    ? window.matchMedia("(hover: none)").matches
    : false;
  // 只看 ontouchstart 这个属性在不在：真 iPad 的 WKWebView 里它存在、值却是 null，
  // 原来写 `!= null` 会把每台用默认桌面模式的 iPad 都当成 Mac——建课程、导入、导出
  // 全走了桌面分支。区分 Mac 靠上面的 (hover: none)。
  return (
    nav.platform === "MacIntel" &&
    (nav.maxTouchPoints ?? 0) > 1 &&
    "ontouchstart" in window &&
    coarse
  );
}

export function isAndroid() {
  return /Android/i.test(userAgent());
}

export function isIOS() {
  return /iPhone|iPad|iPod/i.test(userAgent()) || isIPadOSDesktopClass();
}

export function isTablet() {
  return /iPad/i.test(userAgent()) || isIPadOSDesktopClass();
}

export function isMobile() {
  return isAndroid() || isIOS();
}

export function isDesktop() {
  return !isMobile();
}
