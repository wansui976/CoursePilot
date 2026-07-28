import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OCR defaults", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults Android to bundled local OCR", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("local");
    expect(ocrBackendOrDefault(null)).toBe("local");
  });

  it("defaults iOS to Apple Vision OCR", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("local");
    expect(ocrBackendOrDefault(undefined)).toBe("local");
  });

  it("defaults desktop to its platform local engine", async () => {
    vi.stubGlobal("navigator", { userAgent: "Macintosh" });

    const { defaultOcrBackend, ocrBackendOrDefault } = await import("./ocrDefaults");

    expect(defaultOcrBackend()).toBe("local");
    expect(ocrBackendOrDefault("aliyun")).toBe("aliyun");
    expect(ocrBackendOrDefault("tesseract")).toBe("local");
  });
});
