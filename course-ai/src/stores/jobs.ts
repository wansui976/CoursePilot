import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

export interface JobUpdate {
  video_id: string;
  job_id: string;
  stage: string;
  status: "pending" | "running" | "done" | "failed" | "canceled";
  progress: number;
  message: string | null;
}

interface State {
  byVideo: Record<string, Record<string, JobUpdate>>;
  /** 后端推来的实时进度。 */
  setOne: (u: JobUpdate) => void;
  /** 从库里读的快照：进队列、启动时恢复，用来补上还没收到事件的阶段。 */
  seed: (u: JobUpdate) => void;
  resetVideo: (videoId: string) => void;
}

function withJob(s: State, u: JobUpdate): Pick<State, "byVideo"> {
  return {
    byVideo: {
      ...s.byVideo,
      [u.video_id]: { ...(s.byVideo[u.video_id] || {}), [u.stage]: u },
    },
  };
}

export const useJobs = create<State>((set) => ({
  byVideo: {},
  // 同一个任务还在跑，进度只进不退：进度条往回跳，用户读到的是「白干了」。
  // 换了任务、或者跑完又重新开始（状态变过）才从新的进度算起。
  setOne: (u) =>
    set((s) => {
      const current = s.byVideo[u.video_id]?.[u.stage];
      const sameRun =
        current?.job_id === u.job_id && current.status === "running" && u.status === "running";
      return withJob(s, sameRun ? { ...u, progress: Math.max(current.progress, u.progress) } : u);
    }),
  // 库里只记阶段里程碑，逐段的细进度只走事件，快照往往比已经收到的事件旧——拿它盖上去，
  // 进度会退回进入这一步时的数（本地识别 18%、云端识别 28%），已经做完的步骤还会退回「进行中」。
  // 所以收到过事件的任务以事件为准，快照只补还没听到的。
  seed: (u) =>
    set((s) => (s.byVideo[u.video_id]?.[u.stage]?.job_id === u.job_id ? s : withJob(s, u))),
  resetVideo: (id) =>
    set((s) => {
      const copy = { ...s.byVideo };
      delete copy[id];
      return { byVideo: copy };
    }),
}));

let started = false;

export function startJobListener() {
  if (started) return;
  started = true;
  void listen<JobUpdate>("job:update", (event) => {
    useJobs.getState().setOne(event.payload);
  });
}
