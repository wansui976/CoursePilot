import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MindmapPanel } from "./MindmapPanel";
import { useTheme } from "@/stores/theme";

const { mockSetData, mockFit, mockRescale, mockCreate, mockTransform, mockIpc } =
  vi.hoisted(() => {
    const mockSetData = vi.fn();
    const mockFit = vi.fn();
    const mockRescale = vi.fn();
    const mockCreate = vi.fn(() => ({
      setData: mockSetData,
      fit: mockFit,
      rescale: mockRescale,
    }));
    const mockTransform = vi.fn(() => ({ root: { id: "root" } }));
    return {
      mockSetData,
      mockFit,
      mockRescale,
      mockCreate,
      mockTransform,
      mockIpc: {
        ai: {
          getMindmap: vi.fn(),
          generate: vi.fn(),
          staleArtifacts: vi.fn(),
        },
      },
    };
  });

vi.mock("markmap-lib", () => ({
  Transformer: vi.fn(function Transformer() {
    return {
      transform: mockTransform,
    };
  }),
}));

vi.mock("markmap-view", () => ({
  Markmap: {
    create: mockCreate,
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MindmapPanel videoId="video-1" />
    </QueryClientProvider>,
  );
}

describe("MindmapPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.getState().setPref("dark");
    mockSetData.mockClear();
    mockFit.mockClear();
    mockRescale.mockClear();
    mockCreate.mockClear();
    mockTransform.mockClear();
    mockIpc.ai.getMindmap.mockReset().mockResolvedValue("# 根\n- 子节点");
    mockIpc.ai.generate.mockReset().mockResolvedValue(undefined);
    mockIpc.ai.staleArtifacts.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    useTheme.getState().setPref("light");
  });

  it("applies the dark markmap theme in dark mode", async () => {
    const { container } = renderPanel();

    expect(container.firstElementChild).toHaveClass("markmap-dark");

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
      expect(mockTransform).toHaveBeenCalledWith("# 根\n- 子节点");
      expect(mockSetData).toHaveBeenCalled();
      expect(mockFit).toHaveBeenCalled();
    });
  });

  it("还没有脑图时也给得出生成按钮", async () => {
    // 空状态的文案一直写着「也可点右下角生成」，而这个面板从来没挂过那组按钮——
    // 恰恰是最需要它的时候没有。
    mockIpc.ai.getMindmap.mockResolvedValue(null);
    renderPanel();

    expect(await screen.findByText(/还没有脑图/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    await waitFor(() =>
      expect(mockIpc.ai.generate).toHaveBeenCalledWith("video-1", "mindmap"),
    );
  });

  it("生成成功后脑图当场画出来，不用切走再切回来", async () => {
    mockIpc.ai.getMindmap.mockResolvedValueOnce(null);
    renderPanel();
    await screen.findByText(/还没有脑图/);

    mockIpc.ai.getMindmap.mockResolvedValue("# 新根\n- 新节点");
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    // 生成完要让这条查询失效，否则库里已经有图了，界面还停在空状态。
    await waitFor(() => expect(mockTransform).toHaveBeenCalledWith("# 新根\n- 新节点"));
    expect(mockSetData).toHaveBeenCalled();
  });

  it("有图时按钮是「重新生成」，不是「生成」", async () => {
    renderPanel();

    expect(await screen.findByRole("button", { name: "重新生成" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成" })).not.toBeInTheDocument();
  });

  it("生成失败要说出来，而不是按钮转一圈就没了", async () => {
    mockIpc.ai.getMindmap.mockResolvedValue(null);
    mockIpc.ai.generate.mockRejectedValueOnce(new Error("模型没配好"));
    renderPanel();

    await screen.findByText(/还没有脑图/);
    fireEvent.click(screen.getByRole("button", { name: "生成" }));

    expect(await screen.findByText(/模型没配好/)).toBeInTheDocument();
  });
});
