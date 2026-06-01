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
  setOne: (u: JobUpdate) => void;
  resetVideo: (videoId: string) => void;
}

export const useJobs = create<State>((set) => ({
  byVideo: {},
  setOne: (u) =>
    set((s) => ({
      byVideo: {
        ...s.byVideo,
        [u.video_id]: { ...(s.byVideo[u.video_id] || {}), [u.stage]: u },
      },
    })),
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
