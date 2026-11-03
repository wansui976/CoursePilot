import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ASR defaults", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults Android to Aliyun cloud ASR", async () => {
    vi.stubGlobal("navigator", { userAgent: "Android" });

    const { asrBackendOrDefault, defaultAsrBackend } = await import("./asrDefaults");

    expect(defaultAsrBackend()).toBe("aliyun");
    expect(asrBackendOrDefault(null)).toBe("aliyun");
  });

  it("defaults iOS to Aliyun cloud ASR but keeps an explicit Volcengine or on-device choice", async () => {
    vi.stubGlobal("navigator", { userAgent: "iPhone" });

    const { asrBackendOrDefault, defaultAsrBackend } = await import("./asrDefaults");

    expect(defaultAsrBackend()).toBe("aliyun");
    expect(asrBackendOrDefault(undefined)).toBe("aliyun");
    expect(asrBackendOrDefault("volcengine")).toBe("volcengine");
    // 手机上也能选本地识别了（SenseVoice / Qwen3-ASR），选了就要留着。
    expect(asrBackendOrDefault("whisper")).toBe("whisper");
  });

  it("keeps desktop default on local Whisper", async () => {
    vi.stubGlobal("navigator", { userAgent: "Macintosh" });

    const { asrBackendOrDefault, defaultAsrBackend } = await import("./asrDefaults");

    expect(defaultAsrBackend()).toBe("whisper");
    expect(asrBackendOrDefault("volcengine")).toBe("volcengine");
  });
});
