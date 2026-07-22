import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    stats: { dailyTotals, courseTotals, continueLearning, courseVideoIds },
    courses: { list: listCourses },
    srs: { countDue, weakConcepts, dueByConcept, dueByCourse, review },
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
    weakConcepts.mockReset().mockResolvedValue([]);
    dueByConcept.mockReset().mockResolvedValue([]);
    dueByCourse.mockReset().mockResolvedValue([]);
    courseVideoIds.mockReset().mockResolvedValue([]);
    review.mockReset().mockResolvedValue(undefined);
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

  it("renders the study heatmap with today's activity cell", async () => {
    renderDashboard();
    expect(await screen.findByRole("img", { name: /学习热力图/ })).toBeInTheDocument();
    // 今天学了 30 分钟 → 该格带时长说明的悬浮 title。
    expect(screen.getByTitle(new RegExp(`${today} · `))).toBeInTheDocument();
  });

  it("shows today's goal progress and lets you edit the goal", async () => {
    // 今天学了 30 分钟（dailyTotals 默认），默认目标 30 分钟 → 100%。
    renderDashboard();
    expect(await screen.findByText(/今日已学 30 分钟 \/ 目标 30 分钟/)).toBeInTheDocument();

    // 编辑目标为 60 → 文案与百分比更新，并落地 localStorage。
    fireEvent.click(screen.getByRole("button", { name: "编辑目标" }));
    const input = screen.getByLabelText("每日目标（分钟）");
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/今日已学 30 分钟 \/ 目标 60 分钟/)).toBeInTheDocument();
    expect(localStorage.getItem("course-ai-daily-goal-min")).toBe("60");
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
