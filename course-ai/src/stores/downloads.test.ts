import { beforeEach, describe, expect, it } from "vitest";
import type { DownloadJob } from "@/lib/ipc";
import {
  isActiveDownload,
  isVisibleDownload,
  selectDownloadCount,
  useDownloads,
} from "./downloads";

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "d1",
    batchId: "b1",
    courseId: "c1",
    url: "u1",
    title: "第一讲",
    status: "downloading",
    downloaded: 0,
    total: null,
    speed: null,
    eta: null,
    message: null,
    error: null,
    videoId: null,
    attempt: 0,
    ...overrides,
  };
}

describe("useDownloads", () => {
  beforeEach(() => {
    useDownloads.setState({ byId: {}, order: [] });
  });

  it("keeps progress monotonic within one attempt", () => {
    const { upsert } = useDownloads.getState();
    upsert(job({ downloaded: 100, total: 100 }));
    // 音频流从 0 开始：同一轮尝试里不让进度条退回。
    upsert(job({ downloaded: 0, total: 100 }));

    const current = useDownloads.getState().byId.d1;
    expect(current.downloaded).toBe(100);
    expect(current.total).toBe(100);
  });

  it("allows the bar to reset after a quality fallback retry", () => {
    const { upsert } = useDownloads.getState();
    upsert(job({ downloaded: 100, total: 100 }));
    upsert(job({ downloaded: 0, total: 100, attempt: 1 }));

    expect(useDownloads.getState().byId.d1.downloaded).toBe(0);
  });

  it("deduplicates by id and keeps enqueue order", () => {
    const { addMany, upsert } = useDownloads.getState();
    addMany([job({ id: "d1" }), job({ id: "d2" })]);
    upsert(job({ id: "d1", status: "merging" }));

    expect(useDownloads.getState().order).toEqual(["d1", "d2"]);
    expect(useDownloads.getState().byId.d1.status).toBe("merging");
  });

  it("removes jobs and clears finished ones per course", () => {
    const { addMany, remove, clearFinished } = useDownloads.getState();
    addMany([
      job({ id: "d1", status: "done" }),
      job({ id: "d2", status: "failed" }),
      job({ id: "d3", courseId: "c2", status: "done" }),
    ]);

    remove("d2");
    expect(useDownloads.getState().order).toEqual(["d1", "d3"]);

    clearFinished("c1");
    expect(useDownloads.getState().order).toEqual(["d3"]);
  });

  it("counts only visible jobs in the badge", () => {
    const statuses = [
      "queued",
      "downloading",
      "merging",
      "failed",
      "done",
      "canceled",
    ] as const;
    useDownloads
      .getState()
      .addMany(statuses.map((status, index) => job({ id: `d${index}`, status })));

    expect(useDownloads.getState().order.filter((id) => {
      return isVisibleDownload(useDownloads.getState().byId[id].status);
    })).toHaveLength(4);
    expect(selectDownloadCount(useDownloads.getState())).toBe(4);
    expect(isActiveDownload("merging")).toBe(true);
    expect(isActiveDownload("failed")).toBe(false);
  });
});
