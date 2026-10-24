// 新版本提示：启动后问一次 GitHub 上的最新正式版，有更新就在课程库首页提一句。
// 偏好与上次的结果存 localStorage；默认开启，设置 →「关于」里可以关掉。
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { UpdateCheck } from "@/lib/ipc/types";

const AUTO_KEY = "course-ai-update-auto";
const IGNORED_KEY = "course-ai-update-ignored";
const LAST_KEY = "course-ai-update-last";
/** 自动检查一天一次就够：未登录的 GitHub 接口每小时也只给 60 次。 */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures.
  }
}

export function readAutoCheck(): boolean {
  return read(AUTO_KEY) !== "0";
}

export function writeAutoCheck(on: boolean): void {
  write(AUTO_KEY, on ? "1" : "0");
}

type LastCheck = { at: number; result: UpdateCheck };

function readLastCheck(): LastCheck | null {
  try {
    const parsed = JSON.parse(read(LAST_KEY) ?? "null") as LastCheck | null;
    return parsed && typeof parsed.at === "number" && parsed.result ? parsed : null;
  } catch {
    return null;
  }
}

interface UpdateState {
  /** 最近一次检查的结果；还没查过（或上次失败）是 null。 */
  result: UpdateCheck | null;
  /** 用户说过「不再提示」的版本。 */
  ignored: string | null;
  record: (result: UpdateCheck, at: number) => void;
  ignore: (version: string) => void;
}

export const useUpdate = create<UpdateState>((set) => ({
  result: readLastCheck()?.result ?? null,
  ignored: read(IGNORED_KEY),
  record: (result, at) => {
    write(LAST_KEY, JSON.stringify({ at, result } satisfies LastCheck));
    set({ result });
  },
  ignore: (version) => {
    write(IGNORED_KEY, version);
    set({ ignored: version });
  },
}));

/**
 * 首页该提示的新版本：比正在运行的版本新，而且不是用户说过不再提示的那个。
 * 结果得是在这个版本上查的——升级之后，上次存下的「有新版本」就不作数了。
 */
export function pendingUpdate(
  result: UpdateCheck | null,
  ignored: string | null,
  runningVersion: string | null,
): UpdateCheck | null {
  if (!result?.newer || result.current !== runningVersion) return null;
  return result.latest === ignored ? null : result;
}

/** 手动检查（设置里的按钮）：总是去问，失败抛给调用方显示。 */
export async function checkForUpdate(now = Date.now()): Promise<UpdateCheck> {
  const result = await ipc.app.checkUpdate();
  useUpdate.getState().record(result, now);
  return result;
}

let version: Promise<string> | null = null;

/** 正在运行的版本号（tauri.conf.json 里的 version），取不到时为 null。 */
export function useRunningVersion(): string | null {
  const [running, setRunning] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    try {
      version ??= getVersion();
    } catch {
      // 不在 Tauri 里（浏览器预览界面、测试替身）：没有版本号，也就不提示更新。
      return;
    }
    version.then(
      (value) => alive && setRunning(value),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return running;
}

let autoCheck: Promise<void> | null = null;

/**
 * 启动后的自动检查：关掉了就不查；一天内查过就用上次的结果（升级之后上次的结果作废，
 * 免得刚装好新版还提示「有新版本」）；网络不通安静地算了，不打扰用户。
 * 同一次运行只查一次。
 */
export function autoCheckForUpdate(currentVersion: string, now = Date.now()): Promise<void> {
  autoCheck ??= (async () => {
    if (!readAutoCheck()) return;
    const last = readLastCheck();
    if (
      last &&
      last.result.current === currentVersion &&
      now - last.at < AUTO_CHECK_INTERVAL_MS
    ) {
      return;
    }
    try {
      await checkForUpdate(now);
    } catch {
      // 离线、GitHub 访问不了：下次启动再试。
    }
  })();
  return autoCheck;
}

/** 仅测试用：让下一次 autoCheckForUpdate 重新执行、版本号重新读取。 */
export function resetAutoCheckForTests(): void {
  autoCheck = null;
  version = null;
}
