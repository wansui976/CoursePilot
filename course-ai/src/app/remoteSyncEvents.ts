import { listen } from "@tauri-apps/api/event";
import type { QueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { hydratePlaybackProgress } from "@/lib/playback";

let started = false;

/**
 * 网盘同步把别的设备的改动并进了本地库：界面上的课程、笔记、复习卡、进度全部重新读一遍。
 * 应用回到前台时也催后台同步一轮（在手机上看完一节回到电脑，进度马上过来）。
 */
export function startRemoteSyncListener(queryClient: QueryClient) {
  if (started) return;
  started = true;
  void listen<number>("remote-sync:applied", () => {
    void queryClient.invalidateQueries();
    void hydratePlaybackProgress();
  }).catch(() => {});
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void ipc.remoteSync.nudge().catch(() => {});
    });
  }
}
