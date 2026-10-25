import { beforeEach, describe, expect, it } from "vitest";
import type { DownloadJob } from "@/lib/ipc";
import {
  isActiveDownload,
  isCancelableDownload,
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
    retryHeight: null,
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

  it("takes backend progress as-is instead of freezing it at a stale 100%", () => {
    const { upsert } = useDownloads.getState();
    // 没有预估总量的来源：视频流下满后总量随音频流变大，进度应如实回落而不是卡在 100%。
    upsert(job({ downloaded: 100, total: 100 }));
    upsert(job({ downloaded: 110, total: 140 }));

    const current = useDownloads.getState().byId.d1;
    expect(current.downloaded).toBe(110);
    expect(current.total).toBe(140);
  });

  it("deduplicates by id and keeps enqueue order", () => {
    const { addMany, upsert } = useDownloads.getState();
    addMany([job({ id: "d1" }), job({ id: "d2" })]);
    upsert(job({ id: "d1", status: "merging" }));

    expect(useDownloads.getState().order).toEqual(["d1", "d2"]);
    expect(useDownloads.getState().byId.d1.status).toBe("merging");
  });

  it("never lets the enqueue snapshot overwrite newer progress events", () => {
    const { addMany, upsert } = useDownloads.getState();
    // 任务瞬间失败：事件先到，入队响应（排队中、0 字节）后到。
    upsert(job({ id: "d1", status: "failed", error: "HTTP Error 412" }));
    addMany([job({ id: "d1", status: "queued" }), job({ id: "d2", status: "queued" })]);

    expect(useDownloads.getState().byId.d1).toMatchObject({
      status: "failed",
      error: "HTTP Error 412",
    });
    expect(useDownloads.getState().order).toEqual(["d1", "d2"]);
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

  it("keeps an importing job visible but no longer cancelable", () => {
    // 入库那一段在挪文件、写库：中途打断会留下只登记了一半的视频。
    expect(isActiveDownload("importing")).toBe(true);
    expect(isCancelableDownload("importing")).toBe(false);
    expect(isCancelableDownload("downloading")).toBe(true);
  });
});
