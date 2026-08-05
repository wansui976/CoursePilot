import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseBackupAction } from "./DatabaseBackupAction";

const mocks = vi.hoisted(() => ({
  mobile: false,
  save: vi.fn(),
  create: vi.fn(),
  share: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@/lib/ipc", () => ({
  ipc: { backup: { create: mocks.create } },
}));
vi.mock("@/lib/mobileFiles", () => ({ shareFile: mocks.share }));
vi.mock("@/lib/platform", () => ({ isMobile: () => mocks.mobile }));

describe("DatabaseBackupAction", () => {
  beforeEach(() => {
    mocks.mobile = false;
    mocks.save.mockReset();
    mocks.create.mockReset();
    mocks.share.mockReset();
    mocks.save.mockResolvedValue("/Users/test/Documents/CoursePilot-backup.db");
    mocks.create.mockResolvedValue("/Users/test/Documents/CoursePilot-backup.db");
    mocks.share.mockResolvedValue(undefined);
  });

  it("lets desktop users choose an external file and reports success", async () => {
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "备份到文件…" }));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: expect.stringMatching(/^CoursePilot-backup-\d{8}-\d{6}\.db$/),
          filters: [{ name: "SQLite 数据库", extensions: ["db"] }],
        }),
      ),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      "/Users/test/Documents/CoursePilot-backup.db",
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "备份完成 · CoursePilot-backup.db",
    );
  });

  it("does not create a backup when the save dialog is canceled", async () => {
    mocks.save.mockResolvedValue(null);
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "备份到文件…" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the action disabled while SQLite is creating the snapshot", async () => {
    let finish!: (path: string) => void;
    mocks.create.mockImplementation(
      () => new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "备份到文件…" }));

    const busyButton = await screen.findByRole("button", { name: "备份中…" });
    expect(busyButton).toBeDisabled();
    finish("/Users/test/Documents/CoursePilot-backup.db");
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows backend failures instead of reporting a partial file as complete", async () => {
    mocks.create.mockRejectedValue(new Error("database integrity check failed"));
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "备份到文件…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "备份失败：database integrity check failed",
    );
  });

  it("creates an internal snapshot and opens system sharing on mobile", async () => {
    mocks.mobile = true;
    mocks.create.mockResolvedValue("/app/exports/CoursePilot-backup.db");
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "备份并分享" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(null));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.share).toHaveBeenCalledWith(
      "/app/exports/CoursePilot-backup.db",
      "application/vnd.sqlite3",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("备份已打开分享");
  });
});
