import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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

const segment: TranscriptSegment = {
  id: 1,
  video_id: "video-1",
  segment_idx: 0,
  start_ms: 1_000,
  end_ms: 4_000,
  text: "这是一句文稿内容",
};

function renderTranscriptPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <div data-theme="light">
        <TranscriptPanel videoId="video-1" />
      </div>
    </QueryClientProvider>,
  );
}

describe("TranscriptPanel", () => {
  beforeEach(() => {
    mockIpc.transcripts.list.mockResolvedValue([segment]);
  });

  it("uses theme-aware muted text for segment timestamps", async () => {
    renderTranscriptPanel();

    expect(await screen.findByText("00:01")).toHaveClass(
      "text-[var(--text-muted)]",
    );
  });
});
