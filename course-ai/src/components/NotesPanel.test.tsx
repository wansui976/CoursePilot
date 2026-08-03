import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import { readVideoResumeState } from "@/lib/resumeState";
import { useTimestampPrefs } from "@/stores/timestampPrefs";

const { mockIpc, editorCapture } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getNotes: vi.fn(),
      generate: vi.fn(),
      saveNotes: vi.fn(),
    },
    export: {
      notes: vi.fn(),
      quiz: vi.fn(),
      mindmap: vi.fn(),
    },
  },
  editorCapture: (() => {
    // 稳定的 spy：mock 的 useEditor 每次渲染都会被调用，每次新建一个 vi.fn()
    // 就断言不到累计调用。
    //
    // 它还要和真的 tiptap 3 一致：setContent **默认会发 update 事件**（2.x 是默认
    // 不发，升级时默认值反过来了）。原来这个替身是个什么都不做的空函数，于是
    // 「装载内容顺手触发了一次自动保存」这类问题在测试里根本看不见——替身把被测的
    // 那条因果关系整个抹掉了。
    const capture: {
      onUpdate?: (p: { editor: unknown }) => void;
      setContent: ReturnType<typeof vi.fn>;
    } = { onUpdate: undefined, setContent: vi.fn() };
    capture.setContent = vi.fn((_content: unknown, options?: { emitUpdate?: boolean }) => {
      if (options?.emitUpdate === false) return;
      capture.onUpdate?.({
        editor: { getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }) },
      });
    });
    return capture;
  })(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tiptap/starter-kit", () => ({ default: {} }));
vi.mock("@tiptap/extension-table", () => ({ Table: { configure: () => ({}) } }));
vi.mock("@tiptap/extension-table-row", () => ({ TableRow: {} }));
vi.mock("@tiptap/extension-table-header", () => ({ TableHeader: {} }));
vi.mock("@tiptap/extension-table-cell", () => ({ TableCell: {} }));
vi.mock("./notes/timestampNode", () => ({
  TimestampNode: {},
  installTimestampClick: () => undefined,
}));
vi.mock("./notes/mathNode", () => ({ MathNode: {} }));
vi.mock("@tiptap/react", () => ({
  EditorContent: () => <div>笔记正文</div>,
  useEditor: (opts: { onUpdate?: (p: { editor: unknown }) => void }) => {
    editorCapture.onUpdate = opts?.onUpdate;
    return {
      commands: {
        setContent: editorCapture.setContent,
      },
      getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }),
    };
  },
}));

function renderNotesPanel(videoId = "video-1", instanceKey = "one") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <NotesPanel key={instanceKey} videoId={videoId} />
    </QueryClientProvider>,
  );
}

describe("NotesPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    editorCapture.setContent.mockClear();
    mockIpc.ai.getNotes.mockReset();
    mockIpc.ai.generate.mockReset();
    mockIpc.ai.saveNotes.mockReset();
    mockIpc.export.notes.mockReset();
    mockIpc.export.quiz.mockReset();
    mockIpc.export.mindmap.mockReset();
    mockIpc.ai.getNotes.mockResolvedValue(
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
    );
    useTimestampPrefs.setState({ showTimestamps: true });
  });

  it("shows a timestamp toggle in the notes view", async () => {
    renderNotesPanel("video-1", "toggle-present");
    expect(
      await screen.findByRole("button", { name: "隐藏时间戳" }),
    ).toBeInTheDocument();
  });

  it("flips data-hide-timestamps on the panel root when toggled", async () => {
    const { container } = renderNotesPanel("video-1", "toggle-attr");
    const toggle = await screen.findByRole("button", { name: "隐藏时间戳" });
    const root = container.querySelector<HTMLElement>("[data-notes-root]");
    expect(root).not.toBeNull();
    expect(root).not.toHaveAttribute("data-hide-timestamps");

    fireEvent.click(toggle);

    expect(root).toHaveAttribute("data-hide-timestamps");
  });

  it("restores the last notes scroll position for each video when remounted", async () => {
    const { rerender } = renderNotesPanel("video-1", "one");
    const scroller = await screen.findByLabelText("笔记内容滚动区");

    act(() => {
      scroller.scrollTop = 360;
      fireEvent.scroll(scroller);
    });

    expect(readVideoResumeState("video-1").notesScrollTop).toBe(360);

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <NotesPanel key="two" videoId="video-1" />
      </QueryClientProvider>,
    );

    const remountedScroller = await screen.findByLabelText("笔记内容滚动区");

    await waitFor(() => {
      expect(remountedScroller.scrollTop).toBe(360);
    });
  });

  it("keeps notes scroll positions isolated by video", async () => {
    const { rerender } = renderNotesPanel("video-1", "one");
    const firstScroller = await screen.findByLabelText("笔记内容滚动区");

    act(() => {
      firstScroller.scrollTop = 240;
      fireEvent.scroll(firstScroller);
    });

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <NotesPanel key="two" videoId="video-2" />
      </QueryClientProvider>,
    );

    const secondScroller = await screen.findByLabelText("笔记内容滚动区");

    expect(secondScroller.scrollTop).toBe(0);
  });

  it("marks the active inner view button with aria-pressed", async () => {
    renderNotesPanel("video-1", "aria-pressed");
    const notesBtn = await screen.findByRole("button", { name: "笔记" });
    expect(notesBtn).toHaveAttribute("aria-pressed", "true");
    const quizBtn = screen.getByRole("button", { name: "出题" });
    expect(quizBtn).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(quizBtn);

    expect(quizBtn).toHaveAttribute("aria-pressed", "true");
    expect(notesBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("flushes the pending note save on unmount (no data loss in the debounce window)", () => {
    // 不用 fake timers（会全局泄漏、拖垮并行的其它用例）：真实 800ms 定时器在本
    // 同步用例里根本来不及触发，所以卸载后若立刻看到 saveNotes，就证明是刷盘而非去抖。
    mockIpc.ai.getNotes.mockReturnValue(new Promise(() => {})); // 保持 pending，不加载覆盖
    const { unmount } = renderNotesPanel("video-1", "flush");

    // 模拟一次编辑：安排去抖保存（800ms 未到）。
    act(() => {
      editorCapture.onUpdate?.({
        editor: { getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }) },
      });
    });
    expect(mockIpc.ai.saveNotes).not.toHaveBeenCalled();

    // 卸载应立刻把未落库的编辑刷盘，而不是丢弃待发的定时器。
    unmount();
    expect(mockIpc.ai.saveNotes).toHaveBeenCalledWith("video-1", expect.any(String));
  });

  it("打开笔记不会把它原样写回一遍", async () => {
    // tiptap 3 的 setContent 默认会发 update 事件，于是「装载」被当成了「编辑」：
    // 光是打开笔记标签就会触发一次去抖自动保存，把刚读出来的内容原样写回、盖上
    // 「用户编辑于此刻」的戳、再推一条云同步——内容一个字都没变。
    mockIpc.ai.getNotes.mockResolvedValue(
      JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "我写的笔记" }] }],
      }),
    );
    renderNotesPanel("video-load", "load-no-write");
    await screen.findByText("笔记正文");

    // 去抖窗口 800ms，等过去再确认确实一次都没写。
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(mockIpc.ai.saveNotes).not.toHaveBeenCalled();
  });

  it("读不出笔记时绝不把空文档写回去", async () => {
    // 查询失败时 data 是 undefined，和「这个视频没有笔记」长得一模一样。按空笔记处理
    // 就会清空编辑器，而清空又被当成用户的编辑存回库里——用户的笔记就这么没了。
    mockIpc.ai.getNotes.mockRejectedValue(new Error("数据库忙"));
    renderNotesPanel("video-read-error", "read-error");

    // 必须等到查询真的进入失败态再断言。只等「getNotes 被调用过」的话，断言会跑在
    // 拒绝被处理之前，那时 setContent 本来就还没被调用——测试通过，但什么也没验证。
    await screen.findByRole("alert");
    expect(editorCapture.setContent).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(mockIpc.ai.saveNotes).not.toHaveBeenCalled();
  });

  it("shows autosave failures and retries the retained document", async () => {
    // Keep the query pending so the intentionally minimal editor mock is not recreated mid-debounce.
    mockIpc.ai.getNotes.mockReturnValue(new Promise(() => {}));
    mockIpc.ai.saveNotes
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(undefined);
    renderNotesPanel("video-save-error", "save-error");
    act(() => {
      editorCapture.onUpdate?.({
        editor: {
          getJSON: () => ({ type: "doc", content: [{ type: "paragraph" }] }),
        },
      });
    });

    expect(await screen.findByRole("alert", {}, { timeout: 2_000 })).toHaveTextContent(
      "save failed",
    );
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(mockIpc.ai.saveNotes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not expose a blank editor when loading existing notes fails", async () => {
    mockIpc.ai.getNotes
      .mockRejectedValueOnce(new Error("notes load failed"))
      .mockResolvedValueOnce(
        JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
      );
    renderNotesPanel("video-load-error", "load-error");

    expect(await screen.findByRole("alert")).toHaveTextContent("notes load failed");
    expect(screen.queryByText("笔记正文")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    expect(await screen.findByText("笔记正文")).toBeInTheDocument();
  });

  it("clears the editor when switching to a video that has no notes yet", async () => {
    // 面板在标签之间是保活的（不重建）。切到一个还没有笔记的视频时若不清空，
    // 编辑器会继续显示上一讲的笔记；用户接着打字，那份内容就被存到新视频名下了。
    mockIpc.ai.getNotes.mockImplementation((videoId: string) =>
      Promise.resolve(
        videoId === "video-with-notes"
          ? JSON.stringify({
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "上一讲的笔记" }] }],
            })
          : null,
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <NotesPanel videoId="video-with-notes" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(editorCapture.setContent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "doc" }),
        { emitUpdate: false },
      ),
    );
    editorCapture.setContent.mockClear();

    rerender(
      <QueryClientProvider client={queryClient}>
        <NotesPanel videoId="video-without-notes" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(editorCapture.setContent).toHaveBeenCalledWith(
        { type: "doc", content: [{ type: "paragraph" }] },
        // 装载不是编辑：清空编辑器不能触发一次把空文档写回库的自动保存。
        { emitUpdate: false },
      ),
    );
  });
});
