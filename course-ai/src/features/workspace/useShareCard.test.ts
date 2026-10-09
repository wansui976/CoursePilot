import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";

const { mockIpc, mobile } = vi.hoisted(() => ({
  mockIpc: { export: { shareImage: vi.fn() } },
  mobile: { isMobile: vi.fn(), shareFile: vi.fn() },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/mobileFiles", () => mobile);

import { saveShareCard, shareCardHeader } from "./useShareCard";

function fakeCanvas() {
  return { toDataURL: () => "data:image/png;base64,iVBORw0KGgo=" } as unknown as HTMLCanvasElement;
}

describe("shareCardHeader", () => {
  it("reads the course and display title from cached lists", () => {
    const client = new QueryClient();
    client.setQueryData(qk.courses(), [{ id: "c1", name: "资料分析" }]);
    client.setQueryData(qk.videos.list("c1"), [{ id: "v1", course_id: "c1", title: "第 1 讲.mp4" }]);
    expect(shareCardHeader(client, "v1", "课堂笔记")).toEqual({
      course: "资料分析",
      title: "第 1 讲",
      kind: "课堂笔记",
    });
  });

  it("leaves fields empty when nothing is cached", () => {
    expect(shareCardHeader(new QueryClient(), "v1", "k")).toEqual({ course: "", title: "", kind: "k" });
  });
});

describe("saveShareCard", () => {
  beforeEach(() => {
    mockIpc.export.shareImage.mockReset().mockResolvedValue("/exports/v1/笔记长图.png");
    mobile.isMobile.mockReset();
    mobile.shareFile.mockReset().mockResolvedValue(undefined);
  });

  it("saves and opens the image on desktop", async () => {
    mobile.isMobile.mockReturnValue(false);
    await expect(saveShareCard(fakeCanvas(), { videoId: "v1", fileName: "笔记长图" })).resolves.toBe(
      "/exports/v1/笔记长图.png",
    );
    expect(mockIpc.export.shareImage).toHaveBeenCalledWith("v1", "笔记长图", "iVBORw0KGgo=", true);
    expect(mobile.shareFile).not.toHaveBeenCalled();
  });

  it("hands the image to the system share sheet on mobile", async () => {
    mobile.isMobile.mockReturnValue(true);
    await saveShareCard(fakeCanvas(), { videoId: null, fileName: "学习周报" });
    expect(mockIpc.export.shareImage).toHaveBeenCalledWith(null, "学习周报", "iVBORw0KGgo=", false);
    expect(mobile.shareFile).toHaveBeenCalledWith("/exports/v1/笔记长图.png", "image/png");
  });
});
