import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseBackupAction } from "./DatabaseBackupAction";

const mocks = vi.hoisted(() => ({
  mobile: false,
  save: vi.fn(),
  create: vi.fn(),
  restore: vi.fn(),
  share: vi.fn(),
  pickPersisted: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@/lib/ipc", () => ({
  ipc: { backup: { create: mocks.create, restore: mocks.restore } },
}));
vi.mock("@/lib/mobileFiles", () => ({
  shareFile: mocks.share,
  pickPersistedFile: mocks.pickPersisted,
}));
vi.mock("@/lib/platform", () => ({ isMobile: () => mocks.mobile }));

describe("DatabaseBackupAction", () => {
  beforeEach(() => {
    mocks.mobile = false;
    mocks.save.mockReset();
    mocks.create.mockReset();
    mocks.restore.mockReset();
    mocks.share.mockReset();
    mocks.pickPersisted.mockReset();
    mocks.save.mockResolvedValue("/Users/test/Documents/CoursePilot-backup.db");
    mocks.create.mockResolvedValue("/Users/test/Documents/CoursePilot-backup.db");
    mocks.restore.mockResolvedValue({
      snapshotPath: "/app/backups/restore/pre-restore.db",
      requiresRestart: true,
      restartRequested: true,
    });
    mocks.share.mockResolvedValue(undefined);
    mocks.pickPersisted.mockResolvedValue({
      path: "/Users/test/Documents/CoursePilot-backup.db",
      durationMs: null,
    });
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

  it("requires an explicit confirmation after choosing a restore file", async () => {
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "从文件恢复…" }));

    await waitFor(() =>
      expect(mocks.pickPersisted).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "database-restore-imports",
          filters: [
            { name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3"] },
          ],
        }),
      ),
    );
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(
      screen.getByRole("group", { name: "替换当前学习数据库？" }),
    ).toHaveTextContent("CoursePilot-backup.db");

    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));

    await waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith(
        "/Users/test/Documents/CoursePilot-backup.db",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "正在重启 CoursePilot 完成恢复",
    );
  });

  it("keeps the selected file available when backend validation fails", async () => {
    mocks.restore.mockRejectedValue(new Error("恢复文件版本过新"));
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "从文件恢复…" }));
    await screen.findByRole("group", { name: "替换当前学习数据库？" });
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "恢复失败：恢复文件版本过新",
    );
    expect(
      screen.getByRole("group", { name: "替换当前学习数据库？" }),
    ).toBeInTheDocument();
  });

  it("tells mobile users to fully reopen the app after validation", async () => {
    mocks.mobile = true;
    mocks.pickPersisted.mockResolvedValue({
      path: "/app/database-restore-imports/selected.db",
      durationMs: null,
    });
    mocks.restore.mockResolvedValue({
      snapshotPath: "/app/backups/restore/pre-restore.db",
      requiresRestart: true,
      restartRequested: false,
    });
    render(<DatabaseBackupAction />);

    fireEvent.click(screen.getByRole("button", { name: "从文件恢复…" }));
    expect(
      await screen.findByText(/完全退出并重新打开 CoursePilot/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "请完全退出并重新打开 CoursePilot 完成恢复",
    );
  });
});
