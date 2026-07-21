import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { localDay } from "@/lib/studyStats";

const { dailyTotals, courseTotals, listCourses } = vi.hoisted(() => ({
  dailyTotals: vi.fn(),
  courseTotals: vi.fn(),
  listCourses: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    stats: { dailyTotals, courseTotals },
    courses: { list: listCourses },
  },
}));

function renderDashboard(onOpenCourse = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Dashboard onClose={vi.fn()} onOpenCourse={onOpenCourse} />
    </QueryClientProvider>,
  );
  return { onOpenCourse };
}

describe("Dashboard", () => {
  const today = localDay(new Date());

  beforeEach(() => {
    dailyTotals.mockReset().mockResolvedValue([{ day: today, watched_ms: 1_800_000 }]); // 今天 30 分钟
    courseTotals.mockReset().mockResolvedValue([
      { course_id: "c1", watched_ms: 3_600_000, last_ts: Date.now() },
    ]);
    listCourses.mockReset().mockResolvedValue([{ id: "c1", name: "申论课程" }]);
  });

  it("shows weekly time and a 1-day streak from today's activity", async () => {
    renderDashboard();
    expect(await screen.findByText("30 分钟")).toBeInTheDocument();
    expect(screen.getByText("1 天")).toBeInTheDocument();
  });

  it("lists each course with time studied and last-studied, and opens it on click", async () => {
    const { onOpenCourse } = renderDashboard();
    const card = await screen.findByText("申论课程");
    expect(screen.getByText(/已学 1 小时 · 上次 今天/)).toBeInTheDocument();

    fireEvent.click(card.closest("button")!);
    expect(onOpenCourse).toHaveBeenCalledWith("c1");
  });

  it("shows an empty state when there is no study record", async () => {
    courseTotals.mockResolvedValue([]);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/还没有学习记录/)).toBeInTheDocument(),
    );
  });
});
