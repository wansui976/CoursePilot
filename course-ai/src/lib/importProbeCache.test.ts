import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearImportProbeCache, probeImport } from "./importProbeCache";
import type { ProbeResult } from "./types";

const { probeBilibili } = vi.hoisted(() => ({ probeBilibili: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { tools: { probeBilibili } } }));

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
    clearImportProbeCache();
    probeBilibili.mockReset();
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
});
