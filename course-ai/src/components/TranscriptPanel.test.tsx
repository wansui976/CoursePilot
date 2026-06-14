import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtuosoMockContext } from "react-virtuoso";
import { TranscriptPanel } from "./TranscriptPanel";
import type { TranscriptSegment } from "@/lib/types";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    transcripts: {
      list: vi.fn(),
      update: vi.fn(),
    },
    export: {
      subtitles: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function makeSegments(count: number): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    video_id: "video-1",
    segment_idx: i,
    start_ms: (i + 1) * 1_000,
    end_ms: (i + 1) * 1_000 + 900,
    text: `第 ${i + 1} 句文稿内容`,
  }));
}

// jsdom 无真实布局，给 Virtuoso 注入固定视口/行高，让它在测试里渲染出可见行。
function renderTranscriptPanel(instanceKey = "one") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <VirtuosoMockContext.Provider
        value={{ viewportHeight: 300, itemHeight: 40 }}
      >
        <div data-theme="light">
          <TranscriptPanel key={instanceKey} videoId="video-1" />
        </div>
      </VirtuosoMockContext.Provider>
    </QueryClientProvider>,
  );
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    mockIpc.transcripts.list.mockResolvedValue(makeSegments(60));
  });

  it("uses theme-aware muted text for segment timestamps", async () => {
    renderTranscriptPanel();

    expect(await screen.findByText("00:01")).toHaveClass(
      "text-[var(--text-muted)]",
    );
  });

  it("persists the top transcript row index while scrolling", async () => {
    renderTranscriptPanel();
    await screen.findByText("00:01");
    const scroller = screen.getByLabelText("文稿内容滚动区");

    act(() => {
      scroller.scrollTop = 800;
      fireEvent.scroll(scroller);
    });

    await waitFor(() => {
      const raw = localStorage.getItem("course-ai-resume:video-1");
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string).transcriptTopIndex).toBeGreaterThan(0);
    });
  });
});
