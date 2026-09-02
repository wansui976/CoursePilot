import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    backup: {
      create: vi.fn(),
    },
    settings: {
      get: vi.fn(),
      set: vi.fn(),
    },
    secrets: {
      set: vi.fn(),
      has: vi.fn(),
    },
    notify: vi.fn(),
  },
}));
const { pickDirectoryPathMock } = vi.hoisted(() => ({
  pickDirectoryPathMock: vi.fn(),
}));
const { saveFileMock, shareFileMock } = vi.hoisted(() => ({
  saveFileMock: vi.fn(),
  shareFileMock: vi.fn(),
}));
const mockUseContainerWidth = vi.hoisted(() => ({
  useContainerWidth: vi.fn(() => "wide"),
}));
const mockPlatform = vi.hoisted(() => ({
  isMobile: vi.fn(() => false),
  isTablet: vi.fn(() => false),
}));
const llmActionsMock = vi.hoisted(() => ({
  save: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/mobileFiles", () => ({
  pickDirectoryPath: pickDirectoryPathMock,
  shareFile: shareFileMock,
}));
vi.mock("@/lib/useContainerWidth", () => mockUseContainerWidth);
vi.mock("@/lib/platform", () => mockPlatform);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: saveFileMock }));
vi.mock("./WhisperModelsPanel", () => ({
  WhisperModelsPanel: () => <div>Whisper 下载</div>,
}));
vi.mock("./LlmSettingsPanel", () => ({
  LlmSettingsPanel: ({
    onDirtyChange,
    onRegisterActions,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
    onRegisterActions?: (actions: {
      save: () => Promise<boolean>;
      discard: () => void;
    }) => void;
  }) => {
    onRegisterActions?.(llmActionsMock);
    return (
      <div>
        LLM 配置
        <button type="button" onClick={() => onDirtyChange?.(true)}>
          模拟修改 LLM
        </button>
      </div>
    );
  },
}));

describe("SettingsPanel", () => {
  beforeEach(() => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("wide");
    mockPlatform.isMobile.mockReturnValue(false);
    mockPlatform.isTablet.mockReturnValue(false);
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "asr_backend") return "volcengine";
      if (key === "whisper_model") return "large-v3-turbo";
      return null;
    });
    mockIpc.settings.set.mockResolvedValue(undefined);
    mockIpc.backup.create.mockReset().mockResolvedValue("/tmp/CoursePilot-backup.db");
    mockIpc.secrets.set.mockResolvedValue(undefined);
    mockIpc.secrets.has.mockResolvedValue(false);
    pickDirectoryPathMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug/storage");
    mockIpc.notify.mockReset().mockResolvedValue(undefined);
    saveFileMock.mockReset().mockResolvedValue("/tmp/CoursePilot-backup.db");
    shareFileMock.mockReset().mockResolvedValue(undefined);
    llmActionsMock.save.mockReset().mockResolvedValue(true);
    llmActionsMock.discard.mockReset();
    localStorage.clear();
  });

  it("lets users select Volcengine ASR and save App ID + Access Token, hiding only the token", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    // 设置改成「侧栏分类 + 分组卡片」后，语音识别相关项在「语音识别」分类下。
    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));

    const backend = await screen.findByLabelText("识别后端");
    expect(backend).toHaveValue("volcengine");
    expect(screen.getByLabelText("App ID")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Access Token")).toHaveAttribute("type", "password");

    fireEvent.change(screen.getByLabelText("App ID"), {
      target: { value: "app-123" },
    });
    fireEvent.change(screen.getByLabelText("Access Token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存火山 ASR 凭证" }));

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "volcengine_asr_app_id",
        "app-123",
      ),
    );
    // 密钥（Access Token）走密钥存储，而非明文 settings。
    expect(mockIpc.secrets.set).toHaveBeenCalledWith(
      "volcengine_asr_access_token",
      "secret-token",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  });

  it("keeps the study reminder switch in settings, not on the dashboard", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "学习" }));
    const toggle = await screen.findByRole("switch", { name: "到期复习提醒" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(localStorage.getItem("course-ai-reminder-enabled")).toBe("1");
    // 开启时立刻发一条确认通知，顺带触发系统权限询问。
    await waitFor(() => expect(mockIpc.notify).toHaveBeenCalled());
  });

  it("shows a 已配置 hint when a secret is already stored", async () => {
    mockIpc.secrets.has.mockResolvedValue(true);
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));

    // 已配置的密钥字段在提示里回显「已配置」，即使输入框为空也让用户确信已存。
    expect(
      await screen.findByText("已配置 · 留空 = 不修改"),
    ).toBeInTheDocument();
    expect(mockIpc.secrets.has).toHaveBeenCalledWith("volcengine_asr_access_token");
  });

  it("saves the app-data storage root on Android", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "存储" }));
    fireEvent.click(screen.getByRole("button", { name: "选择" }));

    await waitFor(() =>
      expect(pickDirectoryPathMock).toHaveBeenCalledWith(["storage"]),
    );
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "default_storage_root",
        "/data/user/0/dev.courseai.app.debug/storage",
      ),
    );
  });

  it("clears the storage root back to the default", async () => {
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "default_storage_root") return "/data/root";
      return null;
    });
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "存储" }));
    const input = await screen.findByDisplayValue("/data/root");

    // 脚注写「留空 = 跟视频同目录」，必须给清空手段。
    fireEvent.click(screen.getByRole("button", { name: "清除" }));

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("default_storage_root", ""),
    );
    expect(input).toHaveValue("");
  });

  it("places full database backup and its credential warning under storage", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "存储" }));

    expect(screen.getByText("完整数据库备份")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "备份到文件…" })).toBeInTheDocument();
    expect(screen.getByText(/备份包含已保存的 API 密钥/)).toBeInTheDocument();
    expect(screen.getByText(/不包含视频、音频、课件图片和本地模型/)).toBeInTheDocument();
  });

  it("normalizes an invalid correction concurrency on blur", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    const input = await screen.findByLabelText("AI 纠错并发数");

    // 输入 0 时 onChange 不落库；失焦要夹回有效区间并保存，不留「显示 0 实存 8」。
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "asr_correction_concurrency",
        "1",
      ),
    );
    expect(input).toHaveValue(1);
  });

  it("surfaces an error banner when an instant setting write fails", async () => {
    mockIpc.settings.set.mockRejectedValue(new Error("db locked"));
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    const language = await screen.findByLabelText("识别语言");

    // 即时保存的设置失败不能无声无息：界面显示了新值但库里没存。
    fireEvent.change(language, { target: { value: "en" } });

    expect(await screen.findByText(/设置保存失败/)).toBeInTheDocument();
  });

  it("does not let a different setting's success hide an earlier field failure", async () => {
    let rejectLanguage!: (error: unknown) => void;
    const languageWrite = new Promise<void>((_resolve, reject) => {
      rejectLanguage = reject;
    });
    mockIpc.settings.set.mockImplementation((key: string) =>
      key === "asr_language" ? languageWrite : Promise.resolve(),
    );
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    fireEvent.change(await screen.findByLabelText("识别语言"), {
      target: { value: "en" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "导入字幕后用 AI 纠错" }));
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("subtitle_autocorrect", "false"),
    );

    act(() => rejectLanguage(new Error("language write failed")));

    expect(await screen.findByText(/设置保存失败.*language write failed/)).toBeInTheDocument();
  });

  it("surfaces initialization failures instead of leaving an unhandled rejection", async () => {
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "asr_language") throw new Error("database unavailable");
      return null;
    });

    render(<SettingsPanel onClose={() => undefined} />);

    expect(await screen.findByText(/设置加载失败：.*database unavailable/)).toBeInTheDocument();
  });

  it("toggles subtitle autocorrect through a switch control", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    const sw = await screen.findByRole("switch", { name: "导入字幕后用 AI 纠错" });

    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "subtitle_autocorrect",
        "false",
      ),
    );
  });

  it("shows a red failure badge when saving credentials fails", async () => {
    mockIpc.settings.set.mockRejectedValue(new Error("boom"));
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    fireEvent.change(await screen.findByLabelText("App ID"), {
      target: { value: "app-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存火山 ASR 凭证" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent(/保存失败/);

    // 错误需要留到下一次保存，用户可能要先离开窗口定位凭证或网络问题。
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(10_000));
    expect(failure).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("turns automatic slide extraction off and persists the choice", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "课件 / OCR" }));
    // 没设置过时默认开着：导入后就自动跑，不用用户再点一次。
    const toggle = await screen.findByLabelText("导入后自动提取课件");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("slides_auto_extract", "off"),
    );
  });

  it("renders the slides sensitivity slider in the modern styled variant", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "课件 / OCR" }));
    const slider = await screen.findByLabelText("课件提取灵敏度");

    // 自绘滑条：ca-slider 负责白色滑块与轨道；--slider-fill 驱动已滑过段的填充。
    expect(slider).toHaveClass("ca-slider");
    fireEvent.change(slider, { target: { value: "80" } });
    expect((slider as HTMLElement).style.getPropertyValue("--slider-fill")).toBe("80%");
  });

  it("switches slides sensitivity to auto and disables the slider", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "课件 / OCR" }));
    const slider = await screen.findByLabelText("课件提取灵敏度");
    expect(slider).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText("课件提取自动灵敏度"));

    // 自动档下门槛由后端按画面噪声定，手调滑块就不该再有作用。
    expect(await screen.findByLabelText("课件提取灵敏度")).toBeDisabled();
    expect(screen.getByText("自动")).toBeInTheDocument();
    expect(localStorage.getItem("slides-sensitivity")).toBe("auto");
  });

  it("lets users choose the first accent color from a color picker", () => {
    render(<SettingsPanel onClose={() => undefined} />);

    const picker = screen.getByLabelText("自定义强调色");
    const swatch = picker.parentElement?.querySelector("span") as HTMLElement;

    expect(picker.parentElement).toHaveAttribute("title", "多色");
    expect(swatch.style.background).toContain("conic-gradient");

    fireEvent.change(picker, {
      target: { value: "#123456" },
    });

    expect(localStorage.getItem("course-ai-accent")).toBe("custom");
    expect(localStorage.getItem("course-ai-custom-accent")).toBe("#123456");
  });

  it("lets users choose DeepSeek Vision OCR and save model, base URL, and API key", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "课件 / OCR" }));
    fireEvent.change(await screen.findByLabelText("OCR 引擎"), {
      target: { value: "deepseek" },
    });

    // 选 DeepSeek 后出现模型、地址、API Key 三个输入与保存按钮。
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("ocr_backend", "deepseek"),
    );
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "deepseek-v4-flash-vision-exp" },
    });
    fireEvent.change(screen.getByLabelText("地址 (Base URL)"), {
      target: { value: "https://api.deepseek.com" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "sk-ds-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 DeepSeek 视觉识别凭证" }));

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("deepseek_ocr_model", "deepseek-v4-flash-vision-exp"),
    );
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("deepseek_ocr_base_url", "https://api.deepseek.com"),
    );
    expect(mockIpc.secrets.set).toHaveBeenCalledWith("deepseek_ocr_api_key", "sk-ds-key");
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  });

  it("uses compact drill-down on iPad Split View while keeping native mobile backends", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockPlatform.isMobile.mockReturnValue(true);
    mockPlatform.isTablet.mockReturnValue(true);
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "asr_backend") return "volcengine";
      return null;
    });

    render(<SettingsPanel onClose={() => undefined} />);

    expect(await screen.findByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "外观", level: 2 })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "语音识别" }));

    const backend = await screen.findByLabelText("识别后端");
    expect(backend).toHaveValue("volcengine");
    expect(screen.queryByRole("option", { name: "本地 Whisper" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "火山录音文件识别" })).toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(await screen.findByRole("button", { name: "课件 / OCR" }));
    expect(await screen.findByLabelText("OCR 引擎")).toHaveValue("local");
    expect(screen.getByRole("option", { name: "本地 OCR（离线）" })).toBeInTheDocument();
  });

  it("uses registered system back to leave compact detail before closing settings", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    const onClose = vi.fn();
    let requestBack: (() => void) | null = null;

    render(
      <SettingsPanel
        onClose={onClose}
        onRegisterBackRequest={(request) => {
          requestBack = request;
        }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "语音识别" }));
    expect(await screen.findByLabelText("识别后端")).toBeInTheDocument();

    act(() => requestBack?.());

    expect(await screen.findByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    expect(screen.queryByLabelText("识别后端")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    act(() => requestBack?.());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("blocks category changes until dirty LLM edits are saved or discarded", async () => {
    render(<SettingsPanel onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "大模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟修改 LLM" }));

    fireEvent.click(screen.getByRole("button", { name: "外观" }));

    expect(
      screen.getByRole("dialog", { name: "有未保存的 LLM 修改" }),
    ).toBeInTheDocument();
    expect(screen.getByText("LLM 配置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("LLM 配置")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "外观" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(llmActionsMock.discard).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "外观", level: 2 })).toBeInTheDocument();
  });

  it("saves dirty LLM edits before closing settings", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "大模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟修改 LLM" }));

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存并继续" }));

    await waitFor(() => expect(llmActionsMock.save).toHaveBeenCalledOnce());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("routes external navigation through the same dirty LLM guard", async () => {
    const continuation = vi.fn();
    let requestExit: ((next: () => void) => void) | null = null;
    render(
      <SettingsPanel
        onClose={() => undefined}
        onRegisterExitRequest={(request) => {
          requestExit = request;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "大模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模拟修改 LLM" }));

    act(() => requestExit?.(continuation));

    expect(continuation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "有未保存的 LLM 修改" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));

    expect(llmActionsMock.discard).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledOnce();
  });
});
