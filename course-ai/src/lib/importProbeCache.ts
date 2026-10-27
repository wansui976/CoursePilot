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
/** 登录态在一拨批量导入里只查一次：每集都查就是每集多一次 nav 请求。 */
const LOGIN_TTL_MS = 60_000;

type Waiter = { resolve: () => void; reject: (error: unknown) => void };

type Entry = {
  promise: Promise<ProbeResult>;
  at: number;
  /** 已经拿到并发名额、yt-dlp 真的跑起来了。 */
  started: boolean;
  onStart: Set<() => void>;
  /** 还在等这个结果的调用方数；可取消的都撤了、又还在排队，就不必再跑。 */
  holders: number;
  /** 还在排队时，把它从队列里撤掉。 */
  cancelQueued?: () => void;
};

const entries = new Map<string, Entry>();
const waiters: Waiter[] = [];
let active = 0;
let loginState: { at: number; promise: Promise<boolean | null> } | null = null;

function releaseSlot() {
  // 有人在排队就把名额直接交给队首（active 不变）；不先归还再抢，否则同一时刻新来的
  // 请求会插队拿走空位，被唤醒的那个照样开跑，就超过上限了。
  const next = waiters.shift();
  if (next) next.resolve();
  else active -= 1;
}

function createEntry(url: string): Entry {
  const entry: Entry = {
    promise: Promise.resolve(null as unknown as ProbeResult),
    at: Date.now(),
    started: false,
    onStart: new Set(),
    holders: 0,
  };
  const run = () => {
    entry.cancelQueued = undefined;
    entry.started = true;
    for (const notify of entry.onStart) notify();
    entry.onStart.clear();
    return ipc.tools.probeBilibili(url).finally(releaseSlot);
  };
  let promise: Promise<ProbeResult>;
  if (active < MAX_CONCURRENT) {
    // 有空位就同步开跑
    active += 1;
    promise = run();
  } else {
    promise = new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiters.push(waiter);
      entry.cancelQueued = () => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        reject(new DOMException("probe canceled before it started", "AbortError"));
      };
    }).then(run);
  }
  entry.promise = promise.catch((error: unknown) => {
    // 失败（含排队时被撤掉）不能留在缓存里：用户修正 cookies/网络后重试必须真的重新探测。
    if (entries.get(url) === entry) entries.delete(url);
    throw error;
  });
  entries.set(url, entry);
  return entry;
}

/**
 * 探测一个导入链接，同一 URL 复用同一个 Promise，全局最多两个在跑。
 *
 * - `onStart`：真正开始跑（拿到名额）时调用。等待上限要从这里开始算，而不是从排队起算——
 *   十几个链接排队时，排在后面的还没轮到就被判成「超时」。
 * - `signal`：调用方不再需要结果（卡片关了）。还在排队、且没有别人在等时直接撤掉；
 *   已经跑起来的 yt-dlp 撤不回来，让它跑完，结果照样进缓存。
 */
export function probeImport(
  url: string,
  options: { onStart?: () => void; signal?: AbortSignal } = {},
): Promise<ProbeResult> {
  const { onStart, signal } = options;
  let entry = entries.get(url);
  if (!entry || Date.now() - entry.at >= TTL_MS) entry = createEntry(url);
  const current = entry;
  current.holders += 1;
  if (onStart) {
    if (current.started) onStart();
    else current.onStart.add(onStart);
  }
  if (signal) {
    const abandon = () => {
      current.holders -= 1;
      if (onStart) current.onStart.delete(onStart);
      if (current.holders <= 0 && !current.started) current.cancelQueued?.();
    };
    if (signal.aborted) abandon();
    else signal.addEventListener("abort", abandon, { once: true });
  }
  return current.promise;
}

/** B站登录态（true 已登录 / false 已失效 / null 查不出），一分钟内复用同一次结果。 */
export function bilibiliLoginStateOnce(): Promise<boolean | null> {
  const now = Date.now();
  if (loginState && now - loginState.at < LOGIN_TTL_MS) return loginState.promise;
  const promise = ipc.tools.bilibiliLoginState().catch(() => null);
  loginState = { at: now, promise };
  return promise;
}

/** 换了 B站 cookies 时清空。正在跑、排着队的探测不动（名额照常归还）。 */
export function clearImportProbeCache() {
  entries.clear();
  loginState = null;
}

/** 测试之间完全隔离：连并发名额和排队一起清掉。 */
export function resetImportProbeCacheForTests() {
  clearImportProbeCache();
  waiters.splice(0).forEach((waiter) => waiter.reject(new Error("reset")));
  active = 0;
}
