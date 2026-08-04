/**
 * 处理队列那张卡上的「整体进度」与「现在在干什么」。
 *
 * 队列此前只看 audio 和 asr 两个阶段：语音识别一结束，卡片就一直显示 100%，
 * 而后面还有课件、章节、摘要、笔记、出题、脑图六七个阶段在跑；反过来，AI 纠正字幕
 * 那一段压在 asr 的尾巴上，进度条又长时间停在 98%。两头都让人以为卡住了。
 */

/** 流水线阶段顺序（与后端 jobs::STAGES 一致）。 */
export const PIPELINE_STAGES = [
  "audio",
  "asr",
  "slides",
  "slides_ocr",
  "chapters",
  "summary",
  "notes",
  "quiz",
  "mindmap",
] as const;

export const STAGE_LABEL: Record<string, string> = {
  audio: "提取音频",
  asr: "语音识别",
  slides: "提取课件",
  slides_ocr: "识别课件文字",
  chapters: "生成章节",
  summary: "生成摘要",
  notes: "生成笔记",
  quiz: "生成练习题",
  mindmap: "生成脑图",
};

export interface StageJob {
  stage: string;
  status: string;
  progress: number;
  message?: string | null;
}

function stageRank(stage: string): number {
  const index = PIPELINE_STAGES.indexOf(stage as (typeof PIPELINE_STAGES)[number]);
  return index === -1 ? PIPELINE_STAGES.length : index;
}

/** 按流水线顺序排好的阶段列表。 */
export function orderedStages(byStage: Record<string, StageJob>): StageJob[] {
  return Object.values(byStage).sort((a, b) => stageRank(a.stage) - stageRank(b.stage));
}

/**
 * 「现在在干什么」：优先取正在跑的阶段，其次是失败的（要显示原因），
 * 再次是第一个还没做完的，最后才回落到最后一个阶段。
 */
export function currentStage(byStage: Record<string, StageJob>): StageJob | undefined {
  const list = orderedStages(byStage);
  return (
    list.find((job) => job.status === "running") ??
    list.find((job) => job.status === "failed") ??
    list.find((job) => job.status === "pending") ??
    list[list.length - 1]
  );
}

/**
 * 整条流水线的完成度（0..1）。
 *
 * 每个阶段等权。跳过（canceled）按已完成算——没配大模型时那几步会整体跳过，
 * 若按未完成计，视频永远停在六成，而它其实已经处理完了。
 */
export function overallProgress(byStage: Record<string, StageJob>): number {
  const list = orderedStages(byStage);
  if (list.length === 0) return 0;
  const total = list.reduce((sum, job) => {
    if (job.status === "done" || job.status === "canceled") return sum + 1;
    if (job.status === "failed") return sum;
    return sum + Math.max(0, Math.min(1, job.progress));
  }, 0);
  return Math.max(0, Math.min(1, total / list.length));
}

/** 卡片上那行字：优先用后端给的细节（「AI 纠正文稿 3/12 段」），否则用阶段名。 */
export function stageMessage(job: StageJob | undefined): string {
  if (!job) return "等待中";
  const detail = job.message?.trim();
  if (detail) return detail;
  return STAGE_LABEL[job.stage] ?? job.stage;
}
