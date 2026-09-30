import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "./CommentsPanel";
import { buildReplyTree, groupComments, splitEmoteText } from "@/lib/comments";
import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import type { CommentEntry, CommentSection } from "@/lib/types";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    danmaku: {
      comments: vi.fn(),
    },
  },
}));

function renderPanel(videoId = "video-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentsPanel videoId={videoId} />
    </QueryClientProvider>,
  );
}

function section(comments: CommentEntry[], emotes: CommentSection["emotes"] = []): CommentSection {
  return { comments, emotes };
}

const ROOT_A: CommentEntry = {
  rpid: "100",
  author: "楼主",
  text: "讲得真好",
  like_count: 42,
  ctime: 1_700_000_000,
  parent_rpid: null,
  reply_count: 3,
  direct_parent_rpid: null,
  avatar: "https://i0.hdslb.com/bfs/face/a.jpg",
};

const REPLY_A1: CommentEntry = {
  rpid: "101",
  author: "路人甲",
  text: "附议",
  like_count: 3,
  ctime: 1_700_000_100,
  parent_rpid: "100",
  reply_count: 0,
  direct_parent_rpid: "100",
  avatar: null,
};

const REPLY_A2: CommentEntry = {
  rpid: "102",
  author: "路人乙",
  text: "同问一个细节",
  like_count: 0,
  ctime: 1_700_000_200,
  parent_rpid: "100",
  reply_count: 0,
  direct_parent_rpid: "100",
  avatar: null,
};

// 楼中楼的楼中楼：回复了「路人甲」那条。
const REPLY_A1_1: CommentEntry = {
  rpid: "103",
  author: "路人丙",
  text: "我也想问甲",
  like_count: 1,
  ctime: 1_700_000_300,
  parent_rpid: "100",
  reply_count: 0,
  direct_parent_rpid: "101",
  avatar: null,
};

const ROOT_B: CommentEntry = {
  rpid: "200",
  author: "",
  text: "匿名根评论",
  like_count: 0,
  ctime: 1_699_000_000,
  parent_rpid: null,
  reply_count: 0,
  direct_parent_rpid: null,
  avatar: null,
};

describe("groupComments", () => {
  it("splits roots and nests replies under their root, keeping order", () => {
    const { roots, repliesByRoot } = groupComments([
      ROOT_A,
      REPLY_A2,
      REPLY_A1,
      ROOT_B,
    ]);

    expect(roots).toEqual([ROOT_A, ROOT_B]);
    expect(repliesByRoot.get("100")).toEqual([REPLY_A2, REPLY_A1]);
    expect(repliesByRoot.get("200")).toBeUndefined();
  });

  it("keeps a reply whose root is missing out of the roots list", () => {
    const orphan: CommentEntry = { ...REPLY_A1, parent_rpid: "404" };
    const { roots, repliesByRoot } = groupComments([ROOT_A, orphan]);

    expect(roots).toEqual([ROOT_A]);
    expect(repliesByRoot.get("404")).toEqual([orphan]);
  });
});

describe("buildReplyTree", () => {
  it("nests reply-to-reply under its parent reply, depth 1 stays top-level", () => {
    const tops = buildReplyTree([REPLY_A1, REPLY_A1_1, REPLY_A2], "100");

    expect(tops).toHaveLength(2);
    expect(tops[0]?.reply.rpid).toBe("101");
    expect(tops[0]?.depth).toBe(1);
    // 路人丙回复了路人甲：挂在甲的节点下，层级 +1。
    expect(tops[0]?.children).toHaveLength(1);
    expect(tops[0]?.children[0]?.reply.rpid).toBe("103");
    expect(tops[0]?.children[0]?.depth).toBe(2);
    // 直接父是根评论（direct_parent_rpid = rootRpid）的是另一条顶层回复。
    expect(tops[1]?.reply.rpid).toBe("102");
    expect(tops[1]?.depth).toBe(1);
  });

  it("treats replies with unknown parents as top-level so nothing is lost", () => {
    const orphan: CommentEntry = { ...REPLY_A1_1, direct_parent_rpid: "999" };
    const tops = buildReplyTree([orphan], "100");

    expect(tops).toHaveLength(1);
    expect(tops[0]?.depth).toBe(1);
  });
});

describe("splitEmoteText", () => {
  it("splits bilibili emote markers from plain text, leaving unknown brackets alone", () => {
    expect(splitEmoteText("前[doge]后[奥比岛_点赞]尾")).toEqual([
      { kind: "text", value: "前" },
      { kind: "emote", value: "[doge]" },
      { kind: "text", value: "后" },
      { kind: "emote", value: "[奥比岛_点赞]" },
      { kind: "text", value: "尾" },
    ]);
    // 原生 emoji 是普通文字，不进表情管线。
    expect(splitEmoteText("笑 😂[doge]")).toEqual([
      { kind: "text", value: "笑 😂" },
      { kind: "emote", value: "[doge]" },
    ]);
    expect(splitEmoteText("没有表情")).toEqual([{ kind: "text", value: "没有表情" }]);
  });
});

describe("CommentsPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.mocked(ipc.danmaku.comments).mockReset();
  });

  it("renders roots with replies nested underneath", async () => {
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(
      section([ROOT_A, REPLY_A1, REPLY_A2, ROOT_B]),
    );
    renderPanel();

    expect(await screen.findByText("讲得真好")).toBeInTheDocument();
    // 楼中楼挂在根评论下：分组标记 + 每条回复都能看到。
    expect(screen.getByText("3 条回复")).toBeInTheDocument();
    expect(screen.getByText("附议")).toBeInTheDocument();
    expect(screen.getByText("同问一个细节")).toBeInTheDocument();
    expect(screen.getAllByTestId("replies-group")).toHaveLength(1);
    // 恰好 3 条顶层回复：不出现折叠按钮。
    expect(screen.queryByTestId("expand-replies")).not.toBeInTheDocument();
    // 无回复的根评论不渲染回复分组。
    expect(screen.getByText("匿名根评论")).toBeInTheDocument();
    // 汇总行：4 条，其中回复 2 条。
    expect(screen.getByText("共 4 条（含回复 2 条）")).toBeInTheDocument();
  });

  it("renders bilibili emotes as images and keeps unknown markers as text", async () => {
    const emoteReply: CommentEntry = {
      ...REPLY_A1,
      text: "说得好 [doge]，那个 [不存在的表情] 呢 😂",
    };
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(
      section([ROOT_A, emoteReply], [
        { text: "[doge]", url: "https://i0.hdslb.com/bfs/emote/doge.png", size: 1 },
      ]),
    );
    const { container } = renderPanel();

    expect(await screen.findByText(/说得好/)).toBeInTheDocument();
    const emoteImg = container.querySelector<HTMLImageElement>(
      'img[src="https://i0.hdslb.com/bfs/emote/doge.png"]',
    );
    expect(emoteImg).not.toBeNull();
    expect(emoteImg).toHaveAttribute("alt", "[doge]");
    // 没收录的标记原样显示文本；原生 emoji 直接可见。
    expect(screen.getByText("[不存在的表情]")).toBeInTheDocument();
    expect(screen.getByText(/😂/)).toBeInTheDocument();
  });

  it("collapses threads with more than three replies and expands on demand", async () => {
    // 5 条顶层回复：默认只露 3 条。
    const replies = Array.from({ length: 5 }, (_, i) => ({
      ...REPLY_A1,
      rpid: `10${i}`,
      text: `回复内容${i}`,
      ctime: REPLY_A1.ctime + i,
      direct_parent_rpid: "100",
    }));
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(section([ROOT_A, ...replies]));
    renderPanel();

    expect(await screen.findByText("回复内容0")).toBeInTheDocument();
    expect(screen.getByText("回复内容2")).toBeInTheDocument();
    expect(screen.queryByText("回复内容3")).not.toBeInTheDocument();
    expect(screen.getByTestId("expand-replies")).toHaveTextContent("展开 2 条回复");

    fireEvent.click(screen.getByTestId("expand-replies"));

    expect(screen.getByText("回复内容3")).toBeInTheDocument();
    expect(screen.getByText("回复内容4")).toBeInTheDocument();
    expect(screen.getByTestId("expand-replies")).toHaveTextContent("收起回复");
  });

  it("renders avatars with a letter fallback when there is no image", async () => {
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(section([ROOT_A, REPLY_A1]));
    const { container } = renderPanel();

    expect(await screen.findByText("讲得真好")).toBeInTheDocument();
    // 有头像 URL 的渲染 <img>（空 alt = 装饰图，不占 img role）；没有的回退成首字圆。
    const img = container.querySelector<HTMLImageElement>(
      `img[src="${ROOT_A.avatar}"]`,
    );
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByText("路")).toBeInTheDocument();
  });

  it("renders reply-to-reply with the reply-to label", async () => {
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(
      section([ROOT_A, REPLY_A1, REPLY_A1_1]),
    );
    renderPanel();

    expect(await screen.findByText("我也想问甲")).toBeInTheDocument();
    // 二级回复标注「回复 @谁」，一级回复不标。
    expect(screen.getByText("回复 @路人甲")).toBeInTheDocument();
    expect(screen.queryByText("回复 @楼主")).not.toBeInTheDocument();
  });

  it("shows the loading note while the full fetch is running", () => {
    vi.mocked(ipc.danmaku.comments).mockReturnValue(new Promise(() => undefined));
    renderPanel();

    // TextSkeleton 自带 role="status"，这里按提示文案断言。
    expect(screen.getByText(/正在抓取全部评论/)).toBeInTheDocument();
  });

  it("shows the empty state for videos without comments", async () => {
    vi.mocked(ipc.danmaku.comments).mockResolvedValue(section([]));
    renderPanel();

    expect(await screen.findByRole("status")).toHaveTextContent("这里还没有评论");
  });
});
