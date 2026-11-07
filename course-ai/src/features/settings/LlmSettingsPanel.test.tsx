import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      detectOllama: vi.fn(),
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
    mockIpc.ai.detectOllama.mockReset().mockResolvedValue(null);
  });

  it("detects a running local Ollama and adds it in one click, picking a chat model", async () => {
    mockIpc.ai.detectOllama.mockResolvedValue(["nomic-embed-text:latest", "qwen2.5:7b"]);
    render(<LlmSettingsPanel />);

    const banner = await screen.findByText(/检测到本机正在运行的 Ollama，已装 2 个模型/);
    expect(banner).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加本机 Ollama" }));

    const names = screen.getAllByLabelText("配置名称");
    expect(names[names.length - 1]).toHaveValue("Ollama（本机）");
    const models = screen.getAllByLabelText("模型名");
    // 嵌入模型不能聊天：跳过 nomic-embed-text，默认选 qwen2.5:7b。
    expect(models[models.length - 1]).toHaveValue("qwen2.5:7b");
    const urls = screen.getAllByLabelText("Base URL");
    expect(urls[urls.length - 1]).toHaveValue("http://127.0.0.1:11434");
    // 加上之后提示就收起，不再重复劝。
    expect(screen.queryByText(/检测到本机正在运行的 Ollama/)).not.toBeInTheDocument();
  });

  it("says how to pull a model when Ollama is running but empty", async () => {
    mockIpc.ai.detectOllama.mockResolvedValue([]);
    render(<LlmSettingsPanel />);
    expect(await screen.findByText(/还没有下载模型/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加本机 Ollama" })).not.toBeInTheDocument();
  });

  it("does not mention Ollama when it is not running or already configured", async () => {
    render(<LlmSettingsPanel />);
    await screen.findByLabelText("配置名称");
    await waitFor(() => expect(mockIpc.ai.detectOllama).toHaveBeenCalled());
    expect(screen.queryByText(/检测到本机/)).not.toBeInTheDocument();

    mockIpc.ai.detectOllama.mockResolvedValue(["qwen2.5:7b"]);
    mockIpc.ai.getProfiles.mockResolvedValue([
      { id: "o1", name: "我的 Ollama", kind: "ollama", base_url: "http://127.0.0.1:11434", model: "qwen2.5:7b" },
    ]);
    cleanup();
    render(<LlmSettingsPanel />);
    await screen.findByDisplayValue("我的 Ollama");
    await waitFor(() => expect(mockIpc.ai.detectOllama).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/检测到本机正在运行的 Ollama/)).not.toBeInTheDocument();
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

  it("does not let a failed load overwrite the saved config", async () => {
    mockIpc.ai.getProfiles.mockRejectedValueOnce(new Error("db locked"));
    render(<LlmSettingsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("db locked");
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mockIpc.ai.saveProfiles).not.toHaveBeenCalled();

    // 重试成功后恢复编辑，错误条消失。
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("配置名称")).toHaveValue(profile.name);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps manual digest routing when the active profile is removed", async () => {
    mockIpc.ai.getProfiles.mockResolvedValue([
      profile,
      {
        id: "p2",
        name: "便宜配置",
        kind: "openai" as const,
        base_url: "https://api.deepseek.com",
        model: "deepseek-chat",
      },
    ]);
    mockIpc.settings.get.mockResolvedValue(
      JSON.stringify({ notes: "p1", digest: "p2" }),
    );
    confirmMock.mockResolvedValue(true);
    render(<LlmSettingsPanel />);

    await screen.findByDisplayValue(profile.name);
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    await waitFor(() =>
      expect(screen.queryByDisplayValue(profile.name)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalledOnce());
    const routing = JSON.parse(mockIpc.ai.saveProfiles.mock.calls[0][1]);
    // 默认跟着剩下的第一个走，但手工配的 digest 不能被一起冲掉。
    expect(routing.notes).toBe("p2");
    expect(routing.digest).toBe("p2");
  });

  it("sends typed keys in the same save call as the profiles", async () => {
    render(<LlmSettingsPanel />);

    const keyInput = await screen.findByLabelText("API Key");
    fireEvent.change(keyInput, { target: { value: "sk-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalledOnce());
    expect(mockIpc.ai.saveProfiles.mock.calls[0][2]).toEqual({ p1: "sk-draft" });
  });

  it("blocks saving a profile with an empty model name", async () => {
    render(<LlmSettingsPanel />);
    await screen.findByLabelText("配置名称");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await waitFor(() => expect(screen.getAllByLabelText("配置名称")).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/模型名不能为空/)).toBeInTheDocument();
    expect(mockIpc.ai.saveProfiles).not.toHaveBeenCalled();
  });

  it("asks for the key again when an endpoint with a stored key is changed", async () => {
    mockIpc.ai.hasApiKey.mockResolvedValue(true);
    render(<LlmSettingsPanel />);
    await screen.findByText("已配置");

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://attacker.example/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/重新填写 API Key/)).toBeInTheDocument();
    expect(mockIpc.ai.saveProfiles).not.toHaveBeenCalled();

    // 输入新 Key 后允许保存，Key 与配置一起提交。
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalledOnce());
    expect(mockIpc.ai.saveProfiles.mock.calls[0][2]).toEqual({ p1: "sk-new" });
  });

  it("does not keep a key for a profile deleted before saving", async () => {
    confirmMock.mockResolvedValue(true);
    render(<LlmSettingsPanel />);
    await screen.findByLabelText("配置名称");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    await waitFor(() => expect(screen.getAllByLabelText("配置名称")).toHaveLength(2));
    const keyInputs = screen.getAllByLabelText("API Key");
    fireEvent.change(keyInputs[keyInputs.length - 1], {
      target: { value: "sk-orphan" },
    });
    const deletes = screen.getAllByRole("button", { name: "删除" });
    fireEvent.click(deletes[deletes.length - 1]);
    await waitFor(() => expect(screen.getAllByLabelText("配置名称")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalledOnce());
    expect(mockIpc.ai.saveProfiles.mock.calls[0][2]).toEqual({});
    const savedProfiles = JSON.parse(mockIpc.ai.saveProfiles.mock.calls[0][0]);
    expect(savedProfiles.map((saved: { id: string }) => saved.id)).toEqual(["p1"]);
  });
});
