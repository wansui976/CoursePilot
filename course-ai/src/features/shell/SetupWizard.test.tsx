import "@testing-library/jest-dom/vitest";
import "@/i18n";
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";

const { mockIpc, mockMobile } = vi.hoisted(() => ({
  mockMobile: { value: false },
  mockIpc: {
    pipeline: { asrReady: vi.fn() },
    whisper: { list: vi.fn(), download: vi.fn() },
    settings: { set: vi.fn() },
    app: { networkInfo: vi.fn() },
    ai: {
      detectOllama: vi.fn(),
      lectureEstimate: vi.fn(),
      listModels: vi.fn(),
      saveProfiles: vi.fn(),
    },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMobile: () => mockMobile.value,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));

const sensevoice = {
  id: "sensevoice",
  display_name: "SenseVoice",
  size_bytes: 240 * 1024 * 1024,
  url: "https://example.com/m",
  fits_memory: true,
};

function renderWizard(overrides: Partial<Parameters<typeof SetupWizard>[0]> = {}) {
  const props = { open: true, onClose: vi.fn(), onOpenSettings: vi.fn(), ...overrides };
  render(<SetupWizard {...props} />);
  return props;
}

describe("SetupWizard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    localStorage.clear();
    mockMobile.value = false;
    mockIpc.pipeline.asrReady.mockReset().mockResolvedValue(false);
    mockIpc.whisper.list.mockReset().mockResolvedValue([[sensevoice, false]]);
    mockIpc.whisper.download.mockReset().mockResolvedValue(undefined);
    mockIpc.settings.set.mockReset().mockResolvedValue(undefined);
    mockIpc.app.networkInfo.mockReset().mockResolvedValue({ metered: false });
    mockIpc.ai.detectOllama.mockReset().mockResolvedValue(null);
    mockIpc.ai.lectureEstimate.mockReset().mockResolvedValue({
      tokens: {
        promptTokens: 90_000,
        cachedTokens: 0,
        completionTokens: 28_000,
        fromHistory: false,
        videos: 0,
      },
      costPerHourUsd: [0.06, null],
    });
    mockIpc.ai.listModels.mockReset().mockResolvedValue({ models: [] });
    mockIpc.ai.saveProfiles.mockReset().mockResolvedValue(undefined);
  });

  it("downloads SenseVoice and switches recognition to it", async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "下载并使用（240 MB）" }));
    await waitFor(() => expect(mockIpc.settings.set).toHaveBeenCalledWith("whisper_model", "sensevoice"));
    expect(mockIpc.whisper.download).toHaveBeenCalledWith("sensevoice");
    expect(mockIpc.settings.set).toHaveBeenCalledWith("asr_backend", "whisper");
    expect(await screen.findByText("已改用本机识别（SenseVoice）。")).toBeInTheDocument();
  });

  it("points to cloud recognition when the device can't run the local model", async () => {
    mockIpc.whisper.list.mockResolvedValue([[{ ...sensevoice, fits_memory: false }, false]]);
    const props = renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "去设置识别…" }));
    expect(props.onOpenSettings).toHaveBeenCalledWith("asr");
    expect(mockIpc.whisper.download).not.toHaveBeenCalled();
  });

  it("shows the hourly cost of each option and saves the checked key for every task", async () => {
    renderWizard();
    const options = await screen.findByRole("radiogroup", { name: "大模型" });
    await waitFor(() => expect(within(options).getByText("一小时课约 ¥0.40")).toBeInTheDocument());
    expect(within(options).getByText("查不到价格")).toBeInTheDocument();
    expect(screen.getByText(/粗估：一小时课约/)).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "检查并保存" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("DeepSeek 的 API Key"), { target: { value: " sk-test " } });
    fireEvent.click(save);

    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalled());
    const [profile] = mockIpc.ai.listModels.mock.calls[0];
    expect(profile).toMatchObject({ base_url: "https://api.deepseek.com", model: "deepseek-flash" });
    expect(mockIpc.ai.listModels.mock.calls[0][1]).toBe("sk-test");
    const [profilesJson, routingJson, keys] = mockIpc.ai.saveProfiles.mock.calls[0];
    const saved = JSON.parse(profilesJson);
    expect(saved).toHaveLength(1);
    const routing = JSON.parse(routingJson);
    expect(routing.notes).toBe(saved[0].id);
    expect(routing.assistant).toBe(saved[0].id);
    expect(keys).toEqual({ [saved[0].id]: "sk-test" });
    expect(await screen.findByText("已保存，所有 AI 任务都用 deepseek-flash。")).toBeInTheDocument();
  });

  it("keeps the key and shows why when the check fails", async () => {
    mockIpc.ai.listModels.mockRejectedValue("HTTP 401 Unauthorized");
    renderWizard();
    fireEvent.change(await screen.findByLabelText("DeepSeek 的 API Key"), {
      target: { value: "sk-bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检查并保存" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mockIpc.ai.saveProfiles).not.toHaveBeenCalled();
    expect(screen.getByLabelText("DeepSeek 的 API Key")).toHaveValue("sk-bad");
  });

  it("offers a detected Ollama without a key", async () => {
    mockIpc.ai.detectOllama.mockResolvedValue(["qwen3:8b"]);
    mockIpc.ai.lectureEstimate.mockResolvedValue({
      tokens: { promptTokens: 1, cachedTokens: 0, completionTokens: 1, fromHistory: true, videos: 3 },
      costPerHourUsd: [0.06, 0.1, 0],
    });
    renderWizard();
    fireEvent.click(await screen.findByRole("radio", { name: /Ollama/ }));
    expect(screen.getByText("本机运行，不花钱")).toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/)).toBeNull();
    expect(screen.getByText(/按你最近处理过的 3 讲估算/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查并保存" }));
    await waitFor(() => expect(mockIpc.ai.saveProfiles).toHaveBeenCalled());
    expect(mockIpc.ai.saveProfiles.mock.calls[0][2]).toEqual({});
    expect(JSON.parse(mockIpc.ai.saveProfiles.mock.calls[0][0])[0].model).toBe("qwen3:8b");
  });

  it("remembers it was shown when closed", async () => {
    const props = renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "完成" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(localStorage.getItem("course-ai-setup-wizard-done")).toBe("1");
  });
});
