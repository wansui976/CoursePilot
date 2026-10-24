import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheck } from "@/lib/ipc/types";

const { checkUpdate } = vi.hoisted(() => ({ checkUpdate: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { app: { checkUpdate } } }));

import {
  AUTO_CHECK_INTERVAL_MS,
  autoCheckForUpdate,
  pendingUpdate,
  resetAutoCheckForTests,
  useUpdate,
  writeAutoCheck,
} from "./updateCheck";

const NOW = 1_800_000_000_000;

function release(current: string, latest: string): UpdateCheck {
  return {
    current,
    latest,
    newer: latest !== current,
    url: `https://github.com/wansui976/CoursePilot/releases/tag/v${latest}`,
  };
}

describe("新版本提示", () => {
  beforeEach(() => {
    localStorage.clear();
    checkUpdate.mockReset();
    useUpdate.setState({ result: null, ignored: null });
    resetAutoCheckForTests();
  });

  it("只提示比正在运行的版本新、而且没说过不再提示的版本", () => {
    const update = release("0.3.4", "0.3.5");
    expect(pendingUpdate(update, null, "0.3.4")).toBe(update);
    expect(pendingUpdate(update, "0.3.5", "0.3.4")).toBeNull();
    // 0.3.6 出来了还要提示：不再提示的只是 0.3.5。
    expect(pendingUpdate(release("0.3.4", "0.3.6"), "0.3.5", "0.3.4")).not.toBeNull();
    expect(pendingUpdate(release("0.3.4", "0.3.4"), null, "0.3.4")).toBeNull();
    // 升级到 0.3.5 之后，上次「0.3.4 → 有 0.3.5」的结果不作数。
    expect(pendingUpdate(update, null, "0.3.5")).toBeNull();
    expect(pendingUpdate(update, null, null)).toBeNull();
  });

  it("自动检查一天最多一次，结果存下来供下次启动用", async () => {
    checkUpdate.mockResolvedValue(release("0.3.4", "0.3.5"));
    await autoCheckForUpdate("0.3.4", NOW);
    expect(checkUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdate.getState().result?.latest).toBe("0.3.5");

    // 下次启动、还没过一天：用存下的结果，不再去问。
    resetAutoCheckForTests();
    await autoCheckForUpdate("0.3.4", NOW + AUTO_CHECK_INTERVAL_MS - 1);
    expect(checkUpdate).toHaveBeenCalledTimes(1);

    // 过了一天再问。
    resetAutoCheckForTests();
    await autoCheckForUpdate("0.3.4", NOW + AUTO_CHECK_INTERVAL_MS + 1);
    expect(checkUpdate).toHaveBeenCalledTimes(2);
  });

  it("升级之后不等满一天就重新检查", async () => {
    checkUpdate.mockResolvedValue(release("0.3.4", "0.3.5"));
    await autoCheckForUpdate("0.3.4", NOW);
    checkUpdate.mockResolvedValue(release("0.3.5", "0.3.5"));
    resetAutoCheckForTests();
    await autoCheckForUpdate("0.3.5", NOW + 60_000);
    expect(checkUpdate).toHaveBeenCalledTimes(2);
    expect(useUpdate.getState().result?.newer).toBe(false);
  });

  it("关掉自动检查就不去问", async () => {
    writeAutoCheck(false);
    await autoCheckForUpdate("0.3.4", NOW);
    expect(checkUpdate).not.toHaveBeenCalled();
  });

  it("网络不通时安静地算了，不影响使用", async () => {
    checkUpdate.mockRejectedValue(new Error("check update: error sending request"));
    await expect(autoCheckForUpdate("0.3.4", NOW)).resolves.toBeUndefined();
    expect(useUpdate.getState().result).toBeNull();
  });

  it("同一次运行只检查一次", async () => {
    checkUpdate.mockResolvedValue(release("0.3.4", "0.3.5"));
    await Promise.all([autoCheckForUpdate("0.3.4", NOW), autoCheckForUpdate("0.3.4", NOW)]);
    expect(checkUpdate).toHaveBeenCalledTimes(1);
  });
});
