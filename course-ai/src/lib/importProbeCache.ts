import { ipc } from "./ipc";
import type { ProbeResult } from "./types";

/**
 * 导入确认卡/对话框共用的视频探测缓存。
 *
 * 为什么要缓存并限并发：
 * - 一张卡可能有几十个链接，每个 probe 都是一个 yt-dlp 进程 + 一次 B站请求；
 *   全部同时起，容易被限流，也会把机器拖慢；
 * - 卡片重新挂载、点「确认导入」时都会再要同一份元信息，不缓存就会重复识别。
 *
 * TTL 只保证「同一拨操作」里复用；换了 cookies 时调用 clearImportProbeCache。
 */
const TTL_MS = 5 * 60_000;
const MAX_CONCURRENT = 2;

type Entry = { promise: Promise<ProbeResult>; at: number };

const entries = new Map<string, Entry>();
const waiters: (() => void)[] = [];
let active = 0;

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await run();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

/** 探测一个导入链接，同一 URL 复用同一个 Promise，全局最多两个在跑。 */
export function probeImport(url: string): Promise<ProbeResult> {
  const now = Date.now();
  const hit = entries.get(url);
  if (hit && now - hit.at < TTL_MS) return hit.promise;

  const promise = withSlot(() => ipc.tools.probeBilibili(url)).catch((error) => {
    // 失败不能留在缓存里：用户修正 cookies/网络后重试必须真的重新探测。
    entries.delete(url);
    throw error;
  });
  entries.set(url, { promise, at: now });
  return promise;
}

/** 换了 B站 cookies、或测试之间需要隔离时清空。 */
export function clearImportProbeCache() {
  entries.clear();
}
