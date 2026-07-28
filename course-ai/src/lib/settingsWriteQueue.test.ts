import { describe, expect, it, vi } from "vitest";
import { createSettingsWriter } from "./settingsWriteQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createSettingsWriter", () => {
  it("preserves invocation order for rapid writes to the same key", async () => {
    const first = deferred();
    const write = vi
      .fn<(key: string, value: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const save = createSettingsWriter(write);

    const firstSave = save("asr_language", "en");
    const secondSave = save("asr_language", "zh");

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenNthCalledWith(1, "asr_language", "en");

    first.resolve();
    await firstSave;
    await secondSave;

    expect(write).toHaveBeenNthCalledWith(2, "asr_language", "zh");
  });

  it("continues with the newest write after an earlier write fails", async () => {
    const first = deferred();
    const write = vi
      .fn<(key: string, value: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const save = createSettingsWriter(write);

    const firstSave = save("subtitle_autocorrect", "true");
    const secondSave = save("subtitle_autocorrect", "false");
    first.reject(new Error("db locked"));

    await expect(firstSave).rejects.toThrow("db locked");
    await expect(secondSave).resolves.toBeUndefined();
    expect(write).toHaveBeenNthCalledWith(2, "subtitle_autocorrect", "false");
  });
});
