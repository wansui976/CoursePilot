import { describe, expect, it, vi } from "vitest";
import { NotesWriteQueue } from "./notesWriteQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("NotesWriteQueue", () => {
  it("serializes writes and persists the newest queued document last", async () => {
    const first = deferred();
    const write = vi
      .fn<(videoId: string, contentJson: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const queue = new NotesWriteQueue(write);

    const saving = queue.enqueue("v1", "old");
    queue.enqueue("v1", "new");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    first.resolve();
    await saving;

    expect(write).toHaveBeenNthCalledWith(1, "v1", "old");
    expect(write).toHaveBeenNthCalledWith(2, "v1", "new");
    expect(queue.hasPending("v1")).toBe(false);
  });

  it("retains a failed document and retries it explicitly", async () => {
    const write = vi
      .fn<(videoId: string, contentJson: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValueOnce(undefined);
    const queue = new NotesWriteQueue(write);

    await expect(queue.enqueue("v1", "draft")).rejects.toThrow("db locked");
    expect(queue.hasPending("v1")).toBe(true);
    await queue.flush("v1");

    expect(write).toHaveBeenNthCalledWith(2, "v1", "draft");
    expect(queue.hasPending("v1")).toBe(false);
  });

  it("skips a failed stale document when a newer edit is already queued", async () => {
    const first = deferred();
    const write = vi
      .fn<(videoId: string, contentJson: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const queue = new NotesWriteQueue(write);

    const saving = queue.enqueue("v1", "old");
    queue.enqueue("v1", "new");
    first.reject(new Error("old failed"));
    await saving;

    expect(write).toHaveBeenNthCalledWith(2, "v1", "new");
    expect(queue.hasPending("v1")).toBe(false);
  });
});
