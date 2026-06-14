import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OCR defaults", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults Android to Aliyun OCR", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("aliyun");
    expect(ocrBackendOrDefault(null)).toBe("aliyun");
  });

  it("defaults iOS to Aliyun OCR", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("aliyun");
    expect(ocrBackendOrDefault(undefined)).toBe("aliyun");
  });

  it("keeps desktop default on local Tesseract", async () => {
    vi.stubGlobal("navigator", { userAgent: "Macintosh" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("tesseract");
    expect(ocrBackendOrDefault("aliyun")).toBe("aliyun");
  });
});
