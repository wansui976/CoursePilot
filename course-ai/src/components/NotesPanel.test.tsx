import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";
import { readVideoResumeState } from "@/lib/resumeState";

const { mockIpc } = vi.hoisted(() => ({
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
  useEditor: () => ({
    commands: {
      setContent: vi.fn(),
    },
    getJSON: () => ({ type: "doc", content: [] }),
  }),
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
    mockIpc.ai.getNotes.mockReset();
    mockIpc.ai.generate.mockReset();
    mockIpc.ai.saveNotes.mockReset();
    mockIpc.export.notes.mockReset();
    mockIpc.export.quiz.mockReset();
    mockIpc.export.mindmap.mockReset();
    mockIpc.ai.getNotes.mockResolvedValue(
      JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
    );
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
});
