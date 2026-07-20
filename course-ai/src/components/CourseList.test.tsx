import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  { id: "c1", name: "申论课程", root_path: "/a", cover_image: null, created_at: 1, updated_at: 1 },
  { id: "c2", name: "行测课程", root_path: "/b", cover_image: null, created_at: 2, updated_at: 2 },
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
  });

  it("marks the selected course with aria-current=page and leaves others unset", async () => {
    renderList({ selectedCourseId: "c1" });
    const selected = await screen.findByRole("button", { name: "申论课程" });
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "行测课程" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("drops aria-current while the queue view is open (course not counted selected)", async () => {
    renderList({ selectedCourseId: "c1", queueOpen: true });
    const course = await screen.findByRole("button", { name: "申论课程" });
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

    const rename = await screen.findByRole("button", { name: "重命名" });
    // portal 到 body：菜单不再是滚动列表项的后代，而是 document.body 的直接子节点。
    const menu = rename.closest("[data-course-menu]");
    expect(menu).not.toBeNull();
    expect(menu!.parentElement).toBe(document.body);
  });

  it("shows a guiding empty state when there are no courses", async () => {
    mockIpc.courses.list.mockResolvedValue([]);
    renderList({ selectedCourseId: null });
    await waitFor(() =>
      expect(screen.getByText(/视频会按课程归档/)).toBeInTheDocument(),
    );
  });
});
