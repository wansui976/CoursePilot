import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invalidateStaleArtifacts } from "@/lib/useStaleArtifacts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  Locate,
  LocateFixed,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/ui/empty-state";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextSkeleton } from "@/components/ui/skeleton";
import { ExportMenu } from "./ExportMenu";
import { MathText } from "./MathText";
import { ipc } from "@/lib/ipc";
import { buildCloze } from "@/lib/cloze";
import { readVideoResumeState, writeVideoResumeState } from "@/lib/resumeState";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import { useInlineAsk } from "@/stores/inlineAsk";
import type { TranscriptSegment } from "@/lib/types";
import { findActiveSegmentIndex } from "@/lib/transcript";

// 手动滚动后暂停「跟随播放自动居中」的时长；停手超过该窗口才恢复跟随。
const FOLLOW_PAUSE_MS = 4000;

// 搜索高亮：把命中的子串包成 <mark>（q 已小写，按下标切原文保留大小写）。
// 含 $$ 数学公式的行不切——拆散后 MathText 就解析不了公式了，宁可不高亮。
function highlightSegment(text: string, q: string): ReactNode {
  const lowered = text.toLocaleLowerCase();
  if (!q || !lowered.includes(q) || text.includes("$$")) {
    return <MathText text={text} />;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  let at = lowered.indexOf(q);
  let key = 0;
  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={key++} className="rounded bg-[var(--accent-weak-2)] text-[var(--accent-text)]">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    cursor = at + q.length;
    at = lowered.indexOf(q, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// 文稿头部的「播放位置」：只让这个小组件订阅进度（每秒几次重渲染），不波及文稿主体。
function TranscriptPosition() {
  const currentMs = usePlayer((s) => s.currentMs);
  const durationMs = usePlayer((s) => s.durationMs);
  if (durationMs <= 0) return null;
  const percent = Math.min(100, Math.max(0, Math.round((currentMs / durationMs) * 100)));
  return (
    <span className="tabular-nums">
      {formatMs(currentMs)} / {formatMs(durationMs)} · {percent}%
    </span>
  );
}

// content-visibility 按「块」而非按行：每块行数。块少两个数量级，滚动时浏览器的可见性
// 簿记开销小得多；快滑时整块（约一屏半）一次性渲染进来，而不是一行行往外挤，基本不见空白。
const CHUNK_SIZE = 30;
const EMPTY_SEGMENTS: TranscriptSegment[] = [];

// 单行文稿：memo 化，只有活动态变化的行才重渲染（换句时仅两行更新，避免整表重排）。
// 长文稿性能由块级 content-visibility 承担（见 globals.css .ca-transcript-chunk）——
// 浏览器原生跳过屏外块的渲染，滚动是原生的，不存在虚拟列表那种量高回改 scrollTop 的抽搐。
const TranscriptRow = memo(function TranscriptRow({
  index,
  segment,
  active,
  highlight,
  currentMatch,
  onSeek,
  onEdit,
}: {
  index: number;
  segment: TranscriptSegment;
  active: boolean;
  /** 搜索词（小写）。为空不做高亮。 */
  highlight: string;
  /** 当前命中的搜索匹配行（跳转目标）。 */
  currentMatch: boolean;
  onSeek: (ms: number) => void;
  onEdit: (id: number, text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-3 py-0.5">
      <div
        data-row={index}
        className={`group relative rounded ${
          active
            ? "bg-primary/20"
            : currentMatch
              ? "bg-[var(--accent-weak)]"
              : "hover:bg-[var(--surface-card-hover)]"
        }`}
      >
        {/* 文字占满整行宽度：纠错按钮改为绝对定位在右下角，不再在行内流式占位。 */}
        <button
          onClick={() => {
            // 划选文字后抬手会触发这次 click——此时有非空选区，别误触跳转（留给「问 AI」）。
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            onSeek(segment.start_ms);
          }}
          className="block w-full px-2 py-1 text-left text-sm leading-relaxed"
        >
          <span className="mr-2 text-xs text-[var(--text-muted)]">
            {formatMs(segment.start_ms)}
          </span>
          {highlight ? highlightSegment(segment.text, highlight) : (
            <MathText text={segment.text} />
          )}
        </button>
        <button
          data-transcript-edit-id={segment.id}
          aria-label={t("transcript.editButton")}
          title={t("transcript.editButtonTitle")}
          onClick={() => onEdit(segment.id, segment.text)}
          // 用轻量字形代替 lucide SVG：每行少一棵 SVG 子树，屏外行渲染更快、快滑空白更小。
          // 悬停才出现且盖在文字上方；按钮表面保持透明，不挡住文稿内容。
          // 触屏没有 hover：.ca-transcript-edit 在 pointer:coarse 下强制可见（globals.css）。
          className="ca-transcript-edit ca-touch-44 ca-workbench-touch absolute bottom-0.5 right-1 grid h-7 w-7 place-items-center rounded border border-transparent bg-transparent text-[15px] leading-none text-[var(--text-muted)] opacity-0 shadow-none transition hover:bg-transparent hover:text-[var(--text-strong)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </div>
    </div>
  );
});

export function TranscriptPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const transcriptQuery = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });
  const segments = transcriptQuery.data ?? EMPTY_SEGMENTS;
  const requestSeek = usePlayer((s) => s.requestSeek);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 用户手动滚动时间戳：其后一小段窗口内暂停「跟随播放自动居中」，避免与手滚打架而抽搐。
  const userScrollRef = useRef(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  // 就地追问：文稿里选中文字后，在选区上方浮出「问 AI」按钮。
  const [askAnchor, setAskAnchor] = useState<{
    left: number;
    top: number;
    text: string;
    startMs: number | null;
    segmentText: string | null;
  } | null>(null);
  // 挖空成卡成功后短暂提示。
  const [clozeAdded, setClozeAdded] = useState(false);
  // 跟随播放的活动行下标。只在「跨段」时更新（见下方订阅），不随每个进度 tick 重渲染。
  const [activeRowIndex, setActiveRowIndex] = useState(-1);
  // 「跟随播放」显式开关：默认开。手滚暂停跟随的隐式行为保留，开关是显式覆盖——
  // 想钉住某处看别处时不被打断，而不是等 4 秒超时。
  const [followEnabled, setFollowEnabled] = useState(true);
  // 文稿内搜索：open 后出现搜索行；命中高亮 + 上一处/下一处跳转。
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const restoreSearchFocusRef = useRef(false);
  const editOriginIdRef = useRef<number | null>(null);
  const restoreEditFocusRef = useRef(false);
  // 高亮词用 deferred：打字时不逐键重渲染整表（上千行），松手后一次收敛。
  const deferredHighlight = useDeferredValue(searchQuery.trim().toLocaleLowerCase());

  // 仅渲染非空分段：空段是纠错清空的语气词，原本也不显示（且无法被点开编辑）。
  const rows = useMemo(
    () =>
      segments
        .filter((segment) => segment.text.trim() !== "")
        .sort((a, b) => a.start_ms - b.start_ms),
    [segments],
  );
  // 按块分组，块级 content-visibility（见 CHUNK_SIZE 注释）。
  const chunks = useMemo(() => {
    const out: TranscriptSegment[][] = [];
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      out.push(rows.slice(i, i + CHUNK_SIZE));
    }
    return out;
  }, [rows]);

  const update = useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) =>
      ipc.transcripts.update(id, text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transcripts", videoId] });
      // 改过字幕之后，摘要/章节/笔记/题库/脑图讲的都还是旧稿的内容，重新算一次过期标记。
      invalidateStaleArtifacts(qc, videoId);
      setEditingId(null);
    },
  });
  const resetUpdateRef = useRef(update.reset);
  resetUpdateRef.current = update.reset;

  // memo 化行的稳定回调：身份不变，非活动行才不会因父组件重渲染而跟着重渲染。
  const startEdit = useCallback((id: number, text: string) => {
    editOriginIdRef.current = id;
    restoreEditFocusRef.current = false;
    resetUpdateRef.current();
    setEditingId(id);
    setDraft(text);
  }, []);
  const cancelEdit = useCallback(() => {
    restoreEditFocusRef.current = true;
    setEditingId(null);
  }, []);
  useEffect(() => {
    if (editingId != null || !restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    const id = editOriginIdRef.current;
    if (id == null) return;
    document.querySelector<HTMLButtonElement>(`[data-transcript-edit-id="${id}"]`)?.focus();
  }, [editingId]);
  function save() {
    if (editingId == null) return;
    update.mutate({ id: editingId, text: draft });
  }

  // 跟随播放：订阅进度，只在活动行真正变化时 setState，避免每个 tick 重渲染可见行。
  useEffect(() => {
    const compute = (ms: number) => {
      const idx = findActiveSegmentIndex(rows, ms);
      setActiveRowIndex((prev) => (prev === idx ? prev : idx));
    };
    compute(usePlayer.getState().currentMs);
    return usePlayer.subscribe((state, previousState) => {
      if (state.currentMs !== previousState.currentMs) compute(state.currentMs);
    });
  }, [rows]);

  // 手动滚动打时间戳：wheel / 触摸滑动 / 滚动条拖拽 / 键盘翻页都算。程序化 scrollTo
  // 不触发这些事件，只捕获真实手滚。滚动条拖拽不产生 wheel，只能靠「pointer 按住期间
  // 出现的 scroll 事件」识别（见 onScroll）。
  // 依赖 hasRows：字幕异步到达前 scroller 尚未挂载（组件早退），到达后需重跑本效果补挂监听。
  const pointerDownRef = useRef(false);
  const hasRows = rows.length > 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const mark = () => {
      userScrollRef.current = Date.now();
    };
    const pointerDown = () => {
      pointerDownRef.current = true;
    };
    const pointerUp = () => {
      pointerDownRef.current = false;
    };
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    el.addEventListener("pointerdown", pointerDown, { passive: true });
    el.addEventListener("keydown", mark);
    window.addEventListener("pointerup", pointerUp, { passive: true });
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
      el.removeEventListener("pointerdown", pointerDown);
      el.removeEventListener("keydown", mark);
      window.removeEventListener("pointerup", pointerUp);
    };
  }, [hasRows]);

  // 活动行居中（原生 scrollTo 不做量高回改，故不抽搐）。被跟随播放与搜索跳转共用。
  const centerOnRow = useCallback(
    (rowIndex: number) => {
      const scroller = scrollerRef.current;
      const row = scroller?.querySelector<HTMLElement>(
        `[data-row="${rowIndex}"]`,
      );
      if (!scroller || !row) return;
      const sRect = scroller.getBoundingClientRect();
      const rRect = row.getBoundingClientRect();
      const target =
        scroller.scrollTop +
        (rRect.top - sRect.top) -
        (scroller.clientHeight - row.clientHeight) / 2;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const top = Math.max(0, target);
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({
          top,
          behavior: reduceMotion ? "auto" : "smooth",
        });
      } else {
        scroller.scrollTop = top;
      }
    },
    [],
  );

  // 跟随播放：活动行变化时放回视区中线（编辑时不打扰用户）。刚手动滚过则暂停；
  // 关闭开关后完全不跟随——手滚暂停的隐式行为叠加在显式开关之上。
  useEffect(() => {
    if (!followEnabled || activeRowIndex < 0 || editingId != null) return;
    if (Date.now() - userScrollRef.current < FOLLOW_PAUSE_MS) return;
    centerOnRow(activeRowIndex);
  }, [followEnabled, activeRowIndex, editingId, centerOnRow]);

  // 重新开启跟随：立即回到当前句，而不是等下一次换句才动。
  function setFollow(next: boolean) {
    setFollowEnabled(next);
    if (next) {
      userScrollRef.current = 0;
      requestAnimationFrame(() => centerOnRow(activeRowIndex));
    }
  }

  // 搜索命中行（在 rows 里的下标）；打开搜索后打开自动聚焦。
  const searchMatches = useMemo(() => {
    if (!deferredHighlight) return [];
    return rows.reduce<number[]>((acc, row, index) => {
      if (row.text.toLocaleLowerCase().includes(deferredHighlight)) acc.push(index);
      return acc;
    }, []);
  }, [rows, deferredHighlight]);
  useEffect(() => setMatchIndex(0), [deferredHighlight]);
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      return;
    }
    if (!restoreSearchFocusRef.current) return;
    restoreSearchFocusRef.current = false;
    searchTriggerRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = useCallback((clearQuery = false) => {
    restoreSearchFocusRef.current = true;
    setSearchOpen(false);
    if (clearQuery) setSearchQuery("");
  }, []);

  function jumpToMatch(index: number) {
    if (searchMatches.length === 0) return;
    const clamped = (index + searchMatches.length) % searchMatches.length;
    setMatchIndex(clamped);
    centerOnRow(searchMatches[clamped]);
  }

  // 滚动位置恢复：每个视频各恢复一次（组件被 TabsPanel 保活，换视频只变 prop 不重挂，
  // 必须按 videoId 重读、重恢复，否则新视频既不恢复位置、又会被写入旧视频的 scrollTop）。
  // 滚动时节流写入，切走 / 换视频时再补一次。
  const savedScrollTop = useRef(0);
  const restoredForRef = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (restoredForRef.current === videoId) return;
    const saved = readVideoResumeState(videoId);
    // 切视频不能继承上一视频的手滚暂停窗口；但恢复了非零位置时，把恢复本身视作
    // 一次用户定位，避免紧随其后的活动句更新立刻把保存位置抢走。
    userScrollRef.current = saved.transcriptScrollTop > 0 ? Date.now() : 0;
    // 先记下本视频已存的值：即使字幕还没加载就切走，卸载写入也只会原值写回，不会污染。
    savedScrollTop.current = saved.transcriptScrollTop;
    if (rows.length === 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // 旧版虚拟列表存的是顶部行号：换算成该行的像素偏移，一次性迁移后清零。
    if (saved.transcriptScrollTop === 0 && saved.transcriptTopIndex > 0) {
      const row = scroller.querySelector<HTMLElement>(
        `[data-row="${Math.min(saved.transcriptTopIndex, rows.length - 1)}"]`,
      );
      if (row) {
        savedScrollTop.current = Math.max(
          0,
          scroller.scrollTop +
            row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top,
        );
        writeVideoResumeState(videoId, {
          transcriptScrollTop: savedScrollTop.current,
          transcriptTopIndex: 0,
        });
      }
    }
    scroller.scrollTop = savedScrollTop.current;
    restoredForRef.current = videoId;
  }, [videoId, rows.length]);
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        // 必须归位：否则换视频后 onScroll 一直以为有定时器在跑，节流写入永久失效。
        saveTimer.current = undefined;
      }
      writeVideoResumeState(videoId, {
        transcriptScrollTop: savedScrollTop.current,
      });
    };
  }, [videoId]);

  function onScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // pointer 按住期间的滚动 = 拖滚动条（wheel/touchmove 捕获不到），也算手动滚动。
    if (pointerDownRef.current) userScrollRef.current = Date.now();
    savedScrollTop.current = scroller.scrollTop;
    if (saveTimer.current) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      writeVideoResumeState(videoId, {
        transcriptScrollTop: savedScrollTop.current,
      });
    }, 400);
  }

  // 选区结束（抬手）后计算「问 AI」浮层锚点：取选中文本 + 选区所在句的时间戳。
  function refreshAskAnchor() {
    const sel = window.getSelection();
    const scroller = scrollerRef.current;
    if (!sel || sel.isCollapsed || !scroller) {
      setAskAnchor(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text || !sel.anchorNode || !scroller.contains(sel.anchorNode)) {
      setAskAnchor(null);
      return;
    }
    const anchorEl =
      sel.anchorNode.nodeType === Node.ELEMENT_NODE
        ? (sel.anchorNode as Element)
        : sel.anchorNode.parentElement;
    const rowEl = anchorEl?.closest<HTMLElement>("[data-row]");
    const index = rowEl ? Number(rowEl.getAttribute("data-row")) : -1;
    const seg = index >= 0 ? rows[index] : undefined;
    const startMs = seg ? seg.start_ms : null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setAskAnchor({
      left: rect.left + rect.width / 2,
      top: rect.top,
      text,
      startMs,
      segmentText: seg ? seg.text : null,
    });
  }

  // 挖空成卡：把所选词在其所在句里挖空，做成 cloze 复习卡。
  const addCloze = useMutation({
    mutationFn: (vars: { front: string; back: string; startMs: number | null }) =>
      ipc.srs.addCard(videoId, "cloze", vars.front, vars.back, vars.startMs),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["srs-count-due"] });
      setClozeAdded(true);
      window.setTimeout(() => setClozeAdded(false), 1600);
    },
  });

  if (transcriptQuery.isPending) {
    return <TextSkeleton lines={6} label={t("transcript.loading")} />;
  }

  if (transcriptQuery.isError) {
    return (
      <ErrorNote
        className="m-4"
        error={transcriptQuery.error}
        onRetry={() => void transcriptQuery.refetch()}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <PanelEmptyState
        icon={<Captions className="h-7 w-7" />}
        title={t("transcript.emptyTitle")}
        description={t("transcript.emptyDescription")}
      />
    );
  }

  return (
    <div className="flex h-full flex-col text-[var(--text-normal)]">
      <div className="flex flex-none flex-col border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => setFollow(!followEnabled)}
            aria-pressed={followEnabled}
            title={followEnabled ? t("transcript.followOff") : t("transcript.followOn")}
            className={`ca-touch-44 inline-flex items-center gap-1 rounded px-1.5 py-1 font-medium transition-colors ${
              followEnabled
                ? "text-[var(--accent-text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-normal)]"
            }`}
          >
            {followEnabled ? (
              <LocateFixed aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Locate aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {t("transcript.follow")}
          </button>
          <span className="hidden min-w-0 truncate text-[var(--text-faint)] sm:block">
            {t("transcript.rowOf", { current: activeRowIndex + 1, total: rows.length })}
            {" · "}
            <TranscriptPosition />
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <button
              ref={searchTriggerRef}
              type="button"
              onClick={() => {
                if (searchOpen) closeSearch();
                else setSearchOpen(true);
              }}
              aria-pressed={searchOpen}
              aria-label={searchOpen ? t("transcript.closeSearch") : t("transcript.searchInTranscript")}
              title={searchOpen ? t("transcript.closeSearch") : t("transcript.searchInTranscript")}
              className={`ca-touch-44 grid h-8 w-8 place-items-center rounded-md transition-colors ${
                searchOpen
                  ? "bg-[var(--accent-weak)] text-[var(--accent-text)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
              }`}
            >
              <Search aria-hidden="true" className="h-4 w-4" />
            </button>
            <ExportMenu
              items={[
                { label: t("transcript.srtExport"), run: () => ipc.export.subtitles(videoId, "srt"), mime: "application/x-subrip", saveAs: "subtitles.srt" },
                { label: t("transcript.vttExport"), run: () => ipc.export.subtitles(videoId, "vtt"), mime: "text/vtt", saveAs: "subtitles.vtt" },
              ]}
            />
          </div>
        </div>
        {searchOpen && (
          <div
            data-system-back-layer
            className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] px-3 py-1.5 text-xs"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }}
          >
            <Search aria-hidden="true" className="h-3.5 w-3.5 flex-none text-[var(--text-faint)]" />
            <input
              ref={searchInputRef}
              type="search"
              aria-label={t("transcript.searchInTranscript")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") jumpToMatch(matchIndex + 1);
              }}
              placeholder={t("transcript.searchPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2.5 py-1 text-sm text-[var(--text-strong)] placeholder:text-[var(--text-faint)] focus:border-[var(--focus-ring)] [&::-webkit-search-cancel-button]:appearance-none"
            />
            {deferredHighlight && searchMatches.length > 0 && (
              <span className="flex-none tabular-nums text-[var(--text-faint)]">
                {t("transcript.searchMatches", {
                  current: matchIndex + 1,
                  total: searchMatches.length,
                })}
              </span>
            )}
            <button
              type="button"
              onClick={() => jumpToMatch(matchIndex - 1)}
              disabled={searchMatches.length === 0}
              aria-label={t("transcript.previousMatch")}
              className="ca-touch-44 grid h-8 w-8 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:opacity-35"
            >
              <ChevronUp aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => jumpToMatch(matchIndex + 1)}
              disabled={searchMatches.length === 0}
              aria-label={t("transcript.nextMatch")}
              className="ca-touch-44 grid h-8 w-8 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] disabled:opacity-35"
            >
              <ChevronDown aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => closeSearch(true)}
              aria-label={t("transcript.closeSearch")}
              className="ca-touch-44 grid h-8 w-8 place-items-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)]"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <div
        ref={scrollerRef}
        aria-label={t("transcript.scrollArea")}
        // 大 DOM 标记:可见时主题切换走瞬切(见 stores/theme.ts hasVisibleHeavyDom),
        // 避免 VT 双全屏快照/全树过渡在数千节点上造成冻结;tab 非活动(display:none)不算在场。
        data-theme-heavy=""
        onScroll={() => {
          onScroll();
          setAskAnchor(null);
        }}
        onMouseDown={() => setAskAnchor(null)}
        onMouseUp={refreshAskAnchor}
        onTouchEnd={refreshAskAnchor}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        {chunks.map((chunk, chunkIndex) => (
          <div key={chunkIndex} className="ca-transcript-chunk">
            {chunk.map((segment, i) => {
              const index = chunkIndex * CHUNK_SIZE + i;
              return editingId === segment.id ? (
            <div
              key={segment.id}
              data-system-back-layer
              className="px-3 py-0.5"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                cancelEdit();
              }}
            >
              <div className="rounded bg-[var(--surface-card)] p-2">
                <textarea
                  aria-label={t("transcript.editSubtitle")}
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                  }}
                  className="w-full resize-y rounded border border-[var(--border-subtle)] bg-[var(--surface-input)] px-2 py-1 text-sm text-[var(--text-strong)] outline-none"
                  rows={2}
                />
                {/* 保存失败不能无声无息：编辑框还开着、内容保留，给出原因可重试。 */}
                {update.isError && (
                  <ErrorNote className="mt-1" error={update.error} />
                )}
                <div className="mt-1 flex items-center gap-2 text-xs">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={save}
                    disabled={update.isPending}
                  >
                    <Check className="h-3 w-3" />
                    {t("transcript.save")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEdit}
                  >
                    <X className="h-3 w-3" />
                    {t("transcript.cancel")}
                  </Button>
                  <span className="text-[var(--text-faint)]">{t("transcript.saveShortcut")}</span>
                </div>
              </div>
            </div>
          ) : (
            <TranscriptRow
              key={segment.id}
              index={index}
              segment={segment}
              active={index === activeRowIndex}
              highlight={deferredHighlight}
              currentMatch={searchMatches[matchIndex] === index}
              onSeek={requestSeek}
              onEdit={startEdit}
            />
          );
            })}
          </div>
        ))}
      </div>
      {askAnchor && (
        <div
          // 选区上方浮出；fixed + 视口坐标，不受滚动容器裁剪。
          className="fixed z-50 flex -translate-x-1/2 -translate-y-full gap-1"
          style={{ left: askAnchor.left, top: askAnchor.top - 6 }}
          // 别让按钮抢焦点而清掉选区（文本/时间戳已存进 askAnchor，读取本就安全）。
          onMouseDown={(e) => e.preventDefault()}
        >
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="shadow-[var(--shadow-pop)]"
            onClick={() => {
              useInlineAsk.getState().askAbout(askAnchor.text, askAnchor.startMs);
              window.getSelection()?.removeAllRanges();
              setAskAnchor(null);
            }}
          >
            {t("transcript.askAi")}
          </Button>
          {/* 仅当所选词落在单个句子内（可挖空）时提供。 */}
          {askAnchor.segmentText?.includes(askAnchor.text) && (
            <Button
              type="button"
              size="sm"
              className="shadow-[var(--shadow-pop)]"
              onClick={() => {
                const { front, back } = buildCloze(askAnchor.segmentText!, askAnchor.text);
                addCloze.mutate({ front, back, startMs: askAnchor.startMs });
                window.getSelection()?.removeAllRanges();
                setAskAnchor(null);
              }}
            >
              {t("transcript.clozeCard")}
            </Button>
          )}
        </div>
      )}
      {clozeAdded && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[var(--surface-card)] px-3 py-1.5 text-xs text-[var(--text-strong)] shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)]"
        >
          {t("transcript.addedToReview")}
        </div>
      )}
    </div>
  );
}
