import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlidesPanel } from "./SlidesPanel";

const { mockIpc, player } = vi.hoisted(() => ({
  mockIpc: {
    slides: {
      list: vi.fn(),
      screenshots: vi.fn(),
      extract: vi.fn(),
      capture: vi.fn(),
      image: vi.fn(),
      cancelExtract: vi.fn(),
    },
    tools: { ocr: vi.fn() },
  },
  player: { currentMs: 0, requestSeek: vi.fn() },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/stores/player", () => {
  const usePlayer = (selector: (s: typeof player) => unknown) => selector(player);
  usePlayer.getState = () => player;
  return { usePlayer };
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SlidesPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("SlidesPanel", () => {
  beforeEach(() => {
    mockIpc.slides.list.mockReset().mockResolvedValue([]);
    mockIpc.slides.screenshots.mockReset().mockResolvedValue([]);
    mockIpc.slides.extract.mockReset();
    mockIpc.slides.cancelExtract.mockReset().mockResolvedValue(undefined);
    mockIpc.tools.ocr.mockReset();
  });

  it("shows extraction progress per phase and can stop it", async () => {
    let capturedRequestId = "";
    let report: ((progress: unknown) => void) | undefined;
    mockIpc.slides.extract.mockImplementation(
      (
        _videoId: string,
        _threshold: number | null,
        requestId: string,
        onProgress: (progress: unknown) => void,
      ) => {
        capturedRequestId = requestId;
        report = onProgress;
        return new Promise<number>(() => {}); // 一直挂起，保持提取中
      },
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /提取课件/ }));

    // 采样阶段给百分比（这一段是通读整段视频，最久），截图阶段给 i/n。
    await waitFor(() => expect(report).toBeDefined());
    report?.({ phase: "sample", done: 30, total: 120 });
    expect(await screen.findByRole("button", { name: /采样 25%/ })).toBeInTheDocument();
    report?.({ phase: "capture", done: 3, total: 12 });
    expect(await screen.findByRole("button", { name: /截图 3\/12/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /停止/ }));
    expect(mockIpc.slides.cancelExtract).toHaveBeenCalledWith(capturedRequestId);
  });

  it("falls back to an indeterminate label when the duration is unknown", async () => {
    let report: ((progress: unknown) => void) | undefined;
    mockIpc.slides.extract.mockImplementation(
      (
        _videoId: string,
        _threshold: number | null,
        _requestId: string,
        onProgress: (progress: unknown) => void,
      ) => {
        report = onProgress;
        return new Promise<number>(() => {});
      },
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /提取课件/ }));
    await waitFor(() => expect(report).toBeDefined());
    // total=0 表示拿不到视频时长，不能显示 Infinity% 之类的假进度。
    report?.({ phase: "sample", done: 42, total: 0 });
    expect(await screen.findByRole("button", { name: /采样中…/ })).toBeInTheDocument();
  });

  it("confirms copying the OCR result with transient feedback", async () => {
    mockIpc.tools.ocr.mockResolvedValue("识别出来的文字");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: /截图OCR/ }));
      fireEvent.click(await screen.findByText("识别出来的文字"));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("识别出来的文字"));
      // 复制成功要有可见反馈，而不是无声无息。
      expect(await screen.findByText("已复制")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not crash when the clipboard API is unavailable", async () => {
    mockIpc.tools.ocr.mockResolvedValue("识别出来的文字");
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    try {
      renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: /截图OCR/ }));
      fireEvent.click(await screen.findByText("识别出来的文字"));

      // 无 clipboard（权限受限等）时静默降级，面板不崩、也不显示假的成功。
      expect(screen.queryByText("已复制")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
