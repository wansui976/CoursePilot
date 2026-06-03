const SENSITIVITY_KEY = "slides-sensitivity";

export const DEFAULT_SLIDES_SENSITIVITY = 50;

export function getSlidesSensitivity(): number {
  if (typeof window === "undefined") return DEFAULT_SLIDES_SENSITIVITY;
  const saved = Number(window.localStorage.getItem(SENSITIVITY_KEY));
  return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SLIDES_SENSITIVITY;
}

export function setSlidesSensitivity(value: number) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SENSITIVITY_KEY, String(value));
  }
}

// 灵敏度(0~100) → 亮度差阈值。灵敏度越高、阈值越低、抓的页越多。
export function sensitivityToThreshold(sensitivity: number): number {
  return Math.round(8 + ((100 - sensitivity) / 100) * 42); // 灵敏度100→8，0→50
}
