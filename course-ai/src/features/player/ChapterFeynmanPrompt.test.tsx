import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useFeynman } from "@/stores/feynman";
import { usePlayer } from "@/stores/player";
import type { Chapter } from "@/lib/types";
import { ChapterFeynmanPrompt } from "./ChapterFeynmanPrompt";

const chapters: Chapter[] = [
  {
    id: 1,
    video_id: "v1",
    title: "开场",
    summary: null,
    start_ms: 0,
    end_ms: 10_000,
    order_index: 0,
  },
  {
    id: 2,
    video_id: "v1",
    title: "第二讲",
    summary: null,
    start_ms: 10_000,
    end_ms: 20_000,
    order_index: 1,
  },
];

describe("ChapterFeynmanPrompt", () => {
  beforeEach(() => {
    useFeynman.setState({ request: null });
    usePlayer.setState({ videoId: "v1", currentMs: 9_000, durationMs: 20_000 });
    localStorage.clear();
  });

  it("offers Explain it when playback naturally reaches the chapter end", () => {
    render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));

    expect(screen.getByText(/「开场」讲完了/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "讲一讲" }));

    expect(useFeynman.getState().request?.topic).toEqual({
      kind: "range",
      video_id: "v1",
      start_ms: 0,
      end_ms: 10_000,
      title: "开场",
    });
  });

  it("stays quiet when the user seeks across the boundary", () => {
    render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 15_000 }));
    expect(screen.queryByText(/讲完了/)).not.toBeInTheDocument();
  });

  it("shows at most once per video, even across remounts", () => {
    const first = render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    expect(screen.getByText(/「开场」讲完了/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // 同一视频的下一章自然播完，也不再打扰。
    act(() => usePlayer.setState({ currentMs: 19_500 }));
    act(() => usePlayer.setState({ currentMs: 20_050 }));
    expect(screen.queryByText(/讲完了/)).not.toBeInTheDocument();

    first.unmount();
    usePlayer.setState({ currentMs: 9_000 });
    render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    expect(screen.queryByText(/「开场」讲完了/)).not.toBeInTheDocument();
  });

  it("a different video gets its own single prompt", () => {
    const first = render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    first.unmount();

    usePlayer.setState({ currentMs: 9_000 });
    render(<ChapterFeynmanPrompt videoId="v2" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    expect(screen.getByText(/「开场」讲完了/)).toBeInTheDocument();
  });

  it("不再提示 permanently turns the prompt off", () => {
    const first = render(<ChapterFeynmanPrompt videoId="v1" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    fireEvent.click(screen.getByRole("button", { name: "不再提示" }));
    expect(screen.queryByText(/讲完了/)).not.toBeInTheDocument();
    first.unmount();

    // 换一个从没提示过的视频，也不应再出现。
    usePlayer.setState({ currentMs: 9_000 });
    render(<ChapterFeynmanPrompt videoId="v2" chapters={chapters} />);
    act(() => usePlayer.setState({ currentMs: 10_500 }));
    expect(screen.queryByText(/讲完了/)).not.toBeInTheDocument();
    expect(localStorage.getItem("course-ai-feynman-chapter-prompt-off")).toBe("1");
  });
});
