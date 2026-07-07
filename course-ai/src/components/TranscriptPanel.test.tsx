import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// 原生滚动列表：直接渲染即可（不再需要虚拟列表的视口/行高注入）。
function renderTranscriptPanel(instanceKey = "one") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <div data-theme="light">
        <TranscriptPanel key={instanceKey} videoId="video-1" />
      </div>
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

  it("persists the transcript scroll position while scrolling", async () => {
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
      expect(JSON.parse(raw as string).transcriptScrollTop).toBe(800);
    });
  });
});
