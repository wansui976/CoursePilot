import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ThumbsUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { TextSkeleton } from "@/components/ui/skeleton";
import { buildReplyTree, groupComments, splitEmoteText, type ReplyNode } from "@/lib/comments";
import { ipc } from "@/lib/ipc";
import type { CommentEmote, CommentEntry } from "@/lib/types";

/**
 * 评论区面板（右侧「更多」页签里的二级视图，仅 B 站视频有数据）。
 * 后端在导入/打开时全量抓好缓存（根评论 + 楼中楼 + 表情映射），这里只读库渲染。
 *
 * 评论是两层树：根评论按热度序，楼中楼挂在各自根评论下。回复内部再按
 * 「直接父回复」递归嵌套（楼中楼的楼中楼），层级展示封顶后用「回复 @谁」标注；
 * 顶层回复多于 3 条时默认折叠。B 站表情标记渲染成图片，原生 emoji 直接走字体。
 */

/** 头像：B 站图挂了/没有时回退成首字圆形，不打断列表。 */
function Avatar({ src, name, size }: { src: string | null; name: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const initial = (name.trim() || "?").charAt(0).toUpperCase() || "?";
  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="flex flex-none items-center justify-center rounded-full bg-[var(--surface-card-active)] font-semibold text-[var(--text-muted)]"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      >
        {initial}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      // B 站图床对陌生 Referer 可能 403；浏览器原生字段，比拆字符串稳妥。
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="flex-none rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/** B 站表情图片：加载失败退回文本标记，不让正文缺一块。 */
function EmoteImg({ emote, marker }: { emote: CommentEmote; marker: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>{marker}</span>;
  return (
    <img
      src={emote.url}
      alt={marker}
      title={marker.replace(/[[\]]/g, "")}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`inline-block align-text-bottom ${emote.size >= 2 ? "h-10" : "h-[22px]"}`}
    />
  );
}

/** 评论文本渲染：`[doge]` 这类已收录标记换成表情图，没收录的原样显示。 */
function EmoteText({ text, emotes }: { text: string; emotes: Map<string, CommentEmote> }) {
  const segments = useMemo(() => splitEmoteText(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "emote" && emotes.has(segment.value) ? (
          <EmoteImg key={index} emote={emotes.get(segment.value)!} marker={segment.value} />
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </>
  );
}

function LikeCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flex flex-none items-center gap-1 text-xs text-[var(--text-faint)] tabular-nums">
      <ThumbsUp className="h-3 w-3" aria-hidden />
      {count}
    </span>
  );
}

function CommentBody({
  comment,
  avatarSize,
  emotes,
}: {
  comment: CommentEntry;
  avatarSize: number;
  emotes: Map<string, CommentEmote>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 gap-2">
      <Avatar src={comment.avatar} name={comment.author} size={avatarSize} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-[var(--text-strong)]">
            {comment.author || t("commentsPanel.anonymous")}
          </span>
          <LikeCount count={comment.like_count} />
        </div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-normal)]">
          <EmoteText text={comment.text} emotes={emotes} />
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-faint)]">
          {comment.ctime ? new Date(comment.ctime * 1000).toLocaleDateString() : ""}
        </p>
      </div>
    </div>
  );
}

/** 视觉缩进封顶：更深的层级不再继续右移，用「回复 @谁」表明指向。 */
const MAX_INDENT_DEPTH = 3;
/** 楼中楼默认露出几条，多于这个数折叠（B 站同款策略）。 */
const COLLAPSED_REPLY_COUNT = 3;

function ReplyItem({
  node,
  authorsById,
  emotes,
}: {
  node: ReplyNode;
  authorsById: Map<string, string>;
  emotes: Map<string, CommentEmote>;
}) {
  const { t } = useTranslation();
  const indent = Math.min(node.depth, MAX_INDENT_DEPTH) - 1;
  // 一级回复的直接父就是根评论，不用标；更深才标「回复 @谁」。
  const replyToName =
    node.depth > 1 ? authorsById.get(node.reply.direct_parent_rpid ?? "") : undefined;
  return (
    <div style={{ marginLeft: indent * 20 }}>
      <div className="flex min-w-0 gap-2">
        <Avatar src={node.reply.avatar} name={node.reply.author} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="min-w-0 text-sm font-medium text-[var(--text-strong)]">
              {node.reply.author || t("commentsPanel.anonymous")}
              {replyToName && (
                <span className="ml-1.5 text-xs font-normal text-[var(--text-faint)]">
                  {t("commentsPanel.replyTo", { name: replyToName })}
                </span>
              )}
            </span>
            <LikeCount count={node.reply.like_count} />
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-normal)]">
            <EmoteText text={node.reply.text} emotes={emotes} />
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-faint)]">
            {node.reply.ctime ? new Date(node.reply.ctime * 1000).toLocaleDateString() : ""}
          </p>
        </div>
      </div>
      {node.children.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.children.map((child) => (
            <ReplyItem
              key={child.reply.rpid ?? child.reply.text}
              node={child}
              authorsById={authorsById}
              emotes={emotes}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ videoId }: { videoId: string }) {
  const { t } = useTranslation();
  const { data, isPending, error } = useQuery({
    queryKey: ["videoComments", videoId],
    queryFn: () => ipc.danmaku.comments(videoId),
    staleTime: Infinity,
    // 热门视频全量抓取（含楼中楼）要几十秒：面板挂载时不打断后台那次抓取。
    refetchOnMount: false,
  });
  const comments = useMemo(() => data?.comments ?? [], [data]);
  const emotes = useMemo(
    () => new Map((data?.emotes ?? []).map((emote) => [emote.text, emote])),
    [data],
  );
  const { roots, repliesByRoot } = useMemo(() => groupComments(comments), [comments]);
  // rpid → 作者名：「回复 @谁」标签要用。
  const authorsById = useMemo(
    () =>
      new Map(
        comments
          .filter((c) => c.rpid)
          .map((c) => [c.rpid as string, c.author || t("commentsPanel.anonymous")]),
      ),
    [comments, t],
  );
  const replyTotal = comments.length - roots.length;
  // 折叠状态按根评论记；换视频时整个面板随 TabsPanel 重建，状态自然归零。
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() => new Set());
  const toggleRoot = (rpid: string) =>
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rpid)) next.delete(rpid);
      else next.add(rpid);
      return next;
    });

  return (
    <div
      data-comments-panel=""
      className="flex h-full min-h-0 flex-col"
      aria-label={t("commentsPanel.title")}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {isPending ? (
          <div className="space-y-4">
            <TextSkeleton lines={3} />
            <TextSkeleton lines={2} />
            <TextSkeleton lines={4} />
            <p role="status" className="text-center text-xs text-[var(--text-faint)]">
              {t("commentsPanel.loading")}
            </p>
          </div>
        ) : error ? (
          <ErrorNote error={error} />
        ) : comments.length === 0 ? (
          <p role="status" className="py-6 text-center text-xs leading-relaxed text-[var(--text-faint)]">
            {t("commentsPanel.empty")}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-[var(--text-faint)] tabular-nums">
              {t("commentsPanel.summary", { total: comments.length, replies: replyTotal })}
            </p>
            <ul className="flex flex-col gap-4">
              {roots.map((root) => {
                const replies = repliesByRoot.get(root.rpid ?? "") ?? [];
                const tops = buildReplyTree(replies, root.rpid ?? "");
                const expanded = root.rpid != null && expandedRoots.has(root.rpid);
                const visibleTops =
                  expanded || tops.length <= COLLAPSED_REPLY_COUNT
                    ? tops
                    : tops.slice(0, COLLAPSED_REPLY_COUNT);
                const hiddenCount = tops.length - visibleTops.length;
                return (
                  <li key={root.rpid ?? root.text}>
                    <CommentBody comment={root} avatarSize={34} emotes={emotes} />
                    {tops.length > 0 && (
                      <div
                        data-testid="replies-group"
                        className="mt-2 space-y-3 border-l-2 border-[var(--border-subtle)] pl-3"
                      >
                        <p className="ca-t-2xs font-medium text-[var(--text-faint)]">
                          {t("commentsPanel.replies", { count: root.reply_count || replies.length })}
                        </p>
                        {visibleTops.map((node) => (
                          <ReplyItem
                            key={node.reply.rpid ?? node.reply.text}
                            node={node}
                            authorsById={authorsById}
                            emotes={emotes}
                          />
                        ))}
                        {tops.length > COLLAPSED_REPLY_COUNT && root.rpid && (
                          <button
                            type="button"
                            data-testid="expand-replies"
                            onClick={() => toggleRoot(root.rpid!)}
                            className="flex items-center gap-1 text-xs font-medium text-[var(--video-accent)] transition hover:opacity-80"
                          >
                            {expanded ? (
                              <>
                                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                                {t("commentsPanel.collapseReplies")}
                              </>
                            ) : (
                              <>
                                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                                {t("commentsPanel.expandReplies", { count: hiddenCount })}
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
