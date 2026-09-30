import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CourseList } from "./CourseList";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    courses: {
      list: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      relinkRoot: vi.fn(),
    },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), message: vi.fn() }));
vi.mock("@/lib/mobileFiles", () => ({ isIOS: () => false, pickDirectoryPath: vi.fn() }));

const courses = [
  { id: "c1", name: "申论课程", root_path: "/a", cover_image: null, created_at: 1, updated_at: 1, video_count: 3 },
  { id: "c2", name: "行测课程", root_path: "/b", cover_image: null, created_at: 2, updated_at: 2, video_count: 5 },
];

function renderList(overrides: Partial<Parameters<typeof CourseList>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CourseList selectedCourseId="c1" onSelect={vi.fn()} {...overrides} />
    </QueryClientProvider>,
  );
}

describe("CourseList", () => {
  beforeEach(() => {
    mockIpc.courses.list.mockReset().mockResolvedValue(courses);
    mockIpc.courses.rename.mockReset().mockResolvedValue(undefined);
    mockIpc.courses.delete.mockReset().mockResolvedValue(undefined);
    mockIpc.courses.relinkRoot.mockReset();
  });

  it("marks the selected course with aria-current=page and leaves others unset", async () => {
    renderList({ selectedCourseId: "c1" });
    const selected = await screen.findByRole("button", { name: /申论课程/ });
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /行测课程/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("drops aria-current while the queue view is open (course not counted selected)", async () => {
    renderList({ selectedCourseId: "c1", queueOpen: true });
    const course = await screen.findByRole("button", { name: /申论课程/ });
    expect(course).not.toHaveAttribute("aria-current");
  });

  it("reveals the row action button when the row gains keyboard focus", async () => {
    renderList({ selectedCourseId: "c1" });
    const actionButtons = await screen.findAllByRole("button", { name: "课程操作" });
    // 默认隐藏（仅 hover 显现），但键盘聚焦本行时通过 group-focus-within 显现。
    expect(actionButtons[0].className).toContain("group-focus-within:opacity-100");
    expect(actionButtons[0].className).toContain("opacity-0");
  });

  it("renders the row action menu in a body portal so the scroll container can't clip it", async () => {
    renderList({ selectedCourseId: "c1" });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);

    const rename = await screen.findByRole("menuitem", { name: "重命名" });
    // portal 到 body：菜单不再是滚动列表项的后代，而是 document.body 的直接子节点。
    const menu = rename.closest("[data-course-menu]");
    expect(menu).not.toBeNull();
    expect(menu!.parentElement).toBe(document.body);
    expect(menu).toHaveAttribute("role", "menu");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu!.id);
  });

  it("focuses and navigates menu items, then Escape closes and restores the trigger", async () => {
    renderList({ selectedCourseId: "c1" });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "课程操作" });
    const items = screen.getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "End" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: "Home" });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "课程操作" })[0]).toHaveFocus(),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does not move focus to the trigger when an outside pointer closes the menu", async () => {
    renderList({ selectedCourseId: "c1" });
    const courseButton = await screen.findByRole("button", { name: /申论课程/ });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);
    await screen.findByRole("menu");

    courseButton.focus();
    const backdrop = document.querySelector<HTMLElement>("[data-course-menu-backdrop]");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(courseButton).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });

  it("closes on Tab without forcing focus back to the trigger", async () => {
    renderList({ selectedCourseId: "c1" });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);

    const first = await screen.findByRole("menuitem", { name: "重命名" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "Tab" });

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).not.toHaveFocus();
  });

  it("registers a transient close while the action menu is open", async () => {
    const onTransientCloseChange = vi.fn();
    renderList({ selectedCourseId: null, onTransientCloseChange });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];

    fireEvent.click(trigger);
    await waitFor(() => {
      const calls = onTransientCloseChange.mock.calls;
      const latest = calls[calls.length - 1]?.[0];
      expect(latest).toBeTypeOf("function");
    });
    const calls = onTransientCloseChange.mock.calls;
    const close = calls[calls.length - 1]?.[0] as
      | (() => void)
      | undefined;
    expect(close).toBeTypeOf("function");

    act(() => close?.());

    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onTransientCloseChange).toHaveBeenLastCalledWith(null);
  });

  it("registers rename cancellation as the next transient layer", async () => {
    const onTransientCloseChange = vi.fn();
    renderList({ selectedCourseId: null, onTransientCloseChange });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));

    const input = screen.getByRole("textbox", { name: "重命名课程" });
    expect(input).toHaveFocus();
    await waitFor(() => {
      const calls = onTransientCloseChange.mock.calls;
      expect(calls[calls.length - 1]?.[0]).toBeTypeOf("function");
    });
    const calls = onTransientCloseChange.mock.calls;
    const close = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    expect(close).toBeTypeOf("function");

    act(() => close?.());

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "重命名课程" })).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "课程操作" })[0]).toHaveFocus(),
    );
    expect(mockIpc.courses.rename).not.toHaveBeenCalled();
  });

  it("keeps the rename draft visible when persistence fails and allows retry", async () => {
    mockIpc.courses.rename
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce(undefined);
    renderList({ selectedCourseId: "c1" });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名课程" });
    fireEvent.change(input, { target: { value: "新的课程名" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent("database locked");
    expect(input).toHaveValue("新的课程名");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockIpc.courses.rename).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "重命名课程" })).not.toBeInTheDocument(),
    );
  });

  it("keeps system back from dismissing a rename while its save is pending", async () => {
    let finishRename!: () => void;
    mockIpc.courses.rename.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRename = resolve;
      }),
    );
    const onTransientCloseChange = vi.fn();
    renderList({ selectedCourseId: "c1", onTransientCloseChange });
    fireEvent.click((await screen.findAllByRole("button", { name: "课程操作" }))[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名课程" });
    fireEvent.change(input, { target: { value: "保存中的课程名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mockIpc.courses.rename).toHaveBeenCalledOnce());

    const calls = onTransientCloseChange.mock.calls;
    const close = calls[calls.length - 1]?.[0] as (() => void) | undefined;
    act(() => close?.());
    expect(screen.getByRole("textbox", { name: "重命名课程" })).toBeDisabled();

    act(() => finishRename());
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "重命名课程" })).not.toBeInTheDocument(),
    );
  });

  it("keeps the sidebar empty state concise when there are no courses", async () => {
    mockIpc.courses.list.mockResolvedValue([]);
    renderList({ selectedCourseId: null });
    await waitFor(() =>
      expect(screen.getByText("暂无课程")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/视频会按课程归档/)).not.toBeInTheDocument();
  });

  it("removes a deleted course from the list after confirming", async () => {
    // 复现：删课程后课程卡片还在。删掉后后端 list 不再返回它（软删被过滤），
    // 前端必须因失效重拉而把它从列表里去掉。
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(confirm).mockResolvedValue(true);
    mockIpc.courses.delete.mockResolvedValue(undefined);
    mockIpc.courses.list
      .mockResolvedValueOnce(courses)
      .mockResolvedValue([courses[1]]);

    renderList({ selectedCourseId: "c1" });

    await screen.findByRole("button", { name: /申论课程/ });
    const trigger = (await screen.findAllByRole("button", { name: "课程操作" }))[0];
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    await waitFor(() => expect(mockIpc.courses.delete).toHaveBeenCalledWith("c1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /申论课程/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /行测课程/ })).toBeInTheDocument();
  });

  it("identifies the exact same-named course in the delete confirmation", async () => {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    // 模块级 mock 不随用例清空：上一条删除用例已调用过一次 confirm。
    vi.mocked(confirm).mockClear();
    vi.mocked(confirm).mockResolvedValue(true);
    const sameNamedCourses = [
      { ...courses[0], name: "同名课程", root_path: "/courses/first", video_count: 3 },
      { ...courses[1], name: "同名课程", root_path: "/courses/second", video_count: 8 },
    ];
    mockIpc.courses.list.mockResolvedValue(sameNamedCourses);

    renderList({ selectedCourseId: "c1" });
    const triggers = await screen.findAllByRole("button", { name: "课程操作" });
    fireEvent.click(triggers[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const prompt = vi.mocked(confirm).mock.calls[0]?.[0];
    expect(prompt).toContain("同名课程");
    expect(prompt).toContain("/courses/second");
    expect(prompt).toContain("视频：8 个");
    await waitFor(() => expect(mockIpc.courses.delete).toHaveBeenCalledWith("c2"));
  });
});
