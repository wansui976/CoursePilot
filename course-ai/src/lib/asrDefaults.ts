import { isMobile } from "./platform";

export function defaultAsrBackend() {
  return isMobile() ? "aliyun" : "whisper";
}

export function normalizeAsrBackend(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed === "aliyun" || trimmed === "volcengine") return trimmed;
  // 「本地识别」手机上也能选了：那里只有 SenseVoice / Qwen3-ASR，没有 Whisper。
  if (trimmed === "whisper") return trimmed;
  return defaultAsrBackend();
}

export function asrBackendOrDefault(value: string | null | undefined) {
  return normalizeAsrBackend(value);
}
