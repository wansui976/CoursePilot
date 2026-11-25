/**
 * 界面层要长期留存的数据（目前是助手的对话记录）的存放处：库里的 client_store 表。
 *
 * 此前它们在 localStorage：WKWebView 约 5MB 的配额，几段长对话就能占满，满了以后
 * 别的数据（播放进度等）也写不进去；而且不在备份里。
 *
 * 对外是和 localStorage 一样的同步接口（getItem / setItem / removeItem），调用方几乎不用改：
 * - 启动时 `loadDurableStore()` 把库里这些键一次读进内存；之后读都走内存。
 * - 写先改内存，再合并成一批、稍等片刻写进库（流式回答时对话每秒要存好几次，
 *   不能每次都落一次盘）。
 * - 库没读成（老内核、IPC 出错、超时，以及单元测试里根本不加载）时，整个接口退回
 *   localStorage——和以前完全一样。绝不在没读到库的情况下往库里写，否则会拿空状态
 *   把库里已有的对话覆盖掉。
 *
 * 第一次读库时，若库里还没有、localStorage 里有，就搬过去；确认写进库以后再从
 * localStorage 删掉。
 */
import { ipc } from "./ipc";

/** 交给库保管的键前缀。别的键仍在 localStorage。 */
export const DURABLE_PREFIXES = [
  "course-ai-assistant-conversations:",
  "course-ai-assistant-conversation:",
  "course-ai-assistant-recent-questions:",
  "course-ai-assistant-session:",
] as const;

/** 写库的合并窗口。 */
const FLUSH_DELAY_MS = 400;

type Mode = "local" | "db";

let mode: Mode = "local";
const cache = new Map<string, string>();
const pending = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

export function isDurableKey(key: string): boolean {
  return DURABLE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function localKeys(): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && isDurableKey(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 同一个键本地和库里各有一份时合成一份（`local` 较新）：
 * - 会话列表（带 `conversations` 数组的对象）：按 id 并起来，同一个会话取更新得晚的那条；
 * - 数组（输入历史）：本地的在前，去重后接上库里的；
 * - 其余（单个会话的内容等）：取本地。
 */
export function mergeDurableValues(local: string, stored: string): string {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(local);
    b = JSON.parse(stored);
  } catch {
    return local;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return JSON.stringify(merged);
  }
  if (isRecord(a) && isRecord(b) && Array.isArray(a.conversations) && Array.isArray(b.conversations)) {
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of [...b.conversations, ...a.conversations]) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      const existing = byId.get(item.id);
      const updated = (value: Record<string, unknown> | undefined) =>
        typeof value?.updatedAt === "number" ? value.updatedAt : -Infinity;
      if (!existing || updated(item) >= updated(existing)) byId.set(item.id, item);
    }
    const conversations = [...byId.values()].sort(
      (x, y) => (Number(y.updatedAt) || 0) - (Number(x.updatedAt) || 0),
    );
    const activeId = [a.activeId, b.activeId].find(
      (id) => typeof id === "string" && byId.has(id),
    );
    return JSON.stringify({ ...b, ...a, conversations, activeId: activeId ?? null });
  }
  return local;
}

/**
 * 读库进内存。成功后切到库模式；失败或超过 `timeoutMs` 仍没回来，就留在 localStorage 模式
 * （超时后才回来的结果也不再采用：界面此时已经按 localStorage 读过一遍了）。
 */
export async function loadDurableStore(timeoutMs = 3000): Promise<boolean> {
  let abandoned = false;
  const attempt = (async () => {
    const rows = (await ipc.clientStore.load([...DURABLE_PREFIXES])) ?? [];
    if (abandoned) return false;
    const fromDb = new Map(rows);

    // 搬家：本地有的键都搬进库。库里也有同一个键时，本地那份只可能来自「上次没读到库、
    // 退回 localStorage」的那次运行（库模式下本地这些键都会被清掉），比库里的新——
    // 以前直接丢掉本地这份，那次运行里聊的对话就没了。会话列表和输入历史两边合并，别的取本地。
    const moving: [string, string][] = [];
    for (const key of localKeys()) {
      const value = localStorage.getItem(key);
      if (value == null) continue;
      const stored = fromDb.get(key);
      const next = stored == null ? value : mergeDurableValues(value, stored);
      if (next !== stored) moving.push([key, next]);
    }
    if (moving.length > 0) {
      await ipc.clientStore.put(moving);
      if (abandoned) return false;
      for (const [key, value] of moving) fromDb.set(key, value);
    }

    cache.clear();
    for (const [key, value] of fromDb) cache.set(key, value);
    mode = "db";
    // 库里已有一份：本地这些键只会误导以后的搬家判断，清掉。
    try {
      for (const key of localKeys()) localStorage.removeItem(key);
    } catch {
      // 清不掉也无妨：库模式下不再读它们。
    }
    return true;
  })().catch(() => false);

  const timeout = new Promise<boolean>((resolve) =>
    setTimeout(() => {
      abandoned = true;
      resolve(false);
    }, timeoutMs),
  );
  return Promise.race([attempt, timeout]);
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDurableStore();
  }, FLUSH_DELAY_MS);
}

/** 立刻把积攒的写入落进库（离开页面前、测试里用）。写失败的条目放回队列，下次再写。 */
export async function flushDurableStore(): Promise<void> {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing) await flushing;
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  flushing = ipc.clientStore
    .put(batch)
    .catch(() => {
      // 放回去，但别盖掉这期间更新的值。
      for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value);
      scheduleFlush();
    })
    .finally(() => {
      flushing = null;
    });
  await flushing;
}

export const durableStorage = {
  getItem(key: string): string | null {
    if (mode === "db" && isDurableKey(key)) return cache.get(key) ?? null;
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    if (mode === "db" && isDurableKey(key)) {
      cache.set(key, value);
      pending.set(key, value);
      scheduleFlush();
      return;
    }
    localStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    if (mode === "db" && isDurableKey(key)) {
      cache.delete(key);
      pending.set(key, null);
      scheduleFlush();
      return;
    }
    localStorage.removeItem(key);
  },
};

/** 测试用：回到初始的 localStorage 模式并清空内存。 */
export function resetDurableStoreForTests() {
  mode = "local";
  cache.clear();
  pending.clear();
  if (flushTimer != null) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = null;
}
