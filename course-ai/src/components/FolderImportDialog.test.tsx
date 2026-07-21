import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
