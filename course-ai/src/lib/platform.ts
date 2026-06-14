function userAgent() {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent ?? "";
}

function isIPadOSDesktopClass() {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { maxTouchPoints?: number };
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
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
