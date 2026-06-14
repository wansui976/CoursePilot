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
    },
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
    pickDirectoryPathMock.mockResolvedValue("/data/user/0/dev.courseai.app.debug/storage");
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

  it("uses the tablet category sidebar on iPad while keeping mobile cloud backend choices", async () => {
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
    expect(screen.queryByRole("button", { name: "课件" })).not.toBeInTheDocument();
  });
});
