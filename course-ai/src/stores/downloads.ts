import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { DownloadJob, DownloadStatus } from "@/lib/ipc";
import { jobPercent } from "@/lib/downloadProgress";

interface State {
  byId: Record<string, DownloadJob>;
  /** 入队顺序；下载完成前的占位行按它排。 */
  order: string[];
  /** 后端推来的实时进度。 */
  upsert: (job: DownloadJob) => void;
  /** 入队响应带来的任务（事件可能早于响应到达：已有记录的以事件为准）。 */
  addMany: (jobs: DownloadJob[]) => void;
  remove: (id: string) => void;
  /** 一批结束后清掉已完成的记录（失败的留着给用户看/移除）。 */
  clearFinished: (courseId: string) => void;
  /** 启动/重挂时用后端快照补齐。 */
  seed: (jobs: DownloadJob[]) => void;
}

export function isActiveDownload(status: DownloadStatus | undefined): boolean {
  return status === "queued" || status === "downloading" || status === "merging";
}

/** 队列页与课程列表都要看：下载中、排队中、失败（失败要展示原因）。 */
export function isVisibleDownload(status: DownloadStatus | undefined): boolean {
  return isActiveDownload(status) || status === "failed";
}

/** 队列徽标：下载中/排队中 + 失败待处理。 */
export const selectDownloadCount = (state: State): number =>
  state.order.reduce((count, id) => {
    const job = state.byId[id];
    return count + (isVisibleDownload(job?.status) ? 1 : 0);
  }, 0);

export const useDownloads = create<State>((set) => ({
  byId: {},
  order: [],
  upsert: (job) =>
    set((state) => {
      const current = state.byId[job.id];
      let next = job;
      // 同一轮尝试里进度只进不退：视频流下满 100% 后音频流从 0 开始，
      // 不夹一下进度条会从 100 跳回 90。换清晰度重下（attempt+1）才允许归零。
      if (
        current &&
        current.attempt === job.attempt &&
        job.status !== "done" &&
        jobPercent(job) < jobPercent(current)
      ) {
        next = { ...job, downloaded: current.downloaded, total: current.total };
      }
      return {
        byId: { ...state.byId, [job.id]: next },
        order: state.byId[job.id] ? state.order : [...state.order, job.id],
      };
    }),
  addMany: (jobs) =>
    set((state) => {
      if (jobs.length === 0) return state;
      const byId = { ...state.byId };
      const order = [...state.order];
      for (const job of jobs) {
        // 入队响应只是入队那一刻的快照（排队中、0 字节）。后端起任务后立刻推进度事件，
        // 这些事件常常比响应先到——已有记录就一定比快照新，不能拿快照盖回去，
        // 否则下得飞快（或瞬间失败）的任务会被打回「排队中」，之后再没有事件来纠正。
        if (byId[job.id]) continue;
        order.push(job.id);
        byId[job.id] = job;
      }
      return { byId, order };
    }),
  remove: (id) =>
    set((state) => {
      const byId = { ...state.byId };
      delete byId[id];
      return { byId, order: state.order.filter((jobId) => jobId !== id) };
    }),
  clearFinished: (courseId) =>
    set((state) => {
      const byId = { ...state.byId };
      let changed = false;
      for (const [id, job] of Object.entries(byId)) {
        if (
          job.courseId === courseId &&
          (job.status === "done" || job.status === "canceled")
        ) {
          delete byId[id];
          changed = true;
        }
      }
      return changed
        ? { byId, order: state.order.filter((id) => byId[id]) }
        : state;
    }),
  seed: (jobs) =>
    set({
      byId: Object.fromEntries(jobs.map((job) => [job.id, job])),
      order: jobs.map((job) => job.id),
    }),
}));

let started = false;

export function startDownloadListener() {
  if (started) return;
  started = true;
  void listen<DownloadJob>("download:update", (event) => {
    useDownloads.getState().upsert(event.payload);
  });
}
