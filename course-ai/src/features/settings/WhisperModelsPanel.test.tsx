import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhisperModelsPanel } from "./WhisperModelsPanel";

const { mockIpc, platform, confirmDialog } = vi.hoisted(() => ({
  mockIpc: {
    whisper: { list: vi.fn(), download: vi.fn() },
    app: { networkInfo: vi.fn() },
  },
  platform: { mobile: false },
  confirmDialog: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: () => platform.mobile }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmDialog }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("WhisperModelsPanel", () => {
  beforeEach(() => {
    mockIpc.whisper.list.mockReset();
    mockIpc.whisper.download.mockReset();
    mockIpc.app.networkInfo.mockReset();
    confirmDialog.mockReset();
    platform.mobile = false;
  });

  const sensevoice = {
    id: "sensevoice",
    display_name: "SenseVoice",
    size_bytes: 240_000_000,
    url: "",
  };

  it("asks before downloading over mobile data and stops when declined", async () => {
    platform.mobile = true;
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, false]]);
    mockIpc.app.networkInfo.mockResolvedValue({ metered: true });
    confirmDialog.mockResolvedValue(false);

    render(<WhisperModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "下载" }));

    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0]).toContain("SenseVoice 约 229 MB");
    expect(mockIpc.whisper.download).not.toHaveBeenCalled();
  });

  it("downloads after the user accepts mobile data, and right away on Wi-Fi", async () => {
    platform.mobile = true;
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, false]]);
    mockIpc.whisper.download.mockResolvedValue(undefined);
    mockIpc.app.networkInfo.mockResolvedValueOnce({ metered: true });
    confirmDialog.mockResolvedValue(true);

    render(<WhisperModelsPanel />);
    const download = await screen.findByRole("button", { name: "下载" });
    fireEvent.click(download);
    await waitFor(() => expect(mockIpc.whisper.download).toHaveBeenCalledWith("sensevoice"));

    mockIpc.app.networkInfo.mockResolvedValueOnce({ metered: false });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    await waitFor(() => expect(mockIpc.whisper.download).toHaveBeenCalledTimes(2));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it("never checks the network on desktop", async () => {
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, false]]);
    mockIpc.whisper.download.mockResolvedValue(undefined);

    render(<WhisperModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "下载" }));

    await waitFor(() => expect(mockIpc.whisper.download).toHaveBeenCalled());
    expect(mockIpc.app.networkInfo).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("shows each model's download size to help users choose", async () => {
    mockIpc.whisper.list.mockResolvedValue([
      [
        {
          id: "large-v3-turbo",
          display_name: "large-v3-turbo",
          size_bytes: 1_610_612_736, // 1.5 GB
          url: "",
        },
        false,
      ],
      [
        { id: "tiny", display_name: "tiny", size_bytes: 78_643_200, url: "" }, // 75 MB
        true,
      ],
    ]);

    render(<WhisperModelsPanel />);

    expect(await screen.findByText("1.5 GB")).toBeInTheDocument();
    expect(screen.getByText("75 MB")).toBeInTheDocument();
  });

  it("reports model-list failures and lets users retry", async () => {
    mockIpc.whisper.list
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);

    render(<WhisperModelsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型列表加载失败：Error: offline",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mockIpc.whisper.list).toHaveBeenCalledTimes(2);
  });

  it("reports download failures and lets users retry without leaving the model stuck", async () => {
    mockIpc.whisper.list.mockResolvedValue([
      [
        { id: "tiny", display_name: "tiny", size_bytes: 78_643_200, url: "" },
        false,
      ],
    ]);
    mockIpc.whisper.download
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    render(<WhisperModelsPanel />);
    const download = await screen.findByRole("button", { name: "下载" });
    fireEvent.click(download);

    expect(await screen.findByRole("alert")).toHaveTextContent("磁盘空间不足，请清理后重试");
    expect(download).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(mockIpc.whisper.download).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(download).toBeEnabled();
  });
});
