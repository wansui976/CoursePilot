import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobProgress } from "./JobProgress";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { pipeline: { jobs: vi.fn(), process: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function job(stage: string, status: string, progress: number) {
  return { id: `${stage}-id`, video_id: "v1", stage, status, progress, message: null };
}

describe("JobProgress", () => {
  beforeEach(() => {
    mockIpc.pipeline.jobs.mockReset();
    mockIpc.pipeline.process.mockReset();
  });

  it("shows the courseware stages between speech recognition and the AI steps", async () => {
    // 后端按 STAGES 顺序返回，这里故意打乱：排序该由 stage 决定，而不是返回顺序。
    mockIpc.pipeline.jobs.mockResolvedValue([
      job("chapters", "pending", 0),
      job("slides_ocr", "running", 0.5),
      job("asr", "done", 1),
      job("slides", "done", 1),
    ]);

    render(<JobProgress videoId="v1" />);

    const labels = (await screen.findAllByText(/语音识别|提取课件|识别课件文字|生成章节/)).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["语音识别", "提取课件", "识别课件文字", "生成章节"]);
  });
});
