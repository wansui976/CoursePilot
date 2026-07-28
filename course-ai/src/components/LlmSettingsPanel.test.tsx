import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      getProfiles: vi.fn(),
      saveProfiles: vi.fn(),
      setApiKey: vi.fn(),
      hasApiKey: vi.fn(),
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
    mockIpc.settings.get.mockReset();
    confirmMock.mockReset();
    mockIpc.ai.getProfiles.mockResolvedValue([profile]);
    mockIpc.ai.saveProfiles.mockResolvedValue(undefined);
    mockIpc.ai.setApiKey.mockResolvedValue(undefined);
    mockIpc.ai.hasApiKey.mockResolvedValue(false);
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

    fireEvent.click(await screen.findByRole("button", { name: "删除此配置" }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith(
        expect.stringContaining("默认配置"),
        expect.objectContaining({ kind: "warning" }),
      ),
    );
    // 取消 → 配置保留。
    expect(screen.getByLabelText("配置名称")).toBeInTheDocument();

    confirmMock.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除此配置" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("配置名称")).not.toBeInTheDocument(),
    );
  });

  it("shows a failure badge when saving profiles fails", async () => {
    mockIpc.ai.saveProfiles.mockRejectedValue(new Error("disk full"));
    render(<LlmSettingsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "保存 LLM 配置" }));

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
});
