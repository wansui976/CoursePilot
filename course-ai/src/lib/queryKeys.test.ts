import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { qk } from "./queryKeys";

// 前缀失效是缓存契约：这些断言守的是「整组失效能打到每个成员」。
describe("qk prefix contract", () => {
  function isInvalidatedBy(member: readonly unknown[], prefix: readonly unknown[]) {
    const client = new QueryClient();
    client.setQueryData(member, 1);
    void client.invalidateQueries({ queryKey: prefix });
    return client.getQueryState(member)?.isInvalidated === true;
  }

  it("videos.all covers every course's list", () => {
    expect(isInvalidatedBy(qk.videos.list("c1"), qk.videos.all())).toBe(true);
    expect(isInvalidatedBy(qk.videos.list(null), qk.videos.all())).toBe(true);
  });

  it("mediaUrl.all covers per-video urls", () => {
    expect(isInvalidatedBy(qk.mediaUrl.video("v1"), qk.mediaUrl.all())).toBe(true);
  });

  it("srs.conceptDue.all covers each course", () => {
    expect(isInvalidatedBy(qk.srs.conceptDue.course("c1"), qk.srs.conceptDue.all())).toBe(true);
  });

  it("artifact keys are keyed by pipeline stage name", () => {
    // 流水线完成事件按阶段名失效产物，产物名与阶段名必须一致。
    expect(qk.artifact("summary", "v1")).toEqual(["summary", "v1"]);
    expect(isInvalidatedBy(qk.artifact("notes", "v1"), ["notes"])).toBe(true);
  });

  it("does not let one video's key invalidate another's", () => {
    expect(isInvalidatedBy(qk.transcripts("v1"), qk.transcripts("v2"))).toBe(false);
  });
});
