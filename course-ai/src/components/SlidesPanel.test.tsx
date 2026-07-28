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
      ocr: vi.fn(),
      cancelOcr: vi.fn(),
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
    mockIpc.slides.ocr.mockReset();
    mockIpc.slides.cancelOcr.mockReset().mockResolvedValue(undefined);
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

describe("SlidesPanel page OCR", () => {
  beforeEach(() => {
    mockIpc.slides.screenshots.mockReset().mockResolvedValue([]);
    mockIpc.slides.image.mockReset().mockResolvedValue(new ArrayBuffer(1));
    mockIpc.slides.ocr.mockReset();
    mockIpc.slides.cancelOcr.mockReset().mockResolvedValue(undefined);
  });

  const pages = [
    {
      id: 1,
      video_id: "video-1",
      image_path: "/p1.jpg",
      composed_path: null,
      start_ms: 0,
      end_ms: 1000,
      page_no: 1,
      ocr_text: "贝叶斯定理",
    },
    {
      id: 2,
      video_id: "video-1",
      image_path: "/p2.jpg",
      composed_path: null,
      start_ms: 2000,
      end_ms: 3000,
      page_no: 2,
      ocr_text: null,
    },
  ];

  it("recognizes only the pages that still need it, and can be stopped", async () => {
    mockIpc.slides.list.mockReset().mockResolvedValue(pages);
    let capturedRequestId = "";
    let report: ((progress: unknown) => void) | undefined;
    mockIpc.slides.ocr.mockImplementation(
      (
        _videoId: string,
        requestId: string,
        _force: boolean,
        onProgress: (progress: unknown) => void,
      ) => {
        capturedRequestId = requestId;
        report = onProgress;
        return new Promise(() => {});
      },
    );
    renderPanel();

    // 还有页没认过时按钮说「识别文字」，而不是含糊的「OCR」。
    fireEvent.click(await screen.findByRole("button", { name: /识别文字/ }));
    await waitFor(() => expect(mockIpc.slides.ocr).toHaveBeenCalled());
    expect(mockIpc.slides.ocr.mock.calls[0][2]).toBe(false);

    report?.({ done: 1, total: 2 });
    const stop = await screen.findByRole("button", { name: /识别 1\/2/ });
    fireEvent.click(stop);
    expect(mockIpc.slides.cancelOcr).toHaveBeenCalledWith(capturedRequestId);
  });

  it("re-recognizes every page when shift-clicked", async () => {
    mockIpc.slides.list
      .mockReset()
      .mockResolvedValue(pages.map((page) => ({ ...page, ocr_text: "已认" })));
    mockIpc.slides.ocr.mockResolvedValue(2);
    renderPanel();

    // 都认过了：按钮变成「重认文字」，按住 Shift 点才整批重来（换了引擎时用）。
    const button = await screen.findByRole("button", { name: /重认文字/ });
    fireEvent.click(button, { shiftKey: true });

    await waitFor(() => expect(mockIpc.slides.ocr).toHaveBeenCalled());
    expect(mockIpc.slides.ocr.mock.calls[0][2]).toBe(true);
  });

  it("hides the button when there are no slides to recognize", async () => {
    mockIpc.slides.list.mockReset().mockResolvedValue([]);
    renderPanel();

    await waitFor(() => expect(mockIpc.slides.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /识别文字/ })).not.toBeInTheDocument();
  });

  it("lets the toolbar wrap so the main action survives a narrow panel", async () => {
    // 学习面板可以被拖得很窄。这一行原来单行不换行，一窄就把最右边的
    // 「提取课件」挤出可视区——而那是本面板唯一的主操作。jsdom 量不了布局，
    // 这里守的是那条机制：标题行和按钮组都允许换行。
    renderPanel();

    const main = await screen.findByRole("button", { name: /提取课件/ });
    const group = main.parentElement as HTMLElement;
    expect(group.className).toContain("flex-wrap");
    expect((group.parentElement as HTMLElement).className).toContain("flex-wrap");
  });
});
