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

  it("keeps desktop default on local Whisper", async () => {
    vi.stubGlobal("navigator", { userAgent: "Macintosh" });

    const { asrBackendOrDefault, defaultAsrBackend } = await import("./asrDefaults");

    expect(defaultAsrBackend()).toBe("whisper");
    expect(asrBackendOrDefault("volcengine")).toBe("volcengine");
  });
});
