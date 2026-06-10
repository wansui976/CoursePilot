const RESUME_PREFIX = "course-ai-resume:";

export type StudyTab = "AI 概览" | "笔记" | "文稿" | "课件";

export interface VideoResumeState {
  activeTab: StudyTab | null;
  notesScrollTop: number;
  transcriptScrollTop: number;
  studyPanelWidth: number | null;
}

const DEFAULT_RESUME_STATE: VideoResumeState = {
  activeTab: null,
  notesScrollTop: 0,
  transcriptScrollTop: 0,
  studyPanelWidth: null,
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
    value === "AI 概览" ||
    value === "笔记" ||
    value === "文稿" ||
    value === "课件"
  );
}

export function readVideoResumeState(videoId: string): VideoResumeState {
  try {
    const raw = localStorage.getItem(resumeStateKey(videoId));
    if (!raw) return { ...DEFAULT_RESUME_STATE };
    const parsed = JSON.parse(raw) as Partial<VideoResumeState>;
    return {
      activeTab: isStudyTab(parsed.activeTab) ? parsed.activeTab : null,
      notesScrollTop: Math.max(0, finiteNumber(parsed.notesScrollTop, 0)),
      transcriptScrollTop: Math.max(0, finiteNumber(parsed.transcriptScrollTop, 0)),
      studyPanelWidth: finiteNullableNumber(parsed.studyPanelWidth),
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
