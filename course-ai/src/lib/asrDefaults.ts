import { isAndroid } from "./mobileFiles";

export function defaultAsrBackend() {
  return isAndroid ? "aliyun" : "whisper";
}

export function asrBackendOrDefault(value: string | null | undefined) {
  return value?.trim() || defaultAsrBackend();
}
