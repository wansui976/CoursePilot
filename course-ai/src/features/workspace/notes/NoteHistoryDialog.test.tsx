import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteHistoryDialog } from "./NoteHistoryDialog";

const { noteVersions, readNoteImage } = vi.hoisted(() => ({
  noteVersions: vi.fn(),
  readNoteImage: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { ai: { noteVersions, readNoteImage } } }));

describe("笔记历史预览", () => {
  it("和编辑器同样显示：待办、代码块、图片", async () => {
    readNoteImage.mockRejectedValue(new Error("not found"));
    noteVersions.mockResolvedValue([
      {
        id: "h:1",
        source: "history",
        edited_at: Date.now() - 60_000,
        captured_at: Date.now(),
        content: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: true },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "推公式" }] }],
                },
              ],
            },
            { type: "codeBlock", content: [{ type: "text", text: "lr = 0.01" }] },
            { type: "image", attrs: { src: "note-image:x" } },
          ],
        }),
      },
    ]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <NoteHistoryDialog videoId="v1" open onOpenChange={() => {}} onRestore={() => {}} />
      </QueryClientProvider>,
    );
    const preview = await screen.findByRole("region", { name: "版本预览" });
    await waitFor(() => expect(preview).toHaveTextContent("推公式"));
    expect(preview.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(preview.querySelector("pre")).toHaveTextContent("lr = 0.01");
    await waitFor(() => expect(preview).toHaveTextContent("这张图片还没同步到这台设备"));
    expect(preview.querySelector('[contenteditable="true"]')).toBeNull();
  });
});
