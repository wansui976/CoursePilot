import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SemanticStatus } from "@/lib/ipc";
import { SemanticSection } from "./SemanticSection";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    semantic: {
      status: vi.fn(),
      save: vi.fn(),
      downloadModel: vi.fn(),
      deleteModel: vi.fn(),
      test: vi.fn(),
      rebuild: vi.fn(),
      resume: vi.fn(),
    },
    ai: { getProfiles: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

function status(overrides: Partial<SemanticStatus> = {}): SemanticStatus {
  return {
    backend: "off",
    localSupported: true,
    localModel: null,
    cloudProfile: null,
    cloudModel: null,
    models: [
      { id: "bge-small-zh-v1.5", name: "BGE Small 中文", description: "小", size: 26_472_640, installed: false, sizeOnDisk: 0 },
      { id: "qwen3-embedding-0.6b", name: "Qwen3-Embedding 0.6B", description: "大", size: 639_150_592, installed: false, sizeOnDisk: 0 },
    ],
    active: false,
    indexed: 0,
    total: 12,
    progress: { running: false, pending: 0, done: 0, currentTitle: null, lastError: null },
    ...overrides,
  };
}

describe("SemanticSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    for (const fn of Object.values(mockIpc.semantic)) fn.mockReset().mockResolvedValue(undefined);
    mockIpc.ai.getProfiles.mockReset().mockResolvedValue([
      { id: "ds", name: "DeepSeek", kind: "anthropic", base_url: "", model: "x" },
      { id: "qw", name: "通义千问", kind: "openai", base_url: "https://dashscope", model: "qwen-plus" },
    ]);
  });

  it("关着时不显示索引；选本机模型时默认用第一个（小的）模型", async () => {
    mockIpc.semantic.status.mockResolvedValueOnce(status()).mockResolvedValue(
      status({ backend: "local", localModel: "bge-small-zh-v1.5" }),
    );
    render(<SemanticSection />);
    const select = await screen.findByLabelText("向量来源");
    expect(screen.queryByText("已建索引")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "local" } });
    await waitFor(() =>
      expect(mockIpc.semantic.save).toHaveBeenCalledWith({
        backend: "local",
        localModel: "bge-small-zh-v1.5",
        cloudProfile: null,
        cloudModel: null,
      }),
    );
    // 模型没下载：给「下载」，索引那组说明还不能用。
    fireEvent.click(await screen.findByRole("button", { name: "下载" }));
    await waitFor(() => expect(mockIpc.semantic.downloadModel).toHaveBeenCalledWith("bge-small-zh-v1.5"));
    expect(screen.getByText(/本机模型需要先下载/)).toBeInTheDocument();
  });

  it("云端只列有嵌入接口的配置；模型名改了才能保存，保存后才能测试", async () => {
    mockIpc.semantic.status.mockResolvedValue(
      status({ backend: "cloud", cloudProfile: "qw", cloudModel: "text-embedding-v4", active: true, indexed: 12 }),
    );
    mockIpc.semantic.test.mockResolvedValue({ dimensions: 1024, millis: 88 });
    render(<SemanticSection />);

    const profile = await screen.findByLabelText("使用哪个配置");
    await waitFor(() => expect(profile.querySelectorAll("option")).toHaveLength(1));
    expect(screen.getByText("全部建好")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    expect(await screen.findByText("可用 · 1024 维 · 88 ms")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("嵌入模型名"), { target: { value: " text-embedding-v3 " } });
    expect(screen.getByRole("button", { name: "测试" })).toBeDisabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(mockIpc.semantic.save).toHaveBeenCalledWith({
        backend: "cloud",
        localModel: null,
        cloudProfile: "qw",
        cloudModel: "text-embedding-v3",
      }),
    );
  });
});
