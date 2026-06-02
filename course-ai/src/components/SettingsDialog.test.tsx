import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsDialog";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    settings: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./WhisperModelsPanel", () => ({
  WhisperModelsPanel: () => <div>Whisper 下载</div>,
}));
vi.mock("./LlmSettingsPanel", () => ({
  LlmSettingsPanel: () => <div>LLM 配置</div>,
}));

describe("SettingsPanel", () => {
  beforeEach(() => {
    mockIpc.settings.get.mockImplementation(async (key: string) => {
      if (key === "asr_backend") return "volcengine";
      if (key === "whisper_model") return "large-v3-turbo";
      return null;
    });
    mockIpc.settings.set.mockResolvedValue(undefined);
  });

  it("lets users select Volcengine ASR and save App ID + Access Token, hiding only the token", async () => {
    render(<SettingsPanel onClose={() => undefined} />);

    const backend = await screen.findByLabelText("语音识别后端");
    expect(backend).toHaveValue("volcengine");
    expect(screen.getByLabelText("火山 ASR App ID")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("火山 ASR Access Token")).toHaveAttribute("type", "password");

    fireEvent.change(screen.getByLabelText("火山 ASR App ID"), {
      target: { value: "app-123" },
    });
    fireEvent.change(screen.getByLabelText("火山 ASR Access Token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存火山 ASR 凭证" }));

    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "volcengine_asr_app_id",
        "app-123",
      ),
    );
    expect(mockIpc.settings.set).toHaveBeenCalledWith(
      "volcengine_asr_access_token",
      "secret-token",
    );
  });
});
