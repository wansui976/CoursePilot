import { create } from "zustand";

interface State {
  videoId: string | null;
  currentMs: number;
  durationMs: number;
  seekRequest: { ms: number; nonce: number } | null;
  setVideo: (id: string | null) => void;
  setCurrentMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
  requestSeek: (ms: number) => void;
}

let nonce = 0;

export const usePlayer = create<State>((set) => ({
  videoId: null,
  currentMs: 0,
  durationMs: 0,
  seekRequest: null,
  setVideo: (id) =>
    set({ videoId: id, currentMs: 0, durationMs: 0, seekRequest: null }),
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setDurationMs: (ms) => set({ durationMs: ms }),
  requestSeek: (ms) => set({ seekRequest: { ms, nonce: ++nonce } }),
}));
