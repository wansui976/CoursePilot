import { isMobile } from "./platform";

export function defaultOcrBackend() {
  return isMobile() ? "aliyun" : "tesseract";
}

export function normalizeOcrBackend(value: string | null | undefined) {
  if (isMobile()) return "aliyun";
  const trimmed = value?.trim();
  return trimmed === "tesseract" || trimmed === "aliyun"
    ? trimmed
    : defaultOcrBackend();
}

export function ocrBackendOrDefault(value: string | null | undefined) {
  return normalizeOcrBackend(value);
}
