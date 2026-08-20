/**
 * 处理队列那张卡上的「整体进度」与「现在在干什么」。
 *
 * 队列此前只看 audio 和 asr 两个阶段：语音识别一结束，卡片就一直显示 100%，
 * 而后面还有课件、章节、摘要、笔记、出题、脑图六七个阶段在跑；反过来，AI 纠正字幕
 * 那一段压在 asr 的尾巴上，进度条又长时间停在 98%。两头都让人以为卡住了。
 */

/** 流水线阶段顺序（与后端 jobs::STAGES 一致）。 */
export const PIPELINE_STAGES = [
  "crop",
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
  crop: "探测黑边",
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

const STAGE_LABEL_KEY: Record<string, string> = {
  crop: "pipelineProgress.stages.crop",
  audio: "pipelineProgress.stages.audio",
  asr: "pipelineProgress.stages.asr",
  slides: "pipelineProgress.stages.slides",
  slides_ocr: "pipelineProgress.stages.slidesOcr",
  chapters: "pipelineProgress.stages.chapters",
  summary: "pipelineProgress.stages.summary",
  notes: "pipelineProgress.stages.notes",
  quiz: "pipelineProgress.stages.quiz",
  mindmap: "pipelineProgress.stages.mindmap",
};

const DETAIL_LABEL_KEY: Record<string, string> = {
  "自带字幕，无需抽音轨": "pipelineProgress.details.subtitleSkipsAudio",
  "导入 B站自带字幕": "pipelineProgress.details.importingBilibiliSubtitles",
  "正在 AI 纠正字幕": "pipelineProgress.details.correctingSubtitles",
  "准备识别引擎": "pipelineProgress.details.preparingAsr",
  "切分音频，准备分段上传": "pipelineProgress.details.splittingAudio",
  "云端识别中（火山引擎）": "pipelineProgress.details.volcengineAsr",
  "云端分段识别中（火山引擎）": "pipelineProgress.details.volcengineChunkedAsr",
  "准备上传音频": "pipelineProgress.details.preparingUpload",
  "解析识别结果": "pipelineProgress.details.parsingAsr",
  "写入原始文稿": "pipelineProgress.details.savingTranscript",
  "正在 AI 纠正文稿": "pipelineProgress.details.correctingTranscript",
  "提取课件页": "pipelineProgress.details.extractingSlides",
  "识别课件文字": "pipelineProgress.details.ocrSlides",
  "没有找到课件页，已跳过": "pipelineProgress.details.noSlides",
  "排队中": "pipelineProgress.details.queued",
  "准备讲稿": "pipelineProgress.details.preparingTranscript",
  "正在请求模型划分章节": "pipelineProgress.details.requestingChapters",
  "解析章节": "pipelineProgress.details.parsingChapters",
  "写入章节": "pipelineProgress.details.savingChapters",
  "正在请求模型出题": "pipelineProgress.details.requestingQuiz",
  "校验题目": "pipelineProgress.details.validatingQuiz",
  "写入题库": "pipelineProgress.details.savingQuiz",
  "正在请求模型生成脑图": "pipelineProgress.details.requestingMindmap",
  "写入脑图": "pipelineProgress.details.savingMindmap",
  "正在请求模型写摘要": "pipelineProgress.details.requestingSummary",
  "写入摘要": "pipelineProgress.details.savingSummary",
  "正在请求模型整理笔记": "pipelineProgress.details.requestingNotes",
  "写入笔记": "pipelineProgress.details.savingNotes",
  "已取消": "pipelineProgress.details.canceled",
  "应用已重启，处理被中断，请重试": "pipelineProgress.details.interruptedByRestart",
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

function localizedDetail(detail: string, t: Translate): string | undefined {
  const exactKey = DETAIL_LABEL_KEY[detail];
  if (exactKey) return t(exactKey);

  let match = detail.match(/^AI 纠正文稿 (\d+)\/(\d+) 段$/);
  if (match) {
    return t("pipelineProgress.details.correctingTranscriptProgress", {
      done: Number(match[1]),
      total: Number(match[2]),
    });
  }
  match = detail.match(/^压缩长讲稿 (\d+)\/(\d+) 块$/);
  if (match) {
    return t("pipelineProgress.details.compressingTranscript", {
      done: Number(match[1]),
      total: Number(match[2]),
    });
  }
  match = detail.match(/^使用可用模型：(.+)$/);
  if (match) return t("pipelineProgress.details.usingModel", { model: match[1] });
  match = detail.match(/^Whisper 识别中（(.+)）$/);
  if (match) return t("pipelineProgress.details.whisperAsr", { language: match[1] });
  match = detail.match(/^云端识别中（阿里云 (.+)）$/);
  if (match) return t("pipelineProgress.details.aliyunAsr", { model: match[1] });
  match = detail.match(/^提取到 (\d+) 页课件$/);
  if (match) return t("pipelineProgress.details.slidesExtracted", { count: Number(match[1]) });
  return undefined;
}

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

/** 卡片上那行字：已知后端细节走 i18n，未知运行细节退回阶段名，失败保留诊断。 */
export function stageMessage(job: StageJob | undefined, t?: Translate): string {
  if (!job) return t ? t("pipelineProgress.waiting") : "等待中";
  const detail = job.message?.trim();
  if (!t) return detail || STAGE_LABEL[job.stage] || job.stage;

  const stage = STAGE_LABEL_KEY[job.stage]
    ? t(STAGE_LABEL_KEY[job.stage])
    : t("pipelineProgress.unknownStage", { stage: job.stage });
  if (!detail) return stage;
  const localized = localizedDetail(detail, t);
  if (localized) return localized;
  // 失败原因不能静默丢弃；正常运行中的未知后端文案则退回本地化阶段名，
  // 避免英文界面直接出现无法理解的中文实现细节。
  if (job.status === "failed") {
    return t("pipelineProgress.failed", { stage, error: detail });
  }
  return t("pipelineProgress.unknownRunningDetail", { stage, detail });
}
