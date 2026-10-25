import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import type { DownloadJob, DownloadStatus } from "@/lib/ipc";

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
  // 后端报的就是整条总进度（开下前就拿到了视频流+音频流的总大小，见 download.rs 的
  // ProgressFolder），原样收下。这里不再按百分比「只进不退」地夹：拿不到总大小的少数
  // 来源换流时总量会变大，夹住的话进度条会在 100% 一直停到音频流下完。
  upsert: (job) =>
    set((state) => ({
      byId: { ...state.byId, [job.id]: job },
      order: state.byId[job.id] ? state.order : [...state.order, job.id],
    })),
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
