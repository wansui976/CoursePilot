import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AutoGenerateSection } from "./AutoGenerateSection";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: { settings: { get: vi.fn(), set: vi.fn() } },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

describe("AutoGenerateSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    mockIpc.settings.get.mockReset();
    mockIpc.settings.set.mockReset().mockResolvedValue(undefined);
  });

  it("has everything on until the user turns something off", async () => {
    mockIpc.settings.get.mockResolvedValue(null);
    render(<AutoGenerateSection />);
    await waitFor(() => expect(mockIpc.settings.get).toHaveBeenCalledWith("auto_ai_tasks"));
    for (const name of ["章节", "摘要", "笔记", "出题", "脑图"]) {
      expect(screen.getByRole("switch", { name })).toBeChecked();
    }
  });

  it("reads saved switches and writes the whole set back when one is flipped", async () => {
    mockIpc.settings.get.mockResolvedValue(JSON.stringify({ quiz: false }));
    render(<AutoGenerateSection />);
    await waitFor(() => expect(screen.getByRole("switch", { name: "出题" })).not.toBeChecked());

    fireEvent.click(screen.getByRole("switch", { name: "脑图" }));
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith(
        "auto_ai_tasks",
        JSON.stringify({ chapters: true, summary: true, notes: true, quiz: false, mindmap: false }),
      ),
    );
  });

  it("puts the switch back when saving fails", async () => {
    mockIpc.settings.get.mockResolvedValue(null);
    mockIpc.settings.set.mockRejectedValue(new Error("disk full"));
    render(<AutoGenerateSection />);
    const notes = await screen.findByRole("switch", { name: "笔记" });
    fireEvent.click(notes);
    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
    expect(notes).toBeChecked();
  });
});
