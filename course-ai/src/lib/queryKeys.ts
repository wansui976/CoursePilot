/**
 * 全部 React Query 缓存键的唯一出处。
 *
 * 键的形状就是缓存契约：`invalidateQueries` 按前缀匹配，`qk.videos.all()` 会连带
 * 失效所有 `qk.videos.list(courseId)`。改动形状前先确认没有调用方依赖旧前缀。
 * 带 `all()` 的分组表示「这个前缀本身会被拿来整组失效」。
 */

/** 后端流水线里会产出、并按 `[产物名, videoId]` 缓存的 AI 产物（与后端 TRACKED_ARTIFACTS 一致）。 */
export type ArtifactKind = "chapters" | "summary" | "notes" | "quiz" | "mindmap";

export const qk = {
  courses: () => ["courses"] as const,
  videos: {
    all: () => ["videos"] as const,
    list: (courseId: string | null) => ["videos", courseId] as const,
  },
  processingVideos: () => ["processing-videos"] as const,
  pipelineJobs: (videoId: string) => ["pipeline-jobs", videoId] as const,
  trash: () => ["trash"] as const,
  mediaUrl: {
    all: () => ["media-url"] as const,
    video: (videoId: string | undefined) => ["media-url", videoId] as const,
  },

  // —— 单个视频的资料 ——
  /** AI 产物键。流水线完成事件按阶段名失效，所以产物名必须与阶段名一致。 */
  artifact: (kind: ArtifactKind, videoId: string) => [kind, videoId] as const,
  staleArtifacts: (videoId: string) => ["ai-stale", videoId] as const,
  transcripts: (videoId: string) => ["transcripts", videoId] as const,
  slides: (videoId: string) => ["slides", videoId] as const,
  slideImage: (videoId: string, imagePath: string) =>
    ["slide-image", videoId, imagePath] as const,
  screenshots: (videoId: string) => ["screenshots", videoId] as const,
  clips: (videoId: string) => ["clips", videoId] as const,
  comments: (videoId: string) => ["videoComments", videoId] as const,
  danmaku: (videoId: string) => ["danmaku", videoId] as const,
  videoCover: (videoId: string) => ["video-cover", videoId] as const,
  videoCrop: (videoId: string) => ["video-crop", videoId] as const,
  silenceSkips: (videoId: string) => ["video-skips", videoId] as const,

  // —— 课程知识点 ——
  courseKnowledge: (courseId: string) => ["course-knowledge", courseId] as const,
  courseConcepts: (courseId: string) => ["course-concepts", courseId] as const,

  // —— 间隔复习 ——
  srs: {
    countDue: () => ["srs-count-due"] as const,
    nextDue: () => ["srs-next-due"] as const,
    dueByCourse: () => ["srs-due-by-course"] as const,
    conceptDue: {
      all: () => ["srs-concept-due"] as const,
      course: (courseId: string) => ["srs-concept-due", courseId] as const,
    },
    /** 复习会话锁定的一副牌：带会话序号，重新打开必然重新查库。 */
    session: (sessionId: number) => ["srs-due-session", sessionId] as const,
    conceptSession: (courseId: string, conceptId: string, sessionId: number) =>
      ["srs-due-concept", courseId, conceptId, sessionId] as const,
  },
  weakConcepts: () => ["weak-concepts"] as const,

  // —— 学习统计 ——
  stats: {
    continue: () => ["stats-continue"] as const,
    daily: (day: string) => ["stats-daily", day] as const,
    courses: () => ["stats-courses"] as const,
    courseVideoIds: () => ["stats-course-video-ids"] as const,
    videoProgress: () => ["stats-video-progress"] as const,
  },

  // —— 开发者控制台 ——
  devLogs: () => ["dev-logs"] as const,
  llmUsage: () => ["llm-usage"] as const,
};
