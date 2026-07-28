import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
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
const mockUseContainerWidth = vi.hoisted(() => ({
  useContainerWidth: vi.fn(() => "wide"),
}));
const mockPlatform = vi.hoisted(() => ({
  isMobile: vi.fn(() => false),
  isTablet: vi.fn(() => false),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/mobileFiles", () => ({ pickDirectoryPath: pickDirectoryPathMock }));
vi.mock("@/lib/useContainerWidth", () => mockUseContainerWidth);
vi.mock("@/lib/platform", () => mockPlatform);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./WhisperModelsPanel", () => ({
  WhisperModelsPanel: () => <div>Whisper 下载</div>,
}));
vi.mock("./LlmSettingsPanel", () => ({
  LlmSettingsPanel: () => <div>LLM 配置</div>,
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
    mockIpc.secrets.set.mockResolvedValue(undefined);
    mockIpc.secrets.has.mockResolvedValue(false);
    pickDirectoryPathMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug/storage");
    mockIpc.notify.mockReset().mockResolvedValue(undefined);
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

    expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
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

  it("uses the tablet category sidebar on iPad with native mobile backends", async () => {
    mockUseContainerWidth.useContainerWidth.mockReturnValue("medium");
    mockPlatform.isMobile.mockReturnValue(true);
    mockPlatform.isTablet.mockReturnValue(true);
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "asr_backend") return "volcengine";
      return null;
    });

    render(<SettingsPanel onClose={() => undefined} />);

    expect(await screen.findByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "外观", level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "语音识别" }));

    const backend = await screen.findByLabelText("识别后端");
    expect(backend).toHaveValue("volcengine");
    expect(screen.queryByRole("option", { name: "本地 Whisper" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "火山录音文件识别" })).toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "课件 / OCR" }));
    expect(await screen.findByLabelText("OCR 引擎")).toHaveValue("local");
    expect(screen.getByRole("option", { name: "本地 OCR（离线）" })).toBeInTheDocument();
  });
});
