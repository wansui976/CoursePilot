const RESUME_PREFIX = "course-ai-resume:";

export type StudyTab = "overview" | "transcript" | "notes" | "quiz" | "more";

export interface VideoResumeState {
  activeTab: StudyTab | null;
  notesScrollTop: number;
  /** 文稿滚动位置（像素 scrollTop）。文稿改回原生滚动后按此恢复。 */
  transcriptScrollTop: number;
  /** @deprecated 旧版虚拟列表存的顶部行号。只读透传给 TranscriptPanel 做一次性迁移
   *（换算成 transcriptScrollTop 后清零），不再写入新值。 */
  transcriptTopIndex: number;
  studyPanelWidth: number | null;
  /** 学习面板是否整体收起（专注看片时藏掉右栏）。 */
  studyPanelCollapsed: boolean;
}

const DEFAULT_RESUME_STATE: VideoResumeState = {
  activeTab: null,
  notesScrollTop: 0,
  transcriptScrollTop: 0,
  transcriptTopIndex: 0,
  studyPanelWidth: null,
  studyPanelCollapsed: false,
};

export function resumeStateKey(videoId: string) {
  return RESUME_PREFIX + videoId;
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isStudyTab(value: unknown): value is StudyTab {
  return (
    value === "overview" ||
    value === "transcript" ||
    value === "notes" ||
    value === "quiz" ||
    value === "more"
  );
}

const LEGACY_TAB_MAP: Record<string, StudyTab> = {
  "概览": "overview",
  "AI 概览": "overview",
  "文稿": "transcript",
  "笔记": "notes",
  "学习": "notes",
  "练习": "quiz",
  "更多": "more",
  "课件": "more",
  "片段": "more",
};

function migrateStudyTab(value: unknown): StudyTab | null {
  if (isStudyTab(value)) return value;
  if (typeof value === "string" && value in LEGACY_TAB_MAP) {
    return LEGACY_TAB_MAP[value];
  }
  return null;
}

export function readVideoResumeState(videoId: string): VideoResumeState {
  try {
    const raw = localStorage.getItem(resumeStateKey(videoId));
    if (!raw) return { ...DEFAULT_RESUME_STATE };
    const parsed = JSON.parse(raw) as Partial<VideoResumeState>;
    return {
      activeTab: migrateStudyTab(parsed.activeTab),
      notesScrollTop: Math.max(0, finiteNumber(parsed.notesScrollTop, 0)),
      transcriptScrollTop: Math.max(0, finiteNumber(parsed.transcriptScrollTop, 0)),
      transcriptTopIndex: Math.max(0, finiteNumber(parsed.transcriptTopIndex, 0)),
      studyPanelWidth: finiteNullableNumber(parsed.studyPanelWidth),
      studyPanelCollapsed: parsed.studyPanelCollapsed === true,
    };
  } catch {
    return { ...DEFAULT_RESUME_STATE };
  }
}

export function writeVideoResumeState(
  videoId: string,
  patch: Partial<VideoResumeState>,
) {
  try {
    const next = { ...readVideoResumeState(videoId), ...patch };
    localStorage.setItem(resumeStateKey(videoId), JSON.stringify(next));
  } catch {
    // Ignore storage failures so the learning workspace remains usable.
  }
}
