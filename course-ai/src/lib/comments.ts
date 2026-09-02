import type { CommentEntry } from "./types";

/** 评论区排组的纯逻辑：根评论 + 楼中楼回复（含回复套回复的层级，见 CommentsPanel.tsx）。 */

/** 根评论列表 + 每条根评论的回复列表。纯函数，方便单测。 */
export function groupComments(comments: CommentEntry[]): {
  roots: CommentEntry[];
  repliesByRoot: Map<string, CommentEntry[]>;
} {
  const roots: CommentEntry[] = [];
  const repliesByRoot = new Map<string, CommentEntry[]>();
  for (const comment of comments) {
    if (comment.parent_rpid == null) {
      roots.push(comment);
    } else {
      const list = repliesByRoot.get(comment.parent_rpid);
      if (list) list.push(comment);
      else repliesByRoot.set(comment.parent_rpid, [comment]);
    }
  }
  return { roots, repliesByRoot };
}

/** 渲染用的一层回复节点：reply + 它直接回复的那些回复（递归）。 */
export interface ReplyNode {
  reply: CommentEntry;
  /** 层级：1 = 直接回复根评论，2 = 回复了另一条回复，以此类推。 */
  depth: number;
  children: ReplyNode[];
}

/**
 * 把一条根评论下的平铺回复数组按 direct_parent_rpid 组成树。
 * 直接父是根评论（或缺失/找不到）的成为顶层节点；顺序保持接口的时间序。
 * 纯函数，方便单测。
 */
export function buildReplyTree(replies: CommentEntry[], rootRpid: string): ReplyNode[] {
  const byRpid = new Map<string, ReplyNode>();
  for (const reply of replies) {
    if (reply.rpid) byRpid.set(reply.rpid, { reply, depth: 0, children: [] });
  }
  const tops: ReplyNode[] = [];
  for (const node of byRpid.values()) {
    const direct = node.reply.direct_parent_rpid;
    const parent = direct && direct !== rootRpid ? byRpid.get(direct) : undefined;
    if (parent && parent !== node) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      node.depth = 1;
      tops.push(node);
    }
  }
  return tops;
}

/** 评论里的 B 站表情标记，如 `[doge]`、`[奥比岛_点赞]`（原生 emoji 不走这里）。 */
export interface EmoteSegment {
  kind: "text" | "emote";
  value: string;
}

const EMOTE_MARKER = /\[[^\][\n]{1,32}\]/g;

/** 把评论文本切成「普通文字 / 表情标记」段。纯函数，方便单测。 */
export function splitEmoteText(text: string): EmoteSegment[] {
  const out: EmoteSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(EMOTE_MARKER)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ kind: "text", value: text.slice(last, start) });
    out.push({ kind: "emote", value: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}
