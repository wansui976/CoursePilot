import { beforeEach, describe, expect, it } from "vitest";
import { pendingStudyRequest, useStudyNav } from "./studyNav";

describe("studyNav", () => {
  beforeEach(() => useStudyNav.setState({ request: null }));

  it("请求被消费之后不再留下：同一视频下次打开读的是自己记住的页签", () => {
    useStudyNav.getState().open("v1", { tab: "notes" });
    const request = pendingStudyRequest("v1");
    expect(request?.target).toEqual({ tab: "notes" });

    useStudyNav.getState().consume(request!.nonce);
    expect(pendingStudyRequest("v1")).toBeNull();
    expect(useStudyNav.getState().request).toBeNull();
  });

  it("只消费自己那一条，不误伤后到的新请求", () => {
    useStudyNav.getState().open("v1", { tab: "notes" });
    const first = pendingStudyRequest("v1")!;
    useStudyNav.getState().open("v1", { tab: "overview" });

    useStudyNav.getState().consume(first.nonce);
    expect(pendingStudyRequest("v1")?.target).toEqual({ tab: "overview" });
  });

  it("别的视频的请求不算这个视频的", () => {
    useStudyNav.getState().open("v2", { tab: "notes" });
    expect(pendingStudyRequest("v1")).toBeNull();
  });

  it("二级视图的落点跟着请求走", () => {
    useStudyNav.getState().open("v1", { tab: "more", moreView: "mindmap" });
    expect(pendingStudyRequest("v1")?.target).toEqual({ tab: "more", moreView: "mindmap" });
  });
});
