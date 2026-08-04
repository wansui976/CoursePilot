import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invalidateStaleArtifacts } from "@/lib/useStaleArtifacts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { coarsePointer } from "@/lib/useContainerWidth";
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

// content-visibility 按「块」而非按行：每块行数。块少两个数量级，滚动时浏览器的可见性
// 簿记开销小得多；快滑时整块（约一屏半）一次性渲染进来，而不是一行行往外挤，基本不见空白。
const CHUNK_SIZE = 30;

// 单行文稿：memo 化，只有活动态变化的行才重渲染（换句时仅两行更新，避免整表重排）。
// 长文稿性能由块级 content-visibility 承担（见 globals.css .ca-transcript-chunk）——
// 浏览器原生跳过屏外块的渲染，滚动是原生的，不存在虚拟列表那种量高回改 scrollTop 的抽搐。
const TranscriptRow = memo(function TranscriptRow({
  index,
  segment,
  active,
  onSeek,
  onEdit,
}: {
  index: number;
  segment: TranscriptSegment;
  active: boolean;
  onSeek: (ms: number) => void;
  onEdit: (id: number, text: string) => void;
}) {
  return (
    <div className="px-3 py-0.5">
      <div
        data-row={index}
        className={`group relative rounded ${
          active ? "bg-primary/20" : "hover:bg-[var(--surface-card-hover)]"
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
          <span>
            <MathText text={segment.text} />
          </span>
        </button>
        <button
          aria-label="编辑这句文稿"
          title="纠错"
          onClick={() => onEdit(segment.id, segment.text)}
          // 用轻量字形代替 lucide SVG：每行少一棵 SVG 子树，屏外行渲染更快、快滑空白更小。
          // 悬停才出现且盖在文字上方，给实底背景 + 细边保证可读。
          // 触屏没有 hover：.ca-transcript-edit 在 pointer:coarse 下强制可见（globals.css）。
          className="ca-transcript-edit ca-touch-44 ca-workbench-touch absolute bottom-0.5 right-1 grid h-7 w-7 place-items-center rounded border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[15px] leading-none text-[var(--text-muted)] opacity-0 shadow-[var(--shadow-raise)] transition hover:bg-[var(--surface-card-hover)] hover:text-[var(--text-strong)] group-hover:opacity-100"
        >
          <span aria-hidden="true">✎</span>
        </button>
      </div>
    </div>
  );
});

export function TranscriptPanel({ videoId }: { videoId: string }) {
  const qc = useQueryClient();
  const { data: segments = [] } = useQuery({
    queryKey: ["transcripts", videoId],
    queryFn: () => ipc.transcripts.list(videoId),
    refetchInterval: (query) =>
      query.state.data && query.state.data.length > 0 ? false : 2000,
  });
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

  // memo 化行的稳定回调：身份不变，非活动行才不会因父组件重渲染而跟着重渲染。
  const startEdit = useCallback((id: number, text: string) => {
    setEditingId(id);
    setDraft(text);
  }, []);
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

  // 活动行变化时才考虑滚动（编辑时不打扰用户）。刚手动滚过则暂停；活动行已完整可见则不动，
  // 仅当它滚出可视区才平滑居中——原生 scrollTo，不做任何量高回改，故不抽搐。
  useEffect(() => {
    if (activeRowIndex < 0 || editingId != null) return;
    if (Date.now() - userScrollRef.current < FOLLOW_PAUSE_MS) return;
    const scroller = scrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>(
      `[data-row="${activeRowIndex}"]`,
    );
    if (!scroller || !row) return;
    const sRect = scroller.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    const fullyVisible = rRect.top >= sRect.top && rRect.bottom <= sRect.bottom;
    if (fullyVisible) return;
    const target =
      scroller.scrollTop +
      (rRect.top - sRect.top) -
      (scroller.clientHeight - row.clientHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [activeRowIndex, editingId]);

  // 滚动位置恢复：每个视频各恢复一次（组件被 TabsPanel 保活，换视频只变 prop 不重挂，
  // 必须按 videoId 重读、重恢复，否则新视频既不恢复位置、又会被写入旧视频的 scrollTop）。
  // 滚动时节流写入，切走 / 换视频时再补一次。
  const savedScrollTop = useRef(0);
  const restoredForRef = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (restoredForRef.current === videoId) return;
    const saved = readVideoResumeState(videoId);
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

  if (segments.length === 0) {
    return <p className="p-4 text-sm text-[var(--text-muted)]">字幕生成中或尚未开始</p>;
  }

  return (
    <div className="flex h-full flex-col text-[var(--text-normal)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 text-xs">
        <span className="text-[var(--text-faint)]">
          {coarsePointer() ? "点 ✎ 可纠错" : "悬停文稿可纠错"}
        </span>
        <div className="ml-auto">
          <ExportMenu
            items={[
              { label: "SRT 字幕", run: () => ipc.export.subtitles(videoId, "srt"), mime: "application/x-subrip", saveAs: "subtitles.srt" },
              { label: "VTT 字幕", run: () => ipc.export.subtitles(videoId, "vtt"), mime: "text/vtt", saveAs: "subtitles.vtt" },
            ]}
          />
        </div>
      </div>
      <div
        ref={scrollerRef}
        aria-label="文稿内容滚动区"
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
            <div key={segment.id} className="px-3 py-0.5">
              <div className="rounded bg-[var(--surface-card)] p-2">
                <textarea
                  aria-label="编辑文稿"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                    if (e.key === "Escape") setEditingId(null);
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
                    保存
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3 w-3" />
                    取消
                  </Button>
                  <span className="text-[var(--text-faint)]">⌘/Ctrl+Enter 保存</span>
                </div>
              </div>
            </div>
          ) : (
            <TranscriptRow
              key={segment.id}
              index={index}
              segment={segment}
              active={index === activeRowIndex}
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
          <button
            type="button"
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-white shadow-[var(--shadow-pop)]"
            onClick={() => {
              useInlineAsk.getState().askAbout(askAnchor.text, askAnchor.startMs);
              window.getSelection()?.removeAllRanges();
              setAskAnchor(null);
            }}
          >
            问 AI
          </button>
          {/* 仅当所选词落在单个句子内（可挖空）时提供。 */}
          {askAnchor.segmentText?.includes(askAnchor.text) && (
            <button
              type="button"
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-card)] px-2.5 py-1 text-xs font-medium text-[var(--text-normal)] shadow-[var(--shadow-pop)]"
              onClick={() => {
                const { front, back } = buildCloze(askAnchor.segmentText!, askAnchor.text);
                addCloze.mutate({ front, back, startMs: askAnchor.startMs });
                window.getSelection()?.removeAllRanges();
                setAskAnchor(null);
              }}
            >
              挖空成卡
            </button>
          )}
        </div>
      )}
      {clozeAdded && (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[var(--surface-card)] px-3 py-1.5 text-xs text-[var(--text-strong)] shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)]"
        >
          已加入每日复习
        </div>
      )}
    </div>
  );
}
