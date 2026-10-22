import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { describeDownload } from "./downloadProgress";

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
