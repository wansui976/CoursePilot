import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FolderImportDialog } from "./FolderImportDialog";

const { addLocalBatch } = vi.hoisted(() => ({ addLocalBatch: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { videos: { addLocalBatch } } }));

const videos = [
  { path: "/f/part1.mp4", name: "part1" },
  { path: "/f/part2.mp4", name: "part2" },
  { path: "/f/part10.mp4", name: "part10" },
];

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <FolderImportDialog courseId="c1" videos={videos} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("FolderImportDialog", () => {
  beforeEach(() => addLocalBatch.mockReset().mockResolvedValue([]));

  it("selects everything by default and imports the checked paths in order", async () => {
    const { onClose } = renderDialog();
    expect(screen.getByText("已选 3 / 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入 (3)" }));

    await waitFor(() =>
      expect(addLocalBatch).toHaveBeenCalledWith("c1", [
        "/f/part1.mp4",
        "/f/part2.mp4",
        "/f/part10.mp4",
      ]),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("unchecking an item narrows the import set", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 part2" }));
    expect(screen.getByText("已选 2 / 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导入 (2)" }));

    await waitFor(() =>
      expect(addLocalBatch).toHaveBeenCalledWith("c1", [
        "/f/part1.mp4",
        "/f/part10.mp4",
      ]),
    );
  });

  it("select-all toggle clears the selection and disables import", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));
    expect(screen.getByText("已选 0 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入 (0)" })).toBeDisabled();
  });

  it("closes on cancel without importing", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalled();
    expect(addLocalBatch).not.toHaveBeenCalled();
  });

  it("restores focus to the opener after Escape closes the modal", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开文件夹导入
          </button>
          {open && (
            <QueryClientProvider
              client={new QueryClient({
                defaultOptions: { mutations: { retry: false } },
              })}
            >
              <FolderImportDialog
                courseId="c1"
                videos={videos}
                onClose={() => setOpen(false)}
              />
            </QueryClientProvider>
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开文件夹导入" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "全不选" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("cannot close with Escape or an outside pointer while importing", async () => {
    let finishImport!: (videos: never[]) => void;
    const importing = new Promise<never[]>((resolve) => {
      finishImport = resolve;
    });
    addLocalBatch.mockReturnValue(importing);
    const { onClose } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "导入 (3)" }));
    await screen.findByRole("button", { name: "导入中…" });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(screen.getByTestId("folder-import-overlay"));

    expect(onClose).not.toHaveBeenCalled();

    finishImport([]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
