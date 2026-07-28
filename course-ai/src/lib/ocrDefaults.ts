export function defaultOcrBackend() {
  return "local";
}

export function normalizeOcrBackend(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (trimmed === "tesseract") return "local";
  return trimmed === "local" || trimmed === "aliyun" ? trimmed : defaultOcrBackend();
}

export function ocrBackendOrDefault(value: string | null | undefined) {
  return normalizeOcrBackend(value);
}
