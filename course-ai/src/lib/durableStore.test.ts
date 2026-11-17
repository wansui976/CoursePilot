import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  durableStorage,
  flushDurableStore,
  loadDurableStore,
  resetDurableStoreForTests,
} from "./durableStore";

vi.mock("./ipc", () => ({
  ipc: { clientStore: { load: vi.fn(), put: vi.fn() } },
}));

import { ipc } from "./ipc";

const KEY = "course-ai-assistant-conversation:v1:conversation-a";
const INDEX = "course-ai-assistant-conversations:v1";

describe("助手对话记录存进库", () => {
  const load = vi.mocked(ipc.clientStore.load);
  const put = vi.mocked(ipc.clientStore.put);

  beforeEach(() => {
    localStorage.clear();
    resetDurableStoreForTests();
    load.mockReset();
    put.mockReset();
    put.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("没加载库时和 localStorage 完全一样（单元测试、老内核、读库失败）", () => {
    durableStorage.setItem(KEY, "x");
    expect(localStorage.getItem(KEY)).toBe("x");
    expect(durableStorage.getItem(KEY)).toBe("x");
    expect(put).not.toHaveBeenCalled();
  });

  it("加载后读写走库；写入合并成一批再落库", async () => {
    load.mockResolvedValue([[KEY, "from-db"]]);
    await expect(loadDurableStore()).resolves.toBe(true);
    expect(durableStorage.getItem(KEY)).toBe("from-db");

    durableStorage.setItem(KEY, "v1");
    durableStorage.setItem(KEY, "v2");
    durableStorage.removeItem(INDEX);
    expect(durableStorage.getItem(KEY)).toBe("v2");
    expect(localStorage.getItem(KEY)).toBeNull();

    await flushDurableStore();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith([
      [KEY, "v2"],
      [INDEX, null],
    ]);
  });

  it("不归库管的键仍在 localStorage", async () => {
    load.mockResolvedValue([]);
    await loadDurableStore();
    durableStorage.setItem("course-ai-theme", "dark");
    expect(localStorage.getItem("course-ai-theme")).toBe("dark");
  });

  it("第一次加载把 localStorage 里的对话搬进库，写成功后才删本地", async () => {
    localStorage.setItem(KEY, "old");
    localStorage.setItem(INDEX, "idx");
    load.mockResolvedValue([[INDEX, "idx-db"]]);
    await loadDurableStore();
    // 库里已有的不被本地旧值覆盖；库里没有的搬过去。
    expect(put).toHaveBeenCalledWith([[KEY, "old"]]);
    expect(durableStorage.getItem(KEY)).toBe("old");
    expect(durableStorage.getItem(INDEX)).toBe("idx-db");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(INDEX)).toBeNull();
  });

  it("搬家写库失败：留在 localStorage 模式，本地数据原样保留", async () => {
    localStorage.setItem(KEY, "old");
    load.mockResolvedValue([]);
    put.mockRejectedValueOnce(new Error("disk full"));
    await expect(loadDurableStore()).resolves.toBe(false);
    expect(localStorage.getItem(KEY)).toBe("old");
    durableStorage.setItem(KEY, "new");
    expect(localStorage.getItem(KEY)).toBe("new");
  });

  it("读库超时：留在 localStorage 模式，迟到的结果也不再采用", async () => {
    vi.useFakeTimers();
    let resolveLoad!: (rows: [string, string][]) => void;
    load.mockReturnValue(new Promise((resolve) => (resolveLoad = resolve)));
    const result = loadDurableStore(100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(result).resolves.toBe(false);
    resolveLoad([[KEY, "late"]]);
    await vi.advanceTimersByTimeAsync(0);
    localStorage.setItem(KEY, "local");
    expect(durableStorage.getItem(KEY)).toBe("local");
  });

  it("落库失败的写入放回队列，下次再写；期间更新的值不被旧值盖掉", async () => {
    load.mockResolvedValue([]);
    await loadDurableStore();
    put.mockRejectedValueOnce(new Error("busy"));
    durableStorage.setItem(KEY, "a");
    await flushDurableStore();
    durableStorage.setItem(KEY, "b");
    await flushDurableStore();
    expect(put).toHaveBeenLastCalledWith([[KEY, "b"]]);
  });
});
