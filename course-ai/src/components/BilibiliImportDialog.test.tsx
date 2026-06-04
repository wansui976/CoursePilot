import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BilibiliImportDialog } from "./BilibiliImportDialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: {}, settings: {} } }));

describe("BilibiliImportDialog", () => {
  it("starts at the URL step", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BilibiliImportDialog courseId="c1" onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("视频链接")).toBeTruthy();
    expect(screen.getByText("下一步")).toBeTruthy();
  });
});
