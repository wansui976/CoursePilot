import { beforeEach, describe, expect, it } from "vitest";
import { useJobs, type JobUpdate } from "./jobs";

function asrUpdate(patch: Partial<JobUpdate> = {}): JobUpdate {
  return {
    video_id: "v1",
    job_id: "asr-job",
    stage: "asr",
    status: "running",
    progress: 0,
    message: null,
    ...patch,
  };
}

const jobAt = (stage: string) => useJobs.getState().byVideo.v1?.[stage];

describe("jobs store", () => {
  beforeEach(() => useJobs.getState().resetVideo("v1"));

  it("never moves a running job's progress backwards", () => {
    const { setOne } = useJobs.getState();
    setOne(asrUpdate({ progress: 0.95, message: "写入原始文稿" }));
    setOne(asrUpdate({ progress: 0.9, message: "正在 AI 纠正文稿" }));

    // 文案跟着最新的走，进度停在已经到过的地方。
    expect(jobAt("asr")).toMatchObject({ progress: 0.95, message: "正在 AI 纠正文稿" });

    setOne(asrUpdate({ progress: 0.97, message: "AI 纠正文稿 8/10 段" }));
    expect(jobAt("asr")?.progress).toBe(0.97);
  });

  it("starts over when the job runs again or another job takes the stage", () => {
    const { setOne } = useJobs.getState();
    setOne(asrUpdate({ status: "done", progress: 1 }));
    setOne(asrUpdate({ progress: 0.05, message: "准备识别引擎" }));
    expect(jobAt("asr")?.progress).toBe(0.05);

    setOne(asrUpdate({ progress: 0.6 }));
    setOne(asrUpdate({ job_id: "another-asr-job", progress: 0.1 }));
    expect(jobAt("asr")).toMatchObject({ job_id: "another-asr-job", progress: 0.1 });
  });

  it("lets a DB snapshot fill in stages without overwriting what events already reported", () => {
    const { setOne, seed } = useJobs.getState();
    setOne(asrUpdate({ progress: 0.6, message: "Whisper 识别中（zh）" }));
    setOne(asrUpdate({ job_id: "crop-job", stage: "crop", status: "done", progress: 1 }));

    // 快照是早些时候读的：库里只记着进入识别时的 18%，探测黑边那时还没做完。
    seed(asrUpdate({ progress: 0.18, message: "Whisper 识别中（zh）" }));
    seed(asrUpdate({ job_id: "crop-job", stage: "crop", progress: 0.02 }));
    seed(asrUpdate({ job_id: "slides-job", stage: "slides", status: "pending" }));

    expect(jobAt("asr")?.progress).toBe(0.6);
    expect(jobAt("crop")?.status).toBe("done");
    expect(jobAt("slides")?.status).toBe("pending");
  });
});
