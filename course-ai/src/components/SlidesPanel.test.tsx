import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SlidesPanel } from "./SlidesPanel";
import type { SlidesOcrOutcome } from "@/lib/ipc";

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
    mockIpc.slides.capture.mockReset();
    mockIpc.slides.image.mockReset();
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

  it("shows a retryable error instead of an empty state when slide loading fails", async () => {
    mockIpc.slides.list
      .mockRejectedValueOnce(new Error("slide list failed"))
      .mockResolvedValueOnce([]);
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("slide list failed");
    expect(screen.queryByText(/还没有课件页/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    await waitFor(() => expect(mockIpc.slides.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/还没有课件页/)).toBeInTheDocument();
  });

  it("surfaces screenshot failures and allows retry", async () => {
    mockIpc.slides.capture
      .mockRejectedValueOnce(new Error("capture failed"))
      .mockResolvedValueOnce({});
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "截图" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("capture failed");
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    await waitFor(() => expect(mockIpc.slides.capture).toHaveBeenCalledTimes(2));
  });
});

describe("SlidesPanel page OCR", () => {
  beforeEach(() => {
    mockIpc.slides.screenshots.mockReset().mockResolvedValue([]);
    mockIpc.slides.image.mockReset().mockResolvedValue(new ArrayBuffer(1));
    mockIpc.slides.ocr.mockReset();
    mockIpc.slides.cancelOcr.mockReset().mockResolvedValue(undefined);
  });

  function outcome(over: Partial<SlidesOcrOutcome> = {}): SlidesOcrOutcome {
    return { recognized: 0, failed: 0, total: 0, canceled: false, error: null, ...over };
  }

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
    mockIpc.slides.ocr.mockResolvedValue(outcome({ recognized: 2, total: 2 }));
    renderPanel();

    // 都认过了：按钮变成「重认文字」，按住 Shift 点才整批重来（换了引擎时用）。
    const button = await screen.findByRole("button", { name: /重认文字/ });
    fireEvent.click(button, { shiftKey: true });

    await waitFor(() => expect(mockIpc.slides.ocr).toHaveBeenCalled());
    expect(mockIpc.slides.ocr.mock.calls[0][2]).toBe(true);
    expect(await screen.findByRole("status")).toHaveTextContent("已识别 2 页");
  });

  it("shows an explicit completion message when no usable text is found", async () => {
    mockIpc.slides.list.mockReset().mockResolvedValue(pages);
    mockIpc.slides.ocr.mockResolvedValue(outcome({ total: 2 }));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /识别文字/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "识别完成，没有识别到可用文字",
    );
  });

  it("部分失败不能报成一句「已识别 N 页」", async () => {
    // 真实场景：云端 OCR 的额度在第 10 页耗尽。前 9 页认出来了，后 90 页全挂——
    // 旧实现只要有一页成功就返回一个页数，界面弹绿色的「已识别 9 页」，
    // 另外 90 页的失败一个字都不提。
    mockIpc.slides.list.mockReset().mockResolvedValue(pages);
    mockIpc.slides.ocr.mockResolvedValue(
      outcome({
        recognized: 9,
        failed: 90,
        total: 99,
        error: "大模型账户余额不足：请充值或更换 API Key 后重试。",
      }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /识别文字/ }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("已识别 9 页");
    expect(status).toHaveTextContent("90 页失败");
    expect(status).toHaveTextContent("余额不足");
    // 不能是成功那套绿色：有九成的页没认成。
    expect(status.className).not.toContain("status-ok");
  });

  it("按下停止说的是「已停止」，不是「识别完成」", async () => {
    mockIpc.slides.list.mockReset().mockResolvedValue(pages);
    mockIpc.slides.ocr.mockResolvedValue(
      outcome({ recognized: 4, total: 40, canceled: true }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /识别文字/ }));

    expect(await screen.findByRole("status")).toHaveTextContent("已停止，已识别 4 页");
  });

  it("认过但没认出文字的页不再算进「还没认」", async () => {
    // 认过、判为乱码的页记的是空串。按「有没有文字」来数的话，一张纯图页会让按钮
    // 永远停在「识别文字」，每次重跑都把它再认一遍——云端 OCR 就是重复付费。
    mockIpc.slides.list
      .mockReset()
      .mockResolvedValue([
        { ...pages[0], ocr_text: "贝叶斯定理" },
        { ...pages[1], ocr_text: "" },
      ]);
    renderPanel();

    expect(await screen.findByRole("button", { name: /重认文字/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /识别文字/ })).not.toBeInTheDocument();
  });

  it("surfaces batch OCR failures instead of silently returning to idle", async () => {
    mockIpc.slides.list.mockReset().mockResolvedValue(pages);
    mockIpc.slides.ocr.mockRejectedValue(
      new Error("课件 OCR 无法执行：阿里云 OCR 鉴权失败"),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /识别文字/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("阿里云 OCR 鉴权失败");
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
