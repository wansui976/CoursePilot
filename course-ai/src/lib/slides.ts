const SENSITIVITY_KEY = "slides-sensitivity";

export const DEFAULT_SLIDES_SENSITIVITY = 50;
/** 让后端按画面噪声自估门槛，而不是用手调的灵敏度。 */
export const AUTO_SENSITIVITY = "auto";
export type SlidesSensitivity = number | typeof AUTO_SENSITIVITY;

export function getSlidesSensitivity(): SlidesSensitivity {
  if (typeof window === "undefined") return DEFAULT_SLIDES_SENSITIVITY;
  const raw = window.localStorage.getItem(SENSITIVITY_KEY);
  // 没调过就用「自动」：与导入时的自动提取同一套门槛。原先没存值时落到 50 档（块阈值 14），
  // 白底黑字、每页只换标题和一行字的课件在这个门槛下会漏页（实测 3 页只出 2 页），
  // 而按画面噪声自估的门槛（这类视频约为 4）一页不漏。
  if (raw === null || raw === AUTO_SENSITIVITY) return AUTO_SENSITIVITY;
  const saved = Number(raw);
  return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SLIDES_SENSITIVITY;
}

export function setSlidesSensitivity(value: SlidesSensitivity) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SENSITIVITY_KEY, String(value));
  }
}

/**
 * 灵敏度(0~100) → 单个画面块「算变了」的亮度差门槛；"auto" 交给后端按噪声自估（null）。
 * 判据已改为「多少比例的画面块变了」，这个数因此作用在单块均值差上而不是整屏 RMS，
 * 量纲变了、区间也跟着收窄。灵敏度越高、门槛越低、抓的页越多。
 */
export function sensitivityToThreshold(value: SlidesSensitivity): number | null {
  if (value === AUTO_SENSITIVITY) return null;
  return Math.round(4 + ((100 - value) / 100) * 20); // 灵敏度100→4，0→24
}
