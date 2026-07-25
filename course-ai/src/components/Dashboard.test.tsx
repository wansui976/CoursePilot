import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { localDay } from "@/lib/studyStats";

const {
  dailyTotals,
  courseTotals,
  continueLearning,
  courseVideoIds,
  listCourses,
  countDue,
  weakConcepts,
  dueByConcept,
  dueByCourse,
  review,
  notify,
} = vi.hoisted(() => ({
  dailyTotals: vi.fn(),
  courseTotals: vi.fn(),
  continueLearning: vi.fn(),
  courseVideoIds: vi.fn(),
  listCourses: vi.fn(),
  countDue: vi.fn(),
  weakConcepts: vi.fn(),
  dueByConcept: vi.fn(),
  dueByCourse: vi.fn(),
  review: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    stats: { dailyTotals, courseTotals, continueLearning, courseVideoIds },
    courses: { list: listCourses },
    srs: { countDue, weakConcepts, dueByConcept, dueByCourse, review },
    notify,
  },
}));

function renderDashboard(onOpenCourse = vi.fn(), onResume = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <Dashboard
        onClose={vi.fn()}
        onOpenCourse={onOpenCourse}
        onResume={onResume}
        onJump={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onOpenCourse, onResume, ...view };
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
    weakConcepts.mockReset().mockResolvedValue([]);
    dueByConcept.mockReset().mockResolvedValue([]);
    dueByCourse.mockReset().mockResolvedValue([]);
    courseVideoIds.mockReset().mockResolvedValue([]);
    review.mockReset().mockResolvedValue(undefined);
    notify.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
  });

  it("shows weekly time and a 1-day streak from today's activity", async () => {
    renderDashboard();
    const stats = await screen.findByRole("group", { name: "学习统计" });
    await waitFor(() => {
      expect(within(stats).getByRole("region", { name: "今日学习" })).toHaveTextContent(
        "30 分钟",
      );
      expect(within(stats).getByRole("region", { name: "本周学习" })).toHaveTextContent(
        "30 分钟",
      );
      expect(within(stats).getByRole("region", { name: "连续学习" })).toHaveTextContent(
        "1 天",
      );
    });
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
        video_title: "第三讲 归纳概括.mp4",
        last_ts: Date.now(),
      },
    ]);
    // 该视频的续播进度：看到 300/600 秒（50%）。
    localStorage.setItem("video-pos:v-last", "300");
    localStorage.setItem("video-dur:v-last", "600");

    const { onResume } = renderDashboard();

    const entry = await screen.findByText("第三讲 归纳概括");
    expect(screen.queryByText("第三讲 归纳概括.mp4")).not.toBeInTheDocument();
    expect(screen.getByText(/已看 50%/)).toBeInTheDocument();

    const continueHeading = screen.getByText("继续学习");
    const reviewEntry = screen.getByText("今天没有待复习");
    expect(
      continueHeading.compareDocumentPosition(reviewEntry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(entry.closest("button")!);
    expect(onResume).toHaveBeenCalledWith("c1", "v-last", 300);
  });

  it("surfaces weak topics and launches a concept-scoped review", async () => {
    weakConcepts.mockResolvedValue([
      {
        concept_id: "k1",
        name: "贝叶斯定理",
        course_id: "c1",
        course_name: "申论课程",
        reviews: 4,
        fails: 3,
        again_rate: 0.75,
      },
    ]);
    dueByConcept.mockResolvedValue([
      { id: "d1", video_id: "v1", course_id: "c1", front: "薄弱卡正面", back: "背面", source_ms: 1000 },
    ]);
    renderDashboard();

    expect(await screen.findByText("贝叶斯定理")).toBeInTheDocument();
    expect(screen.getByText(/差评率 75%/)).toBeInTheDocument();

    // 点「复习」→ 概念作用域会话，按概念拉到期卡。
    fireEvent.click(screen.getByText("贝叶斯定理").closest("button")!);
    await waitFor(() => expect(dueByConcept).toHaveBeenCalledWith("c1", "k1"));
    expect(await screen.findByText("薄弱卡正面")).toBeInTheDocument();
  });

  it("renders a labeled square heatmap and outlines today's activity", async () => {
    renderDashboard();
    const grid = await screen.findByRole("group", {
      name: "最近 26 周学习热力图",
    });
    const todayCell = await within(grid).findByRole("button", {
      name: `${today} · 学习 30 分钟`,
    });
    expect(todayCell).toHaveAttribute("aria-current", "date");
    expect(todayCell).toHaveClass("rounded-[2px]", "outline-2");
    expect(screen.queryByText("周一")).not.toBeInTheDocument();
    expect(screen.queryByText("周三")).not.toBeInTheDocument();
    expect(screen.queryByText("周五")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^\d{1,2}月$/).length).toBeGreaterThan(0);
    const monthDividers = grid.querySelectorAll("[data-month-divider]");
    expect(monthDividers.length).toBeGreaterThan(0);
    monthDividers.forEach((divider) => {
      expect(divider).toHaveAttribute("aria-hidden", "true");
      expect(divider).toHaveClass("border-dashed", "opacity-60");
      expect(divider.parentElement?.querySelector('[data-heat-day$="-01"]')).not.toBeNull();
    });
    expect(screen.getByRole("status")).toHaveTextContent(`${today} · 学习 30 分钟`);
  });

  it.each([
    [480, 12],
    [768, 18],
    [1024, 26],
  ])("shows %i px viewports with a %i-week heatmap", async (width, weeks) => {
    window.innerWidth = width;
    renderDashboard();
    expect(
      await screen.findByRole("group", {
        name: `最近 ${weeks} 周学习热力图`,
      }),
    ).toBeInTheDocument();
  });

  it("shows date details on focus/click and supports arrow-key navigation", async () => {
    const yesterdayDate = new Date(`${today}T00:00:00`);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = localDay(yesterdayDate);
    const priorWeekDate = new Date(`${today}T00:00:00`);
    priorWeekDate.setDate(priorWeekDate.getDate() - 7);
    const priorWeek = localDay(priorWeekDate);

    renderDashboard();
    const grid = await screen.findByRole("group", {
      name: "最近 26 周学习热力图",
    });
    const detail = screen.getByRole("status");
    const yesterdayCell = within(grid).getByRole("button", {
      name: `${yesterday} · 未学习`,
    });
    fireEvent.focus(yesterdayCell);
    expect(detail).toHaveTextContent(`${yesterday} · 未学习`);

    const todayCell = await within(grid).findByRole("button", {
      name: `${today} · 学习 30 分钟`,
    });
    fireEvent.click(todayCell);
    expect(detail).toHaveTextContent(`${today} · 学习 30 分钟`);

    fireEvent.keyDown(todayCell, { key: "ArrowLeft" });
    const priorWeekCell = within(grid).getByRole("button", {
      name: `${priorWeek} · 未学习`,
    });
    await waitFor(() => {
      expect(detail).toHaveTextContent(`${priorWeek} · 未学习`);
      expect(priorWeekCell).toHaveFocus();
    });
  });

  it("shows a three-column summary with daily and weekly goals, and edits the goal", async () => {
    renderDashboard();
    const stats = await screen.findByRole("group", { name: "学习统计" });
    const todayStat = within(stats).getByRole("region", { name: "今日学习" });
    const weekStat = within(stats).getByRole("region", { name: "本周学习" });
    await waitFor(() => {
      expect(todayStat).toHaveTextContent("30 分钟");
      expect(todayStat).toHaveTextContent("目标 30 分钟");
      expect(weekStat).toHaveTextContent("目标 3 小时 30 分 · 14%");
    });

    fireEvent.click(screen.getByRole("button", { name: "编辑目标" }));
    const dialog = screen.getByRole("dialog", { name: "设置每日目标" });
    const dial = within(dialog).getByRole("slider", { name: "每日学习目标" });
    expect(dial).toHaveAttribute("aria-valuenow", "30");
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(dial).toHaveAttribute("aria-valuenow", "60");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(todayStat).toHaveTextContent("目标 60 分钟");
      expect(weekStat).toHaveTextContent("目标 7 小时 · 7%");
    });
    expect(localStorage.getItem("course-ai-daily-goal-min")).toBe("60");
  });

  it("toggles the study reminder on and fires a confirmation notification", async () => {
    renderDashboard();
    const toggle = await screen.findByRole("switch", { name: "学习提醒" });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("course-ai-reminder-enabled")).toBe("1");
    await waitFor(() => expect(notify).toHaveBeenCalled());
  });

  it("shows a course completion ring and a due badge on the course card", async () => {
    courseVideoIds.mockResolvedValue([
      ["c1", "v1"],
      ["c1", "v2"],
      ["c1", "v3"],
    ]);
    dueByCourse.mockResolvedValue([["c1", 4]]);
    // v1、v2 已看完（ratio 1.0），v3 才看了一点 → 完成 2/3。
    for (const id of ["v1", "v2"]) {
      localStorage.setItem(`video-pos:${id}`, "100");
      localStorage.setItem(`video-dur:${id}`, "100");
    }
    localStorage.setItem("video-pos:v3", "5");
    localStorage.setItem("video-dur:v3", "100");

    renderDashboard();

    await screen.findByText("申论课程");
    expect(screen.getByText(/完成 2\/3 讲/)).toBeInTheDocument();
    expect(screen.getByText("待复习 4")).toBeInTheDocument();
  });

  it("shows an empty state when there is no study record", async () => {
    courseTotals.mockResolvedValue([]);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/还没有学习记录/)).toBeInTheDocument(),
    );
  });
});
