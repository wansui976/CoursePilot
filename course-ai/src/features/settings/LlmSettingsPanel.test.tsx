import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  LlmSettingsPanel,
  type LlmSettingsActions,
} from "./LlmSettingsPanel";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getProfiles: vi.fn(),
      saveProfiles: vi.fn(),
      setApiKey: vi.fn(),
      hasApiKey: vi.fn(),
      listModels: vi.fn(),
    },
    settings: { get: vi.fn() },
  },
}));
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));

const profile = {
  id: "p1",
  name: "默认配置",
  kind: "openai" as const,
  base_url: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
};

describe("LlmSettingsPanel", () => {
  beforeEach(() => {
    mockIpc.ai.getProfiles.mockReset();
    mockIpc.ai.saveProfiles.mockReset();
    mockIpc.ai.setApiKey.mockReset();
    mockIpc.ai.hasApiKey.mockReset();
    mockIpc.ai.listModels.mockReset();
    mockIpc.settings.get.mockReset();
    confirmMock.mockReset();
    mockIpc.ai.getProfiles.mockResolvedValue([profile]);
    mockIpc.ai.saveProfiles.mockResolvedValue(undefined);
    mockIpc.ai.setApiKey.mockResolvedValue(undefined);
    mockIpc.ai.hasApiKey.mockResolvedValue(false);
    mockIpc.ai.listModels.mockResolvedValue({
      models: [
        {
          id: "gpt-4o-mini",
          context_window: 128000,
          max_output_tokens: 16384,
          input_price: 0.15,
          output_price: 0.6,
          capabilities: { vision: true, tools: true, json: true, reasoning: false },
          source: "catalog",
        },
      ],
      cached: false,
      fetched_at: Date.now(),
      source: "live",
    });
    mockIpc.settings.get.mockResolvedValue(null);
  });

  it("labels every profile input for accessibility", async () => {
    render(<LlmSettingsPanel />);

    // placeholder 不是 label：四个输入框都要有可访问名称。
    expect(await screen.findByLabelText("配置名称")).toHaveValue(profile.name);
    expect(screen.getByLabelText("Base URL")).toHaveValue(profile.base_url);
    expect(screen.getByLabelText("模型名")).toHaveValue(profile.model);
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });

  it("asks for confirmation before deleting a profile", async () => {
    confirmMock.mockResolvedValue(false);
    render(<LlmSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining("默认配置"),
        expect.objectContaining({ kind: "warning" }),
      ),
    );
    // 取消 → 配置保留。
    expect(screen.getByLabelText("配置名称")).toBeInTheDocument();

    confirmMock.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("配置名称")).not.toBeInTheDocument(),
    );
  });

  it("shows a failure badge when saving profiles fails", async () => {
    mockIpc.ai.saveProfiles.mockRejectedValue(new Error("disk full"));
    render(<LlmSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "保存" }));

    expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
  });

  it("shows a load error instead of a misleading empty state", async () => {
    mockIpc.ai.getProfiles.mockRejectedValue(new Error("database unavailable"));

    render(<LlmSettingsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "LLM 配置加载失败：Error: database unavailable",
    );
    expect(screen.queryByText(/还没有配置/)).not.toBeInTheDocument();
  });

  it("reports routing read failures but tolerates malformed routing JSON", async () => {
    mockIpc.settings.get.mockRejectedValueOnce(new Error("db locked"));
    const { unmount } = render(<LlmSettingsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("db locked");
    unmount();

    mockIpc.settings.get.mockResolvedValueOnce("not-json");
    render(<LlmSettingsPanel />);
    expect(await screen.findByLabelText("配置名称")).toHaveValue(profile.name);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tracks unsaved edits and keeps the saved feedback visible", async () => {
    const onDirtyChange = vi.fn();
    render(<LlmSettingsPanel onDirtyChange={onDirtyChange} />);
    const name = await screen.findByLabelText("配置名称");

    fireEvent.change(name, { target: { value: "修改后的配置" } });

    expect(await screen.findByText("未保存")).toBeInTheDocument();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalledOnce());
    expect(await screen.findByText("已保存")).toBeInTheDocument();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("fetches models and shows context, price and capabilities", async () => {
    render(<LlmSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "获取模型" }));

    await waitFor(() =>
      expect(mockIpc.ai.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", model: "gpt-4o-mini" }),
        null,
        false,
      ),
    );
    expect(await screen.findByText("上下文 128K")).toBeInTheDocument();
    expect(screen.getByText(/输入 \$0.15 \/ 输出 \$0.60/)).toBeInTheDocument();
    expect(screen.getByText("工具")).toBeInTheDocument();
    expect(screen.getByText("视觉")).toBeInTheDocument();
    expect(screen.getByText("元数据来自内置目录")).toBeInTheDocument();

    // 再点一下绕过缓存。
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    await waitFor(() =>
      expect(mockIpc.ai.listModels).toHaveBeenLastCalledWith(expect.anything(), null, true),
    );
  });

  it("adds a profile from the selected preset", async () => {
    render(<LlmSettingsPanel />);
    await screen.findByLabelText("配置名称");

    fireEvent.change(screen.getByLabelText("预设"), { target: { value: "anthropic" } });
    fireEvent.click(screen.getByRole("button", { name: "新增" }));

    await waitFor(() => expect(screen.getAllByLabelText("配置名称")).toHaveLength(2));
    const names = screen.getAllByLabelText("配置名称");
    expect(names[names.length - 1]).toHaveValue("Anthropic");
    const protocols = screen.getAllByLabelText("协议");
    expect(protocols[protocols.length - 1]).toHaveValue("anthropic");
    const baseUrls = screen.getAllByLabelText("Base URL");
    expect(baseUrls[baseUrls.length - 1]).toHaveValue("https://api.anthropic.com");
  });

  it("exposes a discard action that restores the persisted draft", async () => {
    let actions: LlmSettingsActions | null = null;
    const onDirtyChange = vi.fn();
    render(
      <LlmSettingsPanel
        onDirtyChange={onDirtyChange}
        onRegisterActions={(next) => {
          actions = next;
        }}
      />,
    );
    const name = await screen.findByLabelText("配置名称");
    fireEvent.change(name, { target: { value: "不保存的修改" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    act(() => actions?.discard());

    expect(name).toHaveValue(profile.name);
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });
});
