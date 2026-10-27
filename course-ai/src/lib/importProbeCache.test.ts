import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bilibiliLoginStateOnce,
  clearImportProbeCache,
  probeImport,
  resetImportProbeCacheForTests,
} from "./importProbeCache";
import type { ProbeResult } from "./types";

const { probeBilibili, bilibiliLoginState } = vi.hoisted(() => ({
  probeBilibili: vi.fn(),
  bilibiliLoginState: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: { probeBilibili, bilibiliLoginState } } }));

function probe(title: string): ProbeResult {
  return { title, tracks: [], qualities: [1080] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("importProbeCache", () => {
  beforeEach(() => {
    resetImportProbeCacheForTests();
    probeBilibili.mockReset();
    bilibiliLoginState.mockReset();
  });

  it("shares one probe for concurrent requests of the same url", async () => {
    probeBilibili.mockResolvedValue(probe("同一节课"));
    const [a, b] = await Promise.all([probeImport("u"), probeImport("u")]);
    expect(a.title).toBe("同一节课");
    expect(b.title).toBe("同一节课");
    expect(probeBilibili).toHaveBeenCalledTimes(1);
  });

  it("runs at most two probes at a time", async () => {
    const first = deferred<ProbeResult>();
    const second = deferred<ProbeResult>();
    const third = deferred<ProbeResult>();
    probeBilibili
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const one = probeImport("a");
    const two = probeImport("b");
    const three = probeImport("c");
    expect(probeBilibili).toHaveBeenCalledTimes(2);

    first.resolve(probe("a"));
    await one;
    await Promise.resolve();
    expect(probeBilibili).toHaveBeenCalledTimes(3);

    second.resolve(probe("b"));
    third.resolve(probe("c"));
    await Promise.all([two, three]);
  });

  it("does not cache failures, so a retry really retries", async () => {
    probeBilibili.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(probe("好了"));
    await expect(probeImport("u")).rejects.toThrow("network");
    await expect(probeImport("u")).resolves.toMatchObject({ title: "好了" });
    expect(probeBilibili).toHaveBeenCalledTimes(2);
  });

  it("hands a freed slot straight to the queue, so a late caller cannot push past two", async () => {
    const runs = [deferred<ProbeResult>(), deferred<ProbeResult>(), deferred<ProbeResult>(), deferred<ProbeResult>()];
    let running = 0;
    let peak = 0;
    probeBilibili.mockImplementation(() => {
      const next = runs[probeBilibili.mock.calls.length - 1];
      running += 1;
      peak = Math.max(peak, running);
      return next.promise.finally(() => {
        running -= 1;
      });
    });
    const one = probeImport("a");
    probeImport("b");
    const three = probeImport("c"); // 排队
    await Promise.resolve();
    // 第一个跑完的同一拍里又来一个新请求：不能插队拿走刚空出的名额
    runs[0].resolve(probe("a"));
    await one;
    probeImport("d");
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    runs[1].resolve(probe("b"));
    runs[2].resolve(probe("c"));
    runs[3].resolve(probe("d"));
    await three;
  });

  it("calls onStart only when the probe actually starts, not while it waits in line", async () => {
    const first = deferred<ProbeResult>();
    const second = deferred<ProbeResult>();
    probeBilibili.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(probe("c"));
    const started: string[] = [];
    probeImport("a", { onStart: () => started.push("a") });
    probeImport("b", { onStart: () => started.push("b") });
    const third = probeImport("c", { onStart: () => started.push("c") });
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    first.resolve(probe("a"));
    await third.catch(() => undefined);
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    second.resolve(probe("b"));
  });

  it("drops a queued probe nobody waits for any more, and frees nothing that was not taken", async () => {
    const first = deferred<ProbeResult>();
    const second = deferred<ProbeResult>();
    probeBilibili.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(probe("later"));
    probeImport("a");
    probeImport("b");
    const controller = new AbortController();
    const queued = probeImport("c", { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    first.resolve(probe("a"));
    second.resolve(probe("b"));
    await Promise.resolve();
    // 被撤掉的 c 从没跑过；之后再要 c 会真的重新探测
    expect(probeBilibili).toHaveBeenCalledTimes(2);
    await expect(probeImport("c")).resolves.toMatchObject({ title: "later" });
  });

  it("keeps a queued probe that another caller still waits for", async () => {
    const first = deferred<ProbeResult>();
    const second = deferred<ProbeResult>();
    probeBilibili.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(probe("c"));
    probeImport("a");
    probeImport("b");
    const controller = new AbortController();
    probeImport("c", { signal: controller.signal }).catch(() => undefined);
    const stillWanted = probeImport("c");
    controller.abort();
    first.resolve(probe("a"));
    await expect(stillWanted).resolves.toMatchObject({ title: "c" });
    second.resolve(probe("b"));
  });

  it("asks for the login state once per batch", async () => {
    bilibiliLoginState.mockResolvedValue(false);
    const states = await Promise.all([bilibiliLoginStateOnce(), bilibiliLoginStateOnce(), bilibiliLoginStateOnce()]);
    expect(states).toEqual([false, false, false]);
    expect(bilibiliLoginState).toHaveBeenCalledTimes(1);
    clearImportProbeCache();
    bilibiliLoginState.mockResolvedValue(true);
    await expect(bilibiliLoginStateOnce()).resolves.toBe(true);
    expect(bilibiliLoginState).toHaveBeenCalledTimes(2);
  });
});
