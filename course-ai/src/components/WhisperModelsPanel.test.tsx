import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WhisperModelsPanel } from "./WhisperModelsPanel";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { whisper: { list: vi.fn(), download: vi.fn() } },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: () => false }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

describe("WhisperModelsPanel", () => {
  beforeEach(() => {
    mockIpc.whisper.list.mockReset();
    mockIpc.whisper.download.mockReset();
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
});
