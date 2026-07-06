import { describe, expect, it } from "vitest";
import { humanizeError } from "./errors";

describe("humanizeError", () => {
  it("normalizes Error, string and unknown inputs", () => {
    expect(humanizeError(new Error("请求超时"))).toContain("超时");
    expect(humanizeError("timed out")).toContain("超时");
    // 兜底：无法识别的原文原样返回，不吞掉信息。
    expect(humanizeError("some weird thing")).toBe("some weird thing");
    expect(humanizeError(null)).toBe("发生未知错误。");
  });

  it("maps API key / auth errors", () => {
    expect(humanizeError("HTTP 401 Unauthorized")).toContain("API Key");
    expect(humanizeError("未配置大模型")).toContain("API Key");
  });

  it("maps network and rate-limit errors", () => {
    expect(humanizeError("fetch failed: dns")).toContain("网络");
    expect(humanizeError("rate limit exceeded")).toContain("频繁");
  });

  it("maps Bilibili 412 / login-state errors to a cookie hint", () => {
    const msg = humanizeError(
      "yt-dlp failed: ERROR: [BiliBili] Unable to download JSON metadata: HTTP Error 412: Precondition Failed",
    );
    expect(msg).toContain("cookies");
    expect(msg).toContain("412");
  });

  it("maps generic download failures", () => {
    expect(humanizeError("yt-dlp failed: unable to extract")).toContain("下载");
  });

  it("maps disk / permission errors", () => {
    expect(humanizeError("No space left on device")).toContain("磁盘");
    expect(humanizeError("Permission denied (os error 13)")).toContain("权限");
  });
});
