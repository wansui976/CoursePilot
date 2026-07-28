import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConceptsPanel, type ConceptNavigationState } from "./ConceptsPanel";

const {
  get,
  analyze,
  cancelAnalyze,
  summarize,
  conceptDueCounts,
  dueByConcept,
  review,
  generate,
  generateForConcept,
} = vi.hoisted(() => ({
  get: vi.fn(),
  analyze: vi.fn(),
  cancelAnalyze: vi.fn(),
  summarize: vi.fn(),
  conceptDueCounts: vi.fn(),
  dueByConcept: vi.fn(),
  review: vi.fn(),
  generate: vi.fn(),
  generateForConcept: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    concepts: { get, analyze, cancelAnalyze, summarize },
    srs: { conceptDueCounts, dueByConcept, review, generate, generateForConcept },
  },
}));

function renderPanel(
  onJump = vi.fn(),
  onClose = vi.fn(),
  initialNavigationState: ConceptNavigationState | undefined = undefined,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConceptsPanel
        courseId="c1"
        courseName="申论"
        onClose={onClose}
        onJump={onJump}
        initialNavigationState={initialNavigationState}
      />
    </QueryClientProvider>,
  );
  return { onJump, onClose };
}

const concept = {
  id: "k1",
  name: "贝叶斯定理",
  summary: "用先验信息和新证据更新判断。",
  explanation: "贝叶斯定理讲的是如何用新证据更新先验判断，课程借掷骰子的例子推导后验概率。",
  occurrences: [
    {
      video_id: "v1",
      video_title: "第一讲.mp4",
      start_ms: 65000,
      end_ms: 70000,
      excerpt: "先验概率会随着新的证据被更新。",
    },
    {
      video_id: "v2",
      video_title: "第二讲.mp4",
      start_ms: 5000,
      end_ms: 9000,
      excerpt: "条件概率是理解贝叶斯公式的前提。",
    },
  ],
};

const knowledge = {
  overview: "本课程先建立概率判断框架，再解释如何依据新证据更新结论。",
  groups: [
    {
      title: "概率推断",
      summary: "用概率模型组织不确定信息。",
      concepts: [concept],
    },
  ],
  generated_at: 1,
  covered_videos: 2,
  total_videos: 2,
  stale: false,
};

describe("ConceptsPanel", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue(knowledge);
    analyze.mockReset().mockResolvedValue(1);
    cancelAnalyze.mockReset().mockResolvedValue(undefined);
    summarize.mockReset().mockResolvedValue(undefined);
    conceptDueCounts.mockReset().mockResolvedValue([]);
    dueByConcept.mockReset().mockResolvedValue([]);
    review.mockReset().mockResolvedValue(undefined);
    generate.mockReset().mockResolvedValue(3);
    generateForConcept.mockReset().mockResolvedValue(3);
  });

  it("shows a course overview, concept summary, AI explanation, and clickable subtitle evidence", async () => {
    const { onJump } = renderPanel();

    expect(await screen.findByText(knowledge.overview)).toBeInTheDocument();
    expect(screen.getByText("概率推断")).toBeInTheDocument();
    expect(screen.getByText(concept.summary)).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();

    const disclosure = screen.getByRole("button", { name: /贝叶斯定理/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    // 展开后同时展示 AI 解释和可核验的真实字幕片段。
    expect(await screen.findByText(concept.explanation)).toBeInTheDocument();
    const excerpt = screen.getByText("先验概率会随着新的证据被更新。");
    expect(excerpt).toBeInTheDocument();
    expect(excerpt).toHaveClass("line-clamp-2");
    expect(screen.getByText("第一讲")).toBeInTheDocument();
    expect(screen.queryByText("第一讲.mp4")).not.toBeInTheDocument();

    const sourceButton = screen.getByRole("button", { name: "回看 第一讲 01:05" });
    expect(sourceButton).toHaveClass("min-h-11", "ca-touch-44");
    const scroller = screen.getByRole("main").parentElement!;
    scroller.scrollTop = 180;
    fireEvent.click(sourceButton);
    expect(onJump).toHaveBeenCalledWith("v1", 65000, {
      conceptId: "k1",
      conceptName: "贝叶斯定理",
      search: "",
      expandedConceptId: "k1",
      scrollTop: 180,
    });
  });

  it("uses real due counts for the next step and otherwise continues from a source", async () => {
    const { onJump } = renderPanel();

    expect(await screen.findByText("当前没有到期卡")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续学习" }));
    expect(onJump).toHaveBeenCalledWith(
      "v1",
      65000,
      expect.objectContaining({ conceptId: "k1", expandedConceptId: "k1" }),
    );
  });

  it("restores the search, expanded concept, and scroll position after returning", async () => {
    renderPanel(vi.fn(), vi.fn(), {
      conceptId: "k1",
      conceptName: "贝叶斯定理",
      search: "贝叶斯",
      expandedConceptId: "k1",
      scrollTop: 240,
    });

    expect(await screen.findByRole("searchbox", { name: "搜索课程知识" })).toHaveValue("贝叶斯");
    expect(screen.getByRole("button", { name: /贝叶斯定理/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() => expect(screen.getByRole("main").parentElement).toHaveProperty("scrollTop", 240));
  });

  it("renders the AI explanation as markdown, not raw text", async () => {
    get.mockReset().mockResolvedValue({
      ...knowledge,
      groups: [
        {
          ...knowledge.groups[0],
          concepts: [
            { ...concept, explanation: "**核心**：更新判断。\n\n- 先验\n- 后验" },
          ],
        },
      ],
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /贝叶斯定理/ }));
    const region = await screen.findByRole("region", { name: "贝叶斯定理的解释与来源" });
    // 加粗解析成 <strong>，列表解析成 <li>，而不是显示原始 ** 与 -。
    expect(within(region).getByText("核心").tagName).toBe("STRONG");
    expect(within(region).getByText("先验").closest("li")).not.toBeNull();
    expect(within(region).getByText("后验").closest("li")).not.toBeNull();
    expect(within(region).queryByText(/\*\*核心\*\*/)).not.toBeInTheDocument();
  });

  it("toggles the course AI chat drawer from the header", async () => {
    renderPanel();
    const toggle = await screen.findByRole("button", { name: "课程 AI 问答" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // 抽屉里的课程问答面板已挂载，展示空态引导。
    expect(screen.getByText("向这门课程提问")).toBeInTheDocument();
  });

  it("filters by source text without losing the grouped structure", async () => {
    renderPanel();
    await screen.findByText("贝叶斯定理");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索课程知识" }), {
      target: { value: "条件概率" },
    });
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /贝叶斯定理/ }));
    const region = await screen.findByRole("region", { name: "贝叶斯定理的解释与来源" });
    expect(await within(region).findByText("条件概率", { selector: "mark" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索课程知识" }), {
      target: { value: "不存在" },
    });
    expect(await screen.findByText("没有匹配“不存在”的知识点。")).toBeInTheDocument();
  });

  it("shows three sources by default and provides an accessible expand and collapse control", async () => {
    const occurrences = [
      ...concept.occurrences,
      {
        video_id: "v3",
        video_title: "第三讲.mp4",
        start_ms: 15000,
        end_ms: 19000,
        excerpt: "第三处字幕证据。",
      },
      {
        video_id: "v4",
        video_title: "第四讲.mp4",
        start_ms: 25000,
        end_ms: 29000,
        excerpt: "第四处字幕证据。",
      },
      {
        video_id: "v5",
        video_title: "第五讲.mp4",
        start_ms: 35000,
        end_ms: 39000,
        excerpt: "第五处字幕证据。",
      },
    ];
    get.mockResolvedValue({
      ...knowledge,
      groups: [
        {
          ...knowledge.groups[0],
          concepts: [{ ...concept, occurrences }],
        },
      ],
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /贝叶斯定理/ }));
    const region = await screen.findByRole("region", { name: "贝叶斯定理的解释与来源" });
    expect(within(region).getByText("第三处字幕证据。")).toBeInTheDocument();
    expect(within(region).queryByText("第四处字幕证据。")).not.toBeInTheDocument();
    expect(within(region).queryByText("第五处字幕证据。")).not.toBeInTheDocument();

    const expand = within(region).getByRole("button", { name: "展开其余 2 条来源" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(expand).toHaveAttribute("aria-controls", "concept-sources-k1");
    fireEvent.click(expand);

    expect(within(region).getByText("第四处字幕证据。")).toBeInTheDocument();
    expect(within(region).getByText("第五处字幕证据。")).toBeInTheDocument();
    const collapse = within(region).getByRole("button", { name: "收起来源" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(within(region).queryByText("第四处字幕证据。")).not.toBeInTheDocument();
  });

  it("shows a per-concept review button and launches a scoped review session", async () => {
    conceptDueCounts.mockResolvedValue([{ concept_id: "k1", due: 2 }]);
    dueByConcept.mockResolvedValue([
      { id: "c1", video_id: "v1", course_id: "c1", front: "卡片正面", back: "卡片背面", source_ms: 65000 },
    ]);
    renderPanel();

    expect(await screen.findByText("本课程共 2 张到期卡")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /复习 2/ }));
    await waitFor(() => expect(dueByConcept).toHaveBeenCalledWith("c1", "k1"));
    expect(await screen.findByText("卡片正面")).toBeInTheDocument();
  });

  it("highlights search hits and reports how many concepts matched", async () => {
    renderPanel();
    await screen.findByText("贝叶斯定理");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索课程知识" }), {
      target: { value: "贝叶斯" },
    });

    expect(await screen.findByText("命中 1/1 个知识点 · 1 个主题")).toBeInTheDocument();
    const hit = screen.getByText("贝叶斯", { selector: "mark" });
    // 只有命中的那几个字被标出来，其余部分照常显示。
    expect(hit).toBeInTheDocument();
    expect(hit.closest("span")).toHaveTextContent("贝叶斯定理");
  });

  it("shows when the summary was generated", async () => {
    get.mockResolvedValue({ ...knowledge, generated_at: Date.now() - 3 * 3600_000 });
    renderPanel();

    expect(await screen.findByText("总结生成于 3 小时前")).toBeInTheDocument();
  });

  it("offers a summary-only refresh when the snapshot is stale but no video is missing", async () => {
    get.mockResolvedValue({ ...knowledge, stale: true });
    renderPanel();

    expect(await screen.findByText(/知识点没有增减，只更新总结即可/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /只更新总结/ }));
    await waitFor(() => expect(summarize).toHaveBeenCalledWith("c1"));
  });

  it("says a full re-analysis is needed when transcribed videos are missing from the concepts", async () => {
    // 3 个视频有字幕，但知识点只覆盖到 2 个 → 只更新总结补不出缺的那个视频的知识点。
    get.mockResolvedValue({ ...knowledge, stale: true, covered_videos: 3, total_videos: 3 });
    renderPanel();

    expect(
      await screen.findByText(/有 1 个含字幕的视频还没出现在知识点里，需要重新分析/),
    ).toBeInTheDocument();
  });

  it("lets a concept without due cards generate only concept-scoped cards", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /贝叶斯定理/ }));
    expect(screen.queryByRole("button", { name: /复习 / })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "生成复习卡" }));
    await waitFor(() => expect(generateForConcept).toHaveBeenCalledWith("c1", "k1"));
    expect(generate).not.toHaveBeenCalled();
    expect(await screen.findByText(/已整理 3 张复习卡/)).toBeInTheDocument();
  });

  it("explains both reasons when no concept-scoped cards could be made", async () => {
    generateForConcept.mockResolvedValue(0);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /贝叶斯定理/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成复习卡" }));

    expect(
      await screen.findByText("相关视频尚无 AI 题目，或题目出处不在这个知识点范围内。"),
    ).toBeInTheDocument();
  });

  it("offers an inexpensive summary generation path for legacy concept data", async () => {
    get.mockResolvedValue({
      ...knowledge,
      overview: null,
      groups: [{ title: "知识点", summary: null, concepts: [concept] }],
      generated_at: null,
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "生成课程总结" }));
    await waitFor(() => expect(summarize).toHaveBeenCalledWith("c1"));
  });

  it("shows an analyze CTA when empty and reloads after analyzing", async () => {
    get
      .mockReset()
      .mockResolvedValueOnce({
        overview: null,
        groups: [],
        generated_at: null,
        covered_videos: 0,
        total_videos: 1,
        stale: false,
      })
      .mockResolvedValue(knowledge);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "分析本课程" }));
    await waitFor(() =>
      expect(analyze).toHaveBeenCalledWith("c1", expect.any(String), expect.any(Function)),
    );
    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
  });

  it("streams per-video progress and cancels the running analysis", async () => {
    get.mockReset().mockResolvedValue({
      overview: null,
      groups: [],
      generated_at: null,
      covered_videos: 0,
      total_videos: 3,
      stale: false,
    });
    // 分析挂起：先回报一次进度，promise 一直不 resolve，让进度面板保持可见。
    let capturedRequestId = "";
    analyze.mockReset().mockImplementation((_courseId, requestId, onProgress) => {
      capturedRequestId = requestId;
      onProgress({ done: 1, total: 3, title: "第二讲 归纳概括.mp4" });
      return new Promise<number>(() => {});
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "分析本课程" }));

    expect(await screen.findByText("正在分析课程知识…")).toBeInTheDocument();
    expect(screen.getByText(/2\/3 · 第二讲 归纳概括/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelAnalyze).toHaveBeenCalledWith(capturedRequestId));
  });

  it("does not disguise a failed knowledge query as an empty course", async () => {
    get.mockRejectedValue(new Error("连接失败"));
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("连接失败");
    expect(screen.queryByRole("button", { name: "分析本课程" })).not.toBeInTheDocument();
  });
});
