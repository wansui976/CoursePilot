import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { localDay } from "@/lib/studyStats";

const { dailyTotals, courseTotals, continueLearning, listCourses, countDue } =
  vi.hoisted(() => ({
    dailyTotals: vi.fn(),
    courseTotals: vi.fn(),
    continueLearning: vi.fn(),
    listCourses: vi.fn(),
    countDue: vi.fn(),
  }));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    stats: { dailyTotals, courseTotals, continueLearning },
    courses: { list: listCourses },
    srs: { countDue },
  },
}));

function renderDashboard(onOpenCourse = vi.fn(), onResume = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <Dashboard
        onClose={vi.fn()}
        onOpenCourse={onOpenCourse}
        onResume={onResume}
        onJump={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onOpenCourse, onResume };
}

describe("Dashboard", () => {
  const today = localDay(new Date());

  beforeEach(() => {
    dailyTotals.mockReset().mockResolvedValue([{ day: today, watched_ms: 1_800_000 }]); // 今天 30 分钟
    courseTotals.mockReset().mockResolvedValue([
      { course_id: "c1", watched_ms: 3_600_000, last_ts: Date.now() },
    ]);
    listCourses.mockReset().mockResolvedValue([{ id: "c1", name: "申论课程" }]);
    countDue.mockReset().mockResolvedValue(0);
    continueLearning.mockReset().mockResolvedValue([]);
    localStorage.clear();
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

  it("shows a continue-learning entry with progress and resumes on click", async () => {
    continueLearning.mockResolvedValue([
      {
        course_id: "c1",
        course_name: "申论课程",
        video_id: "v-last",
        video_title: "第三讲 归纳概括",
        last_ts: Date.now(),
      },
    ]);
    // 该视频的续播进度：看到 300/600 秒（50%）。
    localStorage.setItem("video-pos:v-last", "300");
    localStorage.setItem("video-dur:v-last", "600");

    const { onResume } = renderDashboard();

    const entry = await screen.findByText("第三讲 归纳概括");
    expect(screen.getByText(/已看 50%/)).toBeInTheDocument();

    fireEvent.click(entry.closest("button")!);
    expect(onResume).toHaveBeenCalledWith("c1", "v-last", 300);
  });

  it("renders the study heatmap with today's activity cell", async () => {
    renderDashboard();
    expect(await screen.findByRole("img", { name: /学习热力图/ })).toBeInTheDocument();
    // 今天学了 30 分钟 → 该格带时长说明的悬浮 title。
    expect(screen.getByTitle(new RegExp(`${today} · `))).toBeInTheDocument();
  });

  it("shows an empty state when there is no study record", async () => {
    courseTotals.mockResolvedValue([]);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/还没有学习记录/)).toBeInTheDocument(),
    );
  });
});
