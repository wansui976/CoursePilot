import { describe, expect, it } from "vitest";
import {
  currentStage,
  overallProgress,
  stageMessage,
  type StageJob,
} from "./pipelineProgress";

function jobs(...list: StageJob[]): Record<string, StageJob> {
  return Object.fromEntries(list.map((job) => [job.stage, job]));
}

const done = (stage: string): StageJob => ({ stage, status: "done", progress: 1 });

describe("处理队列的整体进度", () => {
  it("语音识别做完不等于处理完", () => {
    // 这是队列此前的核心问题：它只看 audio 和 asr，识别一结束就显示 100%，
    // 而后面还有六七个阶段在跑。
    const state = jobs(
      done("audio"),
      done("asr"),
      { stage: "chapters", status: "running", progress: 0.5 },
      { stage: "summary", status: "pending", progress: 0 },
      { stage: "notes", status: "pending", progress: 0 },
      { stage: "quiz", status: "pending", progress: 0 },
      { stage: "mindmap", status: "pending", progress: 0 },
    );

    expect(overallProgress(state)).toBeLessThan(0.5);
    expect(currentStage(state)?.stage).toBe("chapters");
  });

  it("阶段内的进度会推动整体进度", () => {
    const before = jobs(done("audio"), {
      stage: "asr",
      status: "running",
      progress: 0.9,
    });
    const after = jobs(done("audio"), {
      stage: "asr",
      status: "running",
      progress: 0.99,
    });

    // AI 纠错那一段现在逐批上报，整体进度也就跟着走，而不是长时间不动。
    expect(overallProgress(after)).toBeGreaterThan(overallProgress(before));
  });

  it("跳过的阶段按做完算", () => {
    // 没配大模型时那五步整体跳过。若按未完成计，视频会永远停在四成，
    // 可它其实已经处理到头了。
    const state = jobs(
      done("audio"),
      done("asr"),
      { stage: "chapters", status: "canceled", progress: 0 },
      { stage: "summary", status: "canceled", progress: 0 },
    );

    expect(overallProgress(state)).toBe(1);
  });

  it("失败的阶段不计入完成度，且会盖过后面还没开始的阶段", () => {
    // 失败的那一步排在待处理的前面：要显示的是错误原因，而不是「生成脑图 等待中」。
    const state = jobs(
      done("audio"),
      { stage: "asr", status: "failed", progress: 0, message: "识别服务返回 500" },
      { stage: "mindmap", status: "pending", progress: 0 },
    );

    expect(overallProgress(state)).toBeCloseTo(1 / 3);
    expect(currentStage(state)?.stage).toBe("asr");
    expect(stageMessage(currentStage(state))).toBe("识别服务返回 500");
  });

  it("待处理的阶段按流水线顺序挑，不按对象键的顺序", () => {
    // 都还没开始时，该显示的是「生成章节」而不是排在它后面的任何一个。
    // 键的插入顺序刻意反着来，逼出真正的排序。
    const state = jobs(
      { stage: "mindmap", status: "pending", progress: 0 },
      { stage: "quiz", status: "pending", progress: 0 },
      { stage: "chapters", status: "pending", progress: 0 },
      done("audio"),
      done("asr"),
    );

    expect(currentStage(state)?.stage).toBe("chapters");
  });

  it("正在跑的阶段优先于还没开始的", () => {
    const state = jobs(
      done("audio"),
      { stage: "asr", status: "running", progress: 0.3 },
      { stage: "summary", status: "pending", progress: 0 },
    );

    expect(currentStage(state)?.stage).toBe("asr");
  });

  it("没有细节时退回阶段名，而不是显示后端的英文 stage", () => {
    expect(stageMessage({ stage: "quiz", status: "running", progress: 0.5 })).toBe(
      "生成练习题",
    );
    expect(
      stageMessage({
        stage: "asr",
        status: "running",
        progress: 0.93,
        message: "AI 纠正文稿 3/12 段",
      }),
    ).toBe("AI 纠正文稿 3/12 段");
  });

  it("什么都没有时是 0，不是 NaN", () => {
    expect(overallProgress({})).toBe(0);
    expect(stageMessage(currentStage({}))).toBe("等待中");
  });
});
