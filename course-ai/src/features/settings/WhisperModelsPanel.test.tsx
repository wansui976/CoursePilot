import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhisperModelsPanel } from "./WhisperModelsPanel";

const { mockIpc, platform, confirmDialog, openDialog } = vi.hoisted(() => ({
  mockIpc: {
    whisper: {
      list: vi.fn(),
      download: vi.fn(),
      modelsDir: vi.fn(),
      setModelsDir: vi.fn(),
      deleteLegacyModels: vi.fn(),
      deleteModel: vi.fn(),
    },
    app: { networkInfo: vi.fn() },
  },
  platform: { mobile: false },
  confirmDialog: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: () => platform.mobile }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmDialog, open: openDialog }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("WhisperModelsPanel", () => {
  beforeEach(() => {
    mockIpc.whisper.list.mockReset();
    mockIpc.whisper.download.mockReset();
    mockIpc.app.networkInfo.mockReset();
    confirmDialog.mockReset();
    openDialog.mockReset();
    mockIpc.whisper.modelsDir.mockReset().mockResolvedValue({
      path: "C:\\Users\\me\\AppData\\Roaming\\dev.courseai.app",
      is_default: true,
      default_path: "C:\\Users\\me\\AppData\\Roaming\\dev.courseai.app",
      size_bytes: 1_200_000_000,
      legacy_bytes: 0,
    });
    mockIpc.whisper.setModelsDir.mockReset();
    mockIpc.whisper.deleteLegacyModels.mockReset();
    mockIpc.whisper.deleteModel.mockReset();
    platform.mobile = false;
  });

  it("shows where models live and moves them to a folder the user picks", async () => {
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, true]]);
    openDialog.mockResolvedValue("D:\\CoursePilotModels");
    mockIpc.whisper.setModelsDir.mockResolvedValue({
      path: "D:\\CoursePilotModels",
      is_default: false,
      default_path: "C:\\Users\\me\\AppData\\Roaming\\dev.courseai.app",
      size_bytes: 1_200_000_000,
      legacy_bytes: 0,
    });

    render(<WhisperModelsPanel />);
    expect(await screen.findByText(/AppData/)).toBeInTheDocument();
    expect(screen.getByText(/（默认） · 1\.1 GB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更改位置…" }));

    await waitFor(() => expect(mockIpc.whisper.setModelsDir).toHaveBeenCalledWith("D:\\CoursePilotModels"));
    expect(await screen.findByText("D:\\CoursePilotModels")).toBeInTheDocument();
    // 搬完重新拉清单，已装状态按新目录算。
    await waitFor(() => expect(mockIpc.whisper.list).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "恢复默认位置" }));
    await waitFor(() => expect(mockIpc.whisper.setModelsDir).toHaveBeenLastCalledWith(null));
  });

  it("does not move anything when the folder picker is cancelled, and shows move errors", async () => {
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, true]]);
    openDialog.mockResolvedValueOnce(null);
    render(<WhisperModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "更改位置…" }));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(mockIpc.whisper.setModelsDir).not.toHaveBeenCalled();

    openDialog.mockResolvedValueOnce("E:\\models");
    // 和真实的 invoke 一样，后端 AppError::Config 到前端是带前缀的字符串。
    mockIpc.whisper.setModelsDir.mockRejectedValueOnce(
      "config error: 有模型在下载或视频在处理，等它们结束后再换存放位置",
    );
    fireEvent.click(screen.getByRole("button", { name: "更改位置…" }));
    expect(await screen.findByText(/等它们结束后再换存放位置/)).toBeInTheDocument();
  });

  it("offers to delete old model files that are no longer used, after confirming", async () => {
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, true]]);
    mockIpc.whisper.modelsDir.mockResolvedValue({
      path: "C:\\models",
      is_default: true,
      default_path: "C:\\models",
      size_bytes: 2_000_000_000,
      legacy_bytes: 1_100_000_000,
    });
    mockIpc.whisper.deleteLegacyModels.mockResolvedValue({
      path: "C:\\models",
      is_default: true,
      default_path: "C:\\models",
      size_bytes: 900_000_000,
      legacy_bytes: 0,
    });
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    render(<WhisperModelsPanel />);
    expect(await screen.findByText(/旧版模型文件 1\.0 GB 已不再使用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除旧模型" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(mockIpc.whisper.deleteLegacyModels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除旧模型" }));
    await waitFor(() => expect(mockIpc.whisper.deleteLegacyModels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/已不再使用/)).not.toBeInTheDocument());
  });

  it("does not offer a models location on phones", async () => {
    platform.mobile = true;
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, true]]);
    render(<WhisperModelsPanel />);
    await screen.findByText("SenseVoice");
    expect(screen.queryByRole("button", { name: "更改位置…" })).not.toBeInTheDocument();
    expect(mockIpc.whisper.modelsDir).not.toHaveBeenCalled();
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

  it("deletes an installed model after confirming, and refreshes the list and the used space", async () => {
    const qwen = { ...sensevoice, id: "qwen3-asr", display_name: "Qwen3-ASR 0.6B", size_bytes: 1_020_000_000 };
    mockIpc.whisper.list.mockResolvedValueOnce([[sensevoice, true], [qwen, true]]);
    render(<WhisperModelsPanel />);
    const remove = await screen.findByRole("button", { name: "删除 Qwen3-ASR 0.6B" });
    // 没装的才有「下载」，装了的才有「删除」。
    expect(screen.queryByRole("button", { name: "下载" })).not.toBeInTheDocument();

    // 取消确认：什么都不删。
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(remove);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0]).toContain("约 973 MB");
    expect(mockIpc.whisper.deleteModel).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    mockIpc.whisper.deleteModel.mockResolvedValueOnce(undefined);
    mockIpc.whisper.list.mockResolvedValueOnce([[sensevoice, true], [qwen, false]]);
    const dirLoads = mockIpc.whisper.modelsDir.mock.calls.length;
    fireEvent.click(remove);
    await waitFor(() => expect(mockIpc.whisper.deleteModel).toHaveBeenCalledWith("qwen3-asr"));
    expect(await screen.findByRole("button", { name: "下载" })).toBeInTheDocument();
    // 上面的「已用空间」跟着重读。
    await waitFor(() => expect(mockIpc.whisper.modelsDir.mock.calls.length).toBeGreaterThan(dirLoads));
  });

  it("shows why a model could not be deleted", async () => {
    mockIpc.whisper.list.mockResolvedValue([[sensevoice, true]]);
    confirmDialog.mockResolvedValue(true);
    mockIpc.whisper.deleteModel.mockRejectedValueOnce(
      "config error: 有模型在下载或视频在处理，等它们结束后再删",
    );
    render(<WhisperModelsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "删除 SenseVoice" }));
    expect(await screen.findByText(/等它们结束后再删/)).toBeInTheDocument();
  });
});
