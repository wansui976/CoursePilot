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

  it("explains long model generation timeouts without encouraging an immediate retry", () => {
    const message = humanizeError(
      "大模型请求超时（已等待 10 分钟）。服务端可能仍在生成，请稍后检查，避免立即重复提交。",
    );
    expect(message).toContain("10 分钟");
    expect(message).toContain("避免立即重复生成");
  });

  it("maps API key / auth errors", () => {
    expect(humanizeError("HTTP 401 Unauthorized")).toContain("API Key");
    expect(humanizeError("未配置大模型")).toContain("API Key");
  });

  it("tells 余额不足 apart from 密钥无效", () => {
    // 真实遇到的那一条。密钥是对的，就是没钱了——让人去「检查 API Key」是白跑一趟。
    const raw =
      '大模型账户余额不足：请充值或更换 API Key 后重试。（OpenAI 402 Payment Required: {"error":{"message":"Insufficient Balance"}}）';
    expect(humanizeError(raw)).toContain("余额不足");
    // 后端给的提示里就带着「API Key」四个字，顺序错了就会被下面那条鉴权规则截胡。
    expect(humanizeError(raw)).not.toContain("未配置或密钥无效");
    // 没经过后端提示的原始应答也要认得。
    expect(humanizeError("OpenAI 402: Insufficient Balance")).toContain("余额不足");
    expect(humanizeError("You exceeded your current quota")).toContain("余额不足");
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
