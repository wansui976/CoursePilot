import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext, type Shell } from "@/app/shell";
import { CommandPalette } from "./CommandPalette";
import { makeNav } from "./testNav";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: { list: vi.fn() },
    videos: { list: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const course = {
  id: "c1",
  name: "机器学习",
  root_path: "/tmp/c",
  cover_image: null,
  created_at: 1,
  updated_at: 1,
  video_count: 2,
  sort_order: null,
  color: null,
};
const video = (id: string, title: string) => ({
  id,
  course_id: "c1",
  title,
  source_type: "local",
  source_uri: null,
  file_path: `/tmp/${id}.mp4`,
  duration_ms: 1000,
  width: null,
  height: null,
  order_index: 0,
  data_dir: "/tmp/d",
  processed_status: "done",
  created_at: 1,
  has_transcript: true,
});

function renderPalette(shell: Partial<Shell> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fullShell = {
    selectCourse: vi.fn(),
    openQueuedVideo: vi.fn(),
    openSettingsCategory: vi.fn(),
    openVideoAt: vi.fn(),
    selectedVideo: undefined,
    selectedCourse: undefined,
    videoReturn: null,
    ...shell,
  } as unknown as Shell;
  const nav = makeNav();
  render(
    <QueryClientProvider client={client}>
      <ShellContext.Provider value={fullShell}>
        <CommandPalette nav={nav} />
      </ShellContext.Provider>
    </QueryClientProvider>,
  );
  return { shell: fullShell, nav };
}

function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.getByRole("combobox");
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  mockIpc.courses.list.mockResolvedValue([course]);
  mockIpc.videos.list.mockResolvedValue([video("v1", "01 梯度下降"), video("v2", "02 反向传播")]);
});

describe("CommandPalette", () => {
  it("opens with ⌘K and finds videos across courses", async () => {
    const { shell } = renderPalette();
    const input = openPalette();
    fireEvent.change(input, { target: { value: "反向" } });
    const option = await screen.findByRole("option", { name: /02 反向传播/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(shell.openQueuedVideo).toHaveBeenCalledWith(expect.objectContaining({ id: "v2" })));
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("moves the selection with arrow keys and opens pages", async () => {
    const { nav } = renderPalette();
    const input = openPalette();
    fireEvent.change(input, { target: { value: "回收" } });
    await screen.findByRole("option", { name: "回收站" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(nav.onOpenRecycleBin).toHaveBeenCalled());
  });

  it("offers a jump when a time is typed while a video is open", async () => {
    const current = video("v1", "01 梯度下降");
    const { shell } = renderPalette({ selectedVideo: current as unknown as Shell["selectedVideo"] });
    const input = openPalette();
    fireEvent.change(input, { target: { value: "12:30" } });
    fireEvent.click(await screen.findByRole("option", { name: /跳到 12:30/ }));
    await waitFor(() => expect(shell.openVideoAt).toHaveBeenCalledWith("v1", 750_000));
  });

  it("opens settings categories", async () => {
    const { shell } = renderPalette();
    const input = openPalette();
    fireEvent.change(input, { target: { value: "快捷键" } });
    fireEvent.click(await screen.findByRole("option", { name: /^快捷键设置/ }));
    await waitFor(() => expect(shell.openSettingsCategory).toHaveBeenCalledWith("shortcuts"));
  });
});
