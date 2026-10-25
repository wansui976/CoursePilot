import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import type { DownloadJob } from "@/lib/ipc";
import { describeDownload, describeDownloadJob, jobPercent } from "./downloadProgress";

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "d1",
    batchId: "b1",
    courseId: "c1",
    url: "u",
    title: "第一讲",
    status: "downloading",
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    retryHeight: null,
    error: null,
    videoId: null,
    attempt: 0,
    ...overrides,
  };
}

describe("describeDownload", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  const t = i18n.t.bind(i18n);

  it("shows percent and speed when the size is known", () => {
    expect(
      describeDownload(
        { type: "progress", downloaded: 42, total: 100, speed: 3.1 * 1024 ** 2, eta: 5 },
        t,
      ),
    ).toBe("下载中 42% · 3.1 MB/s");
  });

  it("falls back to downloaded bytes without a total", () => {
    expect(
      describeDownload(
        { type: "progress", downloaded: 5 * 1024 ** 2, total: null, speed: null, eta: null },
        t,
      ),
    ).toBe("下载中 5.0 MB");
  });

  it("describes merging and quality fallback", () => {
    expect(describeDownload({ type: "merging" }, t)).toBe("正在合并音视频…");
    expect(describeDownload({ type: "retrying", maxHeight: 720 }, t)).toContain("720P");
  });
});

describe("jobPercent", () => {
  it("reports 0 without a total and clamps to 100", () => {
    expect(jobPercent(job())).toBe(0);
    expect(jobPercent(job({ downloaded: 42, total: 100 }))).toBe(42);
    expect(jobPercent(job({ downloaded: 120, total: 100 }))).toBe(100);
  });

  it("treats merging and done as complete", () => {
    expect(jobPercent(job({ status: "merging", downloaded: 40, total: 100 }))).toBe(100);
    expect(jobPercent(job({ status: "done" }))).toBe(100);
  });
});

describe("describeDownloadJob", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  const t = i18n.t.bind(i18n);

  it("uses percent and speed while downloading", () => {
    expect(
      describeDownloadJob(
        job({ downloaded: 42, total: 100, speed: 3.1 * 1024 ** 2 }),
        t,
      ),
    ).toBe("下载中 42% · 3.1 MB/s");
  });

  it("writes the quality-fallback notice in the interface language", async () => {
    expect(describeDownloadJob(job({ retryHeight: 720 }), t)).toContain("720P");
    await i18n.changeLanguage("en");
    try {
      expect(describeDownloadJob(job({ retryHeight: 720 }), i18n.t.bind(i18n))).toMatch(/720p/i);
      expect(describeDownloadJob(job({ retryHeight: 720 }), i18n.t.bind(i18n))).not.toMatch(/[\u4e00-\u9fff]/);
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("distinguishes queued and failed jobs", () => {
    expect(describeDownloadJob(job({ status: "queued" }), t)).toBe("排队中…");
    expect(
      describeDownloadJob(job({ status: "failed", error: "会员专享" }), t),
    ).toBe("会员专享");
    expect(describeDownloadJob(job({ status: "failed" }), t)).toBe("下载失败");
  });
});
