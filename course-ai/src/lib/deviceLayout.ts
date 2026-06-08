import { useEffect, useState } from "react";

export type DeviceLayout =
  | "desktop"
  | "laptop"
  | "tablet-landscape"
  | "tablet-portrait"
  | "phone";

export interface DeviceSignals {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  orientation: string;
}

function normalize(value: string): string {
  return value.toLowerCase();
}

export function detectDeviceLayout(signals: DeviceSignals): DeviceLayout {
  const ua = normalize(signals.userAgent);
  const platform = normalize(signals.platform);
  const orientation = normalize(signals.orientation);

  const isIPhone = /iphone|ipod/.test(ua);
  const isAndroidMobile = /android/.test(ua) && /mobile/.test(ua);
  if (isIPhone || isAndroidMobile) return "phone";

  const isIPad =
    /ipad/.test(ua) ||
    (platform === "macintel" && signals.maxTouchPoints > 1 && !isIPhone);
  const isAndroidTablet = /android/.test(ua) && !/mobile/.test(ua);
  if (isIPad || isAndroidTablet) {
    return orientation.includes("portrait")
      ? "tablet-portrait"
      : "tablet-landscape";
  }

  if (signals.maxTouchPoints > 0) return "laptop";
  return "desktop";
}

export function getDeviceLayout(): DeviceLayout {
  if (typeof window === "undefined") return "desktop";
  const hasMatchMedia = typeof window.matchMedia === "function";
  const orientation =
    window.screen.orientation?.type ||
    (hasMatchMedia && window.matchMedia("(orientation: portrait)").matches
      ? "portrait-primary"
      : "landscape-primary");
  return detectDeviceLayout({
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform || "",
    maxTouchPoints: window.navigator.maxTouchPoints || 0,
    orientation,
  });
}

export function useDeviceLayout(): DeviceLayout {
  const [layout, setLayout] = useState<DeviceLayout>(() => getDeviceLayout());

  useEffect(() => {
    const update = () => setLayout(getDeviceLayout());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(orientation: portrait)")
        : null;
    media?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      media?.removeEventListener?.("change", update);
    };
  }, []);

  return layout;
}
