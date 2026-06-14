import { isMobile } from "./platform";

export function defaultAsrBackend() {
  return isMobile() ? "aliyun" : "whisper";
}

export function normalizeAsrBackend(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed === "aliyun" || trimmed === "volcengine") return trimmed;
  if (!isMobile() && trimmed === "whisper") return trimmed;
  return defaultAsrBackend();
}

export function asrBackendOrDefault(value: string | null | undefined) {
  return normalizeAsrBackend(value);
}
