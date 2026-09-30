import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { qk } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronLeft,
  Film,
  FolderPlus,
  LayoutGrid,
  Lightbulb,
  List,
  Loader2,
  MoreHorizontal,
  Play,
  Search,
  Shrink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useCreateCourse } from "@/features/library/CourseList";
import { ImportVideoButton } from "@/features/library/ImportVideoDialog";
import { SortableVideoItem, SortableVideos } from "@/features/library/SortableVideos";
import { VideoCover } from "@/features/library/VideoCover";
import { Badge, type BadgeTone } from "@/ui/badge";
import { EmptyState } from "@/ui/empty-state";
import { ErrorNote } from "@/ui/ErrorNote";
import { IconButton } from "@/ui/icon-button";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { Menu, MenuItem } from "@/ui/menu";
import { ipc } from "@/lib/ipc";
import { stageMessage } from "@/lib/pipelineProgress";
import { canRecorrect } from "@/lib/videoActions";
import type { Video, VideoListItem } from "@/lib/types";
import { formatMs } from "@/lib/time";
import { displayTitle } from "@/lib/videoTitle";
import { WATCHED_RATIO, readLastVideoId, readPlaybackProgress } from "@/lib/playback";
import { useJobs } from "@/stores/jobs";
import type { ProcessingQueue } from "./useProcessingQueue";
import type { Recorrection } from "./useRecorrection";

const statusLabelKey = {
  pending: "home.statusPending",
  processing: "home.statusProcessing",
  done: "home.statusDone",
  failed: "home.statusFailed",
} as const;

const statusTone: Record<Video["processed_status"], BadgeTone> = {
  pending: "neutral",
  processing: "processing",
  done: "success",
  failed: "danger",
};

const VIEW_STORAGE_KEY = "course-ai-home-view";
const GRID_DENSITY_KEY = "course-ai-grid-density";

type GridDensity = "cozy" | "compact";

function readGridDensity(): GridDensity {
  if (typeof window === "undefined") return "cozy";
  return window.localStorage.getItem(GRID_DENSITY_KEY) === "compact"
    ? "compact"
    : "cozy";
}

type LibraryView = "grid" | "list";

function readInitialView(): LibraryView {
  if (typeof window === "undefined") return "grid";
  return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list"
    ? "list"
    : "grid";
}

/** 与 Home 返回键逻辑同口径：最后一个真正可见的菜单。 */
function lastVisibleMenu() {
  const menus = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menu"]:not([hidden])'),
  ).filter(
    (menu) => !menu.closest('[hidden], [aria-hidden="true"], [data-state="inactive"]'),
  );
  return menus[menus.length - 1] ?? null;
}

/**
 * 课程库主区：未选课程时的空态 / 新建课程入口，选中课程后的顶栏（搜索、视图切换、
 * 知识点、导入）与视频网格/列表（拖拽排序、⋯ 菜单、就地改名、处理进度、续看横幅）。
 *
 * 菜单与改名框是本视图的临时层，经 onTransientCloseChange 注册给 Home 的系统返回。
 * 搜索词由 Home 持有：打开视频时本视图会卸载，返回后搜索应当还在。
 */
export function CourseLibraryView({
  courseId,
  videoQuery,
  onVideoQueryChange,
  isPhoneDevice,
  queue,
  recorrection,
  openVideo,
  onBackToCourses,
  onOpenConcepts,
  onVideoDeleted,
  onTransientCloseChange,
}: {
  courseId: string | null;
  videoQuery: string;
  onVideoQueryChange: (query: string) => void;
  isPhoneDevice: boolean;
  queue: ProcessingQueue;
  recorrection: Recorrection;
  openVideo: (videoId: string) => void;
  onBackToCourses: () => void;
  onOpenConcepts: () => void;
  onVideoDeleted: (videoId: string) => void;
  onTransientCloseChange?: (close: (() => HTMLElement | null) | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const selectedCourseId = courseId;
  const setVideoQuery = onVideoQueryChange;
  const { startProcessing, activeJobFor, pipelineProgressFor } = queue;
  const { recorrect, recorrectTarget, recorrectError, requestRecorrection } = recorrection;
  const jobsByVideo = useJobs((s) => s.byVideo);
  const {
    data: videos = [],
    isPending: videosPending,
    isError: videosError,
    error: videosErrorObj,
    refetch: refetchVideos,
  } = useQuery(queries.videos(selectedCourseId));
  const { data: courses = [] } = useQuery(queries.courses());
  const selectedCourse = courses.find((course) => course.id === selectedCourseId);
  const [view, setView] = useState<LibraryView>(readInitialView);
  // 网格卡片密度（舒适/紧凑）：只影响网格列宽，切到列表视图无意义但保留记忆。
  const [gridDensity, setGridDensity] = useState<GridDensity>(readGridDensity);
  const [openMenuVideoId, setOpenMenuVideoId] = useState<string | null>(null);
  const [renamingVideo, setRenamingVideo] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const videoMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameOriginTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameDialogRef = useRef<HTMLDivElement | null>(null);
  const { createCourse, creatingCourse, createError } = useCreateCourse();

  // 顶栏副标「已看完 N 个」：本地按播放进度聚合，零后端改动。
  // 不 memo：看完一集从工作台返回时 videos 引用不变（react-query 结构共享），
  // memo 会停在旧值，而卡片 ov-bar 是渲染期直读 localStorage 反而是新的——同屏打架。
  // 直接渲染期算（几十集的规模，localStorage 读几十次无开销），与卡片进度同源同步。
  const watchedCount = videos.filter(
    (video) => readPlaybackProgress(video.id).ratio >= WATCHED_RATIO,
  ).length;
  // 顶栏搜索框：按 / 全局聚焦（只在搜索框确实渲染时挂监听）。
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const librarySearchVisible = Boolean(selectedCourseId && videos.length > 0);
  useEffect(() => {
    if (!librarySearchVisible) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      librarySearchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [librarySearchVisible]);

  const normalizedQuery = videoQuery.trim().toLowerCase();
  // 过滤只影响展示；排序、菜单上移/下移等按全量 videos 计算。
  const visibleVideos = normalizedQuery
    ? videos.filter((video) =>
        displayTitle(video.title).toLowerCase().includes(normalizedQuery),
      )
    : videos;

  const reorderVideos = useMutation({
    mutationFn: (orderedIds: string[]) =>
      ipc.videos.reorder(selectedCourseId!, orderedIds),
    // 乐观更新：拖放一松手就按新顺序渲染；后端失败时 onError 拉回真实顺序。
    onMutate: (orderedIds) => {
      queryClient.setQueryData<Video[]>(["videos", selectedCourseId], (old) => {
        if (!old) return old;
        const byId = new Map(old.map((video) => [video.id, video]));
        const next = orderedIds.flatMap((id) => byId.get(id) ?? []);
        return next.length === old.length ? next : old;
      });
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.videos.list(selectedCourseId),
      });
    },
  });

  function changeView(next: LibraryView) {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  // 网格密度：舒适 ↔ 紧凑，只影响网格列宽。
  function toggleGridDensity() {
    setGridDensity((current) => {
      const next = current === "cozy" ? "compact" : "cozy";
      window.localStorage.setItem(GRID_DENSITY_KEY, next);
      return next;
    });
  }

  // 卡片「⋯」菜单:点菜单与触发按钮之外的任意位置即收起(都打了 data-video-menu)。
  useEffect(() => {
    if (!openMenuVideoId) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-video-menu]")) return;
      setOpenMenuVideoId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenuVideoId]);

  const restoreFocus = useCallback((target: HTMLElement | null) => {
    queueMicrotask(() => {
      if (target?.isConnected) target.focus();
    });
  }, []);

  const closeVideoMenuAndRestoreFocus = useCallback(() => {
    const trigger = videoMenuTriggerRef.current;
    setOpenMenuVideoId(null);
    restoreFocus(trigger);
  }, [restoreFocus]);

  const cancelVideoRename = useCallback(() => {
    const trigger = renameOriginTriggerRef.current;
    setRenamingVideo(null);
    restoreFocus(trigger);
  }, [restoreFocus]);

  async function saveRenamedVideo() {
    if (!renamingVideo) return;
    const videoId = renamingVideo.id;
    const originTrigger = renameOriginTriggerRef.current;
    const title = renamingVideo.title.trim();
    if (!title) return;
    const current = videos.find((video) => video.id === videoId);
    if (current && current.title === title) {
      const shouldRestoreFocus = renameDialogRef.current?.contains(document.activeElement) ?? false;
      setRenamingVideo(null);
      if (shouldRestoreFocus) restoreFocus(originTrigger);
      return;
    }
    await ipc.videos.updateTitle(videoId, title);
    const shouldRestoreFocus = renameDialogRef.current?.contains(document.activeElement) ?? false;
    setRenamingVideo(null);
    if (shouldRestoreFocus) restoreFocus(originTrigger);
    await queryClient.invalidateQueries({ queryKey: qk.videos.list(selectedCourseId) });
  }

  async function deleteVideo(videoId: string) {
    const ok = await confirmDialog(
      t("home.deleteConfirm"),
      { title: t("home.deleteTitle"), kind: "warning", okLabel: t("home.deleteLabel"), cancelLabel: t("home.cancel") },
    );
    if (!ok) return;
    await ipc.videos.delete(videoId);
    onVideoDeleted(videoId);
    await queryClient.invalidateQueries({ queryKey: qk.videos.list(selectedCourseId) });
    await queryClient.invalidateQueries({ queryKey: qk.trash() });
  }

  // 视频卡片上的「⋯」操作按钮（网格/列表共用）。
  function videoOptionsButton(video: Video) {
    return (
      <IconButton
        ref={(node) => {
          if (openMenuVideoId === video.id && node) videoMenuTriggerRef.current = node;
        }}
        type="button"
        aria-label={t("home.videoActions")}
        aria-haspopup="menu"
        aria-expanded={openMenuVideoId === video.id}
        data-video-menu
        className="ca-touch-44 absolute right-3 top-3 h-7 w-7 rounded-full bg-[var(--surface-panel)] shadow-[var(--shadow-raise)]"
        onClick={(event) => {
          videoMenuTriggerRef.current = event.currentTarget;
          setOpenMenuVideoId((id) => (id === video.id ? null : video.id));
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>
    );
  }

  // 菜单要按「有没有文稿」在「重新纠错」和「开始处理」之间选，所以收的是列表条目而不是裸 Video。
  function videoMenu(video: VideoListItem) {
    if (openMenuVideoId !== video.id) return null;
    const index = videos.findIndex((item) => item.id === video.id);
    // 拖拽排序的键盘/无障碍替代：与相邻项交换位置，走同一个乐观更新 mutation。
    const moveTo = (targetIndex: number) => {
      setOpenMenuVideoId(null);
      const ids = videos.map((item) => item.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(targetIndex, 0, moved);
      reorderVideos.mutate(ids);
    };
    return (
      <Menu
        aria-label={t("home.videoActionsMenu")}
        data-video-menu
        className="absolute right-3 top-12 z-10 w-32"
        onClose={() => setOpenMenuVideoId(null)}
        triggerRef={videoMenuTriggerRef}
      >
        <MenuItem
          className="ca-touch-44"
          onClick={() => {
            renameOriginTriggerRef.current = videoMenuTriggerRef.current;
            setOpenMenuVideoId(null);
            setRenamingVideo({ id: video.id, title: displayTitle(video.title) });
          }}
        >
          {t("home.editTitle")}
        </MenuItem>
        {/* 过滤态下移动的是全量列表位置、界面上看不出效果，藏掉避免困惑。 */}
        {!normalizedQuery && index > 0 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index - 1)}>
            {t("home.moveUp")}
          </MenuItem>
        )}
        {!normalizedQuery && index !== -1 && index < videos.length - 1 && (
          <MenuItem className="ca-touch-44" onClick={() => moveTo(index + 1)}>
            {t("home.moveDown")}
          </MenuItem>
        )}
        <MenuItem
          className="ca-touch-44"
          disabled={canRecorrect(video) && recorrect.isPending}
          onClick={() => {
            setOpenMenuVideoId(null);
            if (canRecorrect(video)) {
              if (recorrect.isPending) return;
              void requestRecorrection(video);
            } else {
              startProcessing(video);
            }
          }}
        >
          {canRecorrect(video)
            ? recorrect.isPending && recorrect.variables?.videoId === video.id
              ? t("home.correcting")
              : t("home.reCorrect")
            : t("home.startProcessing")}
        </MenuItem>
        {/* 危险操作放最后并用分隔线隔开，避免夹在常规操作中间被误点。 */}
        <MenuItem
          tone="danger"
          className="ca-touch-44 mt-1 border-t border-[var(--border-subtle)] pt-2.5"
          onClick={() => {
            setOpenMenuVideoId(null);
            void deleteVideo(video.id);
          }}
        >
          {t("home.delete")}
        </MenuItem>
      </Menu>
    );
  }

  function videoRenameBox(video: Video) {
    if (renamingVideo?.id !== video.id) return null;
    return (
      <div
        ref={renameDialogRef}
        role="dialog"
        aria-label={t("home.editTitle")}
        className="absolute inset-x-3 top-12 z-20 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2 shadow-[var(--shadow-pop)]"
      >
        <label className="sr-only" htmlFor={`rename-${video.id}`}>
          {t("home.videoTitle")}
        </label>
        <input
          id={`rename-${video.id}`}
          aria-label={t("home.videoTitle")}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 w-full rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1.5 text-xs text-[var(--text-strong)] outline-none"
          value={renamingVideo.title}
          onChange={(event) =>
            setRenamingVideo({ id: video.id, title: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") void saveRenamedVideo();
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelVideoRename();
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-1">
          <button
            type="button"
            aria-label={t("home.cancelEdit")}
            className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)]"
            onClick={cancelVideoRename}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("home.saveTitle")}
            className="ca-touch-44 flex h-7 w-7 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-strong)] hover:bg-[var(--surface-card-hover)] disabled:opacity-50"
            disabled={!renamingVideo.title.trim()}
            onClick={() => void saveRenamedVideo()}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  function statusBadge(video: Video) {
    const status = video.processed_status;
    return (
      <Badge
        data-testid="video-status-badge"
        tone={statusTone[status]}
      >
        {t(statusLabelKey[status])}
      </Badge>
    );
  }

  function renderVideoGridCard(video: VideoListItem) {
    const progress = readPlaybackProgress(video.id);
    const durationMs =
      video.duration_ms ??
      (progress.durationSec ? Math.round(progress.durationSec * 1000) : null);
    return (
      <article
        key={video.id}
        className="ca-card group relative"
      >
        <button
          className="block w-full text-left"
          aria-label={t("home.openVideo", { title: displayTitle(video.title) })}
          onClick={() => openVideo(video.id)}
        >
          <span className="ca-thumb">
            <VideoCover
              videoId={video.id}
              className="absolute inset-0 h-full w-full"
            />
            {/* 悬停快捷播放：整卡本就是一个可点按钮，这里只做视觉 affordance（装饰，不嵌套真按钮）。 */}
            <span
              aria-hidden="true"
              className="ca-card-play pointer-events-none absolute inset-0 z-10 grid place-items-center"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/25 backdrop-blur-sm">
                <Play className="h-6 w-6 fill-current" />
              </span>
            </span>
            <span className="st">{statusBadge(video)}</span>
            {/* 时长未知就不显示角标：假的「00:00」会让人以为视频是空的。 */}
            {durationMs != null && (
              <span className="dur">{formatMs(durationMs)}</span>
            )}
            {progress.ratio >= WATCHED_RATIO && (
              <span className="done">
                <Check className="h-3 w-3" />
                {t("home.watched")}
              </span>
            )}
            {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
              <span
                className="ov-bar"
                aria-label={t("home.watchedPercent", { percent: Math.round(progress.ratio * 100) })}
              >
                <i style={{ width: `${progress.ratio * 100}%` }} />
              </span>
            )}
          </span>
          <span className="ca-card-body">
            <span className="ca-card-title">
              {displayTitle(video.title)}
            </span>
            {renderVideoMetaLine(video, progress, durationMs)}
          </span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  /** 卡片 body 的学习信息行：时长 · 进度 / ✓ 已看完 / 处理中实时进度 / 失败提示。
   *  时长未知只显示状态部分，不编假时长。 */
  function renderVideoMetaLine(
    video: VideoListItem,
    progress: ReturnType<typeof readPlaybackProgress>,
    durationMs: number | null,
  ) {
    const durationText = durationMs != null ? formatMs(durationMs) : null;
    const jobs = jobsByVideo[video.id] ?? {};
    const hasJobs = Object.keys(jobs).length > 0;
    // 处理中：jobs 数据到了才接管 meta 行；没到退回静态「处理中」徽标，不显示空进度条。
    if (video.processed_status === "processing" && hasJobs) {
      const stage = activeJobFor(video.id);
      return (
        <span className="ca-card-meta">
          <span className="ca-meta-progress" aria-hidden="true">
            <i style={{ width: `${Math.round(pipelineProgressFor(video.id) * 100)}%` }} />
          </span>
          <span className="ca-meta-text accent truncate">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {stageMessage(stage, t)}
          </span>
        </span>
      );
    }
    if (video.processed_status === "failed") {
      return (
        <span className="ca-card-meta">
          <span className="ca-meta-text err truncate">{t("home.processingFailedMeta")}</span>
        </span>
      );
    }
    if (progress.ratio >= WATCHED_RATIO) {
      return (
        <span className="ca-card-meta">
          {durationText != null && <span className="ca-meta-text">{durationText} · </span>}
          {/* 整串带 ✓，避免与封面「已看完」徽标在文本查询上撞车。 */}
          <span className="ca-meta-text ok">{`✓ ${t("home.watched")}`}</span>
        </span>
      );
    }
    if (progress.ratio > 0) {
      const percent = Math.round(progress.ratio * 100);
      return (
        <span className="ca-card-meta">
          {durationText != null && <span className="ca-meta-text">{durationText} · </span>}
          <span className="ca-meta-text accent">
            {t("home.watchedPercentShort", { percent })}
          </span>
        </span>
      );
    }
    return durationText != null ? (
      <span className="ca-card-meta">
        <span className="ca-meta-text">{durationText}</span>
      </span>
    ) : null;
  }

  function renderVideoListRow(video: VideoListItem) {
    const progress = readPlaybackProgress(video.id);
    const durationMs =
      video.duration_ms ??
      (progress.durationSec ? Math.round(progress.durationSec * 1000) : null);
    // 列表要保持列对齐，时长未知显示占位而不是假的 00:00。
    const durationText = durationMs ? formatMs(durationMs) : "--:--";
    return (
      <article
        key={video.id}
        className="ca-row group relative"
      >
        <button
          className="row-button"
          aria-label={t("home.openVideo", { title: displayTitle(video.title) })}
          onClick={() => openVideo(video.id)}
        >
          <span className="row-main">
            <span className="row-thumb">
              <VideoCover
                videoId={video.id}
                className="absolute inset-0 h-full w-full"
              />
              {progress.ratio >= WATCHED_RATIO && (
                <span className="done" role="img" aria-label={t("home.watched")}>
                  <Check className="h-3 w-3" />
                </span>
              )}
              {progress.ratio > 0 && progress.ratio < WATCHED_RATIO && (
                <span
                  className="ov-bar"
                  aria-label={t("home.watchedPercent", { percent: Math.round(progress.ratio * 100) })}
                >
                  <i style={{ width: `${progress.ratio * 100}%` }} />
                </span>
              )}
            </span>
            <span className="row-name">
              <span className="t">{displayTitle(video.title)}</span>
              <span className="s">{durationText}</span>
            </span>
          </span>
          {renderListProgressCell(video, progress)}
          <span className="c-dur">{durationText}</span>
        </button>
        {videoOptionsButton(video)}
        {videoMenu(video)}
        {videoRenameBox(video)}
      </article>
    );
  }

  /** 列表「进度」列：处理中/失败由文字承担（状态徽标不再单列），看完/已看/未看三态文字。 */
  function renderListProgressCell(
    video: VideoListItem,
    progress: ReturnType<typeof readPlaybackProgress>,
  ) {
    const jobs = jobsByVideo[video.id] ?? {};
    const hasJobs = Object.keys(jobs).length > 0;
    if (video.processed_status === "processing" && hasJobs) {
      return (
        <span className="c-progress processing">
          <Loader2 className="h-3 w-3 flex-none animate-spin" aria-hidden="true" />
          <span className="min-w-0 truncate">{stageMessage(activeJobFor(video.id), t)}</span>
          <span className="accent flex-none">{Math.round(pipelineProgressFor(video.id) * 100)}%</span>
        </span>
      );
    }
    if (video.processed_status === "failed") {
      return <span className="c-progress err">{t("home.processingFailedMeta")}</span>;
    }
    if (progress.ratio >= WATCHED_RATIO) {
      return <span className="c-progress ok">{`✓ ${t("home.watched")}`}</span>;
    }
    if (progress.ratio > 0) {
      return (
        <span className="c-progress accent">
          {t("home.watchedPercentShort", { percent: Math.round(progress.ratio * 100) })}
        </span>
      );
    }
    return <span className="c-progress">{t("home.notWatched")}</span>;
  }

  // 「继续学习」hero 卡：该课程最近打开、且看了但没看完的视频，一键回到工作台
  // （播放器自带断点续播）。搜索过滤时不显示（那会儿用户在找别的）。
  function renderContinueBanner() {
    if (!selectedCourseId || normalizedQuery) return null;
    const lastId = readLastVideoId(selectedCourseId);
    if (!lastId) return null;
    const lastVideo = videos.find((video) => video.id === lastId);
    if (!lastVideo) return null;
    const progress = readPlaybackProgress(lastId);
    if (progress.ratio <= 0 || progress.ratio >= WATCHED_RATIO) return null;
    const positionMs = Math.round(progress.positionSec * 1000);
    const percent = Math.round(progress.ratio * 100);
    return (
      <button
        type="button"
        className="ca-continue-hero group"
        aria-label={t("home.continueLearning", { title: displayTitle(lastVideo.title) })}
        onClick={() => openVideo(lastId)}
      >
        <span className="ca-continue-cover">
          <VideoCover
            videoId={lastVideo.id}
            className="absolute inset-0 h-full w-full"
          />
          <span className="ov-bar" aria-hidden="true">
            <i style={{ width: `${progress.ratio * 100}%` }} />
          </span>
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="ca-continue-label">{t("home.continueLearningLabel")}</span>
          <span className="ca-continue-title truncate">{displayTitle(lastVideo.title)}</span>
          <span className="ca-continue-pos">
            {t("home.continueAt", { time: formatMs(positionMs) })}
            <span className="ca-continue-pct"> · {t("home.watchedPercentShort", { percent })}</span>
          </span>
        </span>
        <span className="ca-continue-play" aria-hidden="true">
          <Play className="h-5 w-5" />
        </span>
      </button>
    );
  }

  function renderCourseVideoLibrary() {
    // 视频列表还没回来时的骨架：顶栏照常（课程名来自 courses 查询，不闪），
    // 正文按当前视图档位铺占位卡。条件必须带 selectedCourseId——
    // enabled:false 时 isPending 恒为 true，不判课程 id 会让「未选课程」永远停在骨架。
    function renderLibrarySkeleton() {
      if (view === "list") {
        return (
          <div className="ca-list" role="status" aria-label={t("home.loadingVideos")}>
            <div className="ca-list-head">
              <span>{t("home.colName")}</span>
              <span className="h-progress">{t("home.colProgress")}</span>
              <span className="h-dur">{t("home.colDuration")}</span>
            </div>
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="ca-row" aria-hidden="true">
                <div className="row-button pointer-events-none">
                  <span className="row-main">
                    <span className="row-thumb">
                      <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
                    </span>
                    <span className="row-name">
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </span>
                  </span>
                  <span className="c-progress">
                    <Skeleton className="h-3 w-16" />
                  </span>
                  <span className="c-dur">
                    <Skeleton className="h-3 w-10" />
                  </span>
                </div>
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="ca-grid" role="status" aria-label={t("home.loadingVideos")}>
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="ca-card pointer-events-none" aria-hidden="true">
              <div className="ca-thumb">
                <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
              </div>
              <div className="ca-card-body">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="ca-main-col">
        <header className="ca-topbar">
          <div className="tb-lead">
            {isPhoneDevice && (
              <button
                type="button"
                className="hamb"
                onClick={onBackToCourses}
                title={t("home.backToLibrary")}
                aria-label={t("home.backToLibrary")}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="tb-titles">
              {/* h1 给课程名（用户关心「我在哪个课程」），数量降为副标题。 */}
              <h1>{selectedCourse ? selectedCourse.name : t("home.courseVideos")}</h1>
              <div className="sub">
                {selectedCourse ? (
                  <>
                    {t("home.videoCount", { count: videos.length })}
                    {watchedCount > 0 && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span>{t("home.watchedCount", { count: watchedCount })}</span>
                        <span className="ca-sub-progress" aria-hidden="true">
                          <i style={{ width: `${(watchedCount / videos.length) * 100}%` }} />
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  t("home.selectCourseHint")
                )}
              </div>
            </div>
          </div>
          {selectedCourseId && (
            <div className="tb-actions">
              {videos.length > 0 && (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-faint)]"
                    aria-hidden="true"
                  />
                  <input
                    ref={librarySearchRef}
                    aria-label={t("home.searchVideos")}
                    placeholder={t("home.searchVideos")}
                    className="tb-search ca-touch-44 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-input)] py-2 pl-9 pr-9 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-[var(--focus-ring)] [&::-webkit-search-cancel-button]:appearance-none"
                    value={videoQuery}
                    onChange={(event) => setVideoQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setVideoQuery("");
                    }}
                  />
                  {videoQuery !== "" && (
                    <button
                      type="button"
                      aria-label={t("home.clearSearch")}
                      title={t("home.clearSearch")}
                      onClick={() => setVideoQuery("")}
                      className="ca-touch-44 absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {videos.length > 0 && (
                <div className="ca-seg">
                  {(
                    [
                      ["grid", LayoutGrid, t("home.gridView")],
                      ["list", List, t("home.listView")],
                    ] as const
                  ).map(([key, Icon, label]) => (
                    <button
                      key={key}
                      aria-label={label}
                      aria-pressed={view === key}
                      onClick={() => changeView(key)}
                      className={view === key ? "on" : ""}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                  {/* 网格密度：仅网格视图下有意义；图标随当前密度提示下一步切换。 */}
                  {view === "grid" && (
                    <button
                      aria-label={
                        gridDensity === "cozy"
                          ? t("home.switchToCompact")
                          : t("home.switchToCozy")
                      }
                      title={
                        gridDensity === "cozy"
                          ? t("home.switchToCompact")
                          : t("home.switchToCozy")
                      }
                      aria-pressed={gridDensity === "compact"}
                      onClick={toggleGridDensity}
                      className={gridDensity === "compact" ? "on" : ""}
                    >
                      <Shrink className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {videos.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenConcepts}
                  className="ca-touch-44"
                >
                  <Lightbulb className="h-4 w-4" />
                  {t("home.knowledgePoints")}
                </Button>
              )}
              <ImportVideoButton
                courseId={selectedCourseId}
                onStartProcessing={startProcessing}
              />
            </div>
          )}
        </header>
        <div className="ca-scroll">
          {recorrectError && (
            <ErrorNote
              error={recorrectError}
              onRetry={
                recorrectTarget
                  ? () => recorrect.mutate(recorrectTarget)
                  : undefined
              }
              className="mx-4 mt-3"
            />
          )}
          {!videosError && renderContinueBanner()}
          {selectedCourseId && videosPending ? (
            renderLibrarySkeleton()
          ) : selectedCourseId && videosError ? (
            // 加载失败不再静默留空：显示错误 + 重试，用户能看到问题也能自助恢复。
            <div className="flex h-full min-h-[320px] items-center justify-center p-4">
              <ErrorNote
                error={videosErrorObj}
                onRetry={() => refetchVideos()}
                className="max-w-md"
              />
            </div>
          ) : !selectedCourseId || videos.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState
                icon={<Film className="h-7 w-7" />}
                title={selectedCourseId ? t("home.noVideos") : t("home.noCourses")}
                description={
                  selectedCourseId
                    ? t("home.noVideosHint")
                    : undefined
                }
                action={
                  selectedCourseId ? (
                    <ImportVideoButton
                      courseId={selectedCourseId}
                      onStartProcessing={startProcessing}
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2">
                      <Button
                        type="button"
                        disabled={creatingCourse}
                        onClick={() => void createCourse()}
                      >
                        {creatingCourse ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <FolderPlus className="h-4 w-4" />
                        )}
                        {creatingCourse ? t("nav.addingCourse") : t("nav.addCourseFolder")}
                      </Button>
                      {createError && (
                        <ErrorNote className="max-w-sm" error={createError} />
                      )}
                    </div>
                  )
                }
              />
            </div>
          ) : visibleVideos.length === 0 ? (
            <div className="flex h-full min-h-[320px] items-center justify-center">
              <EmptyState
                icon={<Film className="h-7 w-7" />}
                title={t("home.noMatch")}
                description={t("home.noMatchDesc", { query: videoQuery.trim() })}
              />
            </div>
          ) : view === "list" ? (
            <SortableVideos
              ids={visibleVideos.map((video) => video.id)}
              layout="list"
              // 过滤态禁用拖拽：子集顺序映射不回全量，后端也会按 id 全集校验拒绝。
              disabled={renamingVideo !== null || normalizedQuery !== ""}
              onReorder={(orderedIds) => reorderVideos.mutate(orderedIds)}
            >
              <div className="ca-list">
                <div className="ca-list-head">
                  <span>{t("home.colName")}</span>
                  <span className="h-progress">{t("home.colProgress")}</span>
                  <span className="h-dur">{t("home.colDuration")}</span>
                </div>
                {visibleVideos.map((video) => (
                  <SortableVideoItem key={video.id} id={video.id}>
                    {renderVideoListRow(video)}
                  </SortableVideoItem>
                ))}
              </div>
            </SortableVideos>
          ) : (
            <SortableVideos
              ids={visibleVideos.map((video) => video.id)}
              layout="grid"
              disabled={renamingVideo !== null || normalizedQuery !== ""}
              onReorder={(orderedIds) => reorderVideos.mutate(orderedIds)}
            >
              <div className="ca-grid" data-density={gridDensity} aria-label={t("home.videoGrid")}>
                {visibleVideos.map((video) => (
                  <SortableVideoItem key={video.id} id={video.id}>
                    {renderVideoGridCard(video)}
                  </SortableVideoItem>
                ))}
              </div>
            </SortableVideos>
          )}
        </div>
      </div>
    );
  }

  const renaming = renamingVideo !== null;
  useEffect(() => {
    if (!onTransientCloseChange) return;
    onTransientCloseChange(
      openMenuVideoId
        ? () => {
            const menu = lastVisibleMenu();
            closeVideoMenuAndRestoreFocus();
            return menu;
          }
        : renaming
          ? () => {
              const box = renameDialogRef.current;
              cancelVideoRename();
              return box;
            }
          : null,
    );
    return () => onTransientCloseChange(null);
  }, [
    cancelVideoRename,
    closeVideoMenuAndRestoreFocus,
    onTransientCloseChange,
    openMenuVideoId,
    renaming,
  ]);

  return renderCourseVideoLibrary();
}
