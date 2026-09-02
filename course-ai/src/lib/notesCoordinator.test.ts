import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { NotesCoordinator } from "./notesCoordinator";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function documentWith(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

function documentText(serialized: string): string {
  const document = JSON.parse(serialized) as JSONContent;
  return JSON.stringify(document).replace(/"/g, "");
}

describe("NotesCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges an assistant answer into the live editor draft before its debounce fires", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const coordinator = new NotesCoordinator({
      readNotes: vi.fn().mockResolvedValue(null),
      writeNotes: vi.fn(async (_videoId, contentJson) => {
        writes.push(contentJson);
      }),
    });
    let editorDocument = documentWith("人工段落");
    coordinator.registerEditor("video-1", {
      getDocument: () => editorDocument,
      replaceDocument: (document) => {
        editorDocument = document;
      },
    });
    coordinator.scheduleSave("video-1", JSON.stringify(editorDocument));

    await coordinator.appendAnswer("video-1", "助手回答");
    await vi.runAllTimersAsync();

    expect(writes).toHaveLength(1);
    expect(documentText(writes[0])).toContain("人工段落");
    expect(documentText(writes[0])).toContain("助手回答");
    expect(JSON.stringify(editorDocument)).toContain("人工段落");
    expect(JSON.stringify(editorDocument)).toContain("助手回答");
  });

  it("queues a merged answer behind an in-flight autosave so the newest document wins", async () => {
    vi.useFakeTimers();
    const first = deferred();
    const writes: string[] = [];
    const writeNotes = vi
      .fn<(videoId: string, contentJson: string) => Promise<void>>()
      .mockImplementationOnce(async (_videoId, contentJson) => {
        writes.push(contentJson);
        await first.promise;
      })
      .mockImplementationOnce(async (_videoId, contentJson) => {
        writes.push(contentJson);
      });
    const coordinator = new NotesCoordinator({
      readNotes: vi.fn().mockResolvedValue(null),
      writeNotes,
    });
    let editorDocument = documentWith("人工段落");
    coordinator.registerEditor("video-1", {
      getDocument: () => editorDocument,
      replaceDocument: (document) => {
        editorDocument = document;
      },
    });
    coordinator.scheduleSave("video-1", JSON.stringify(editorDocument), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeNotes).toHaveBeenCalledTimes(1);

    const append = coordinator.appendAnswer("video-1", "助手回答");
    await Promise.resolve();
    expect(writeNotes).toHaveBeenCalledTimes(1);
    first.resolve();
    await append;

    expect(writeNotes).toHaveBeenCalledTimes(2);
    expect(documentText(writes[0])).toContain("人工段落");
    expect(documentText(writes[0])).not.toContain("助手回答");
    expect(documentText(writes[1])).toContain("人工段落");
    expect(documentText(writes[1])).toContain("助手回答");
  });

  it("retains a merged draft after a failed write and retries without rereading stale notes", async () => {
    const readNotes = vi.fn().mockResolvedValue(JSON.stringify(documentWith("数据库旧稿")));
    const writeNotes = vi
      .fn<(videoId: string, contentJson: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("database locked"))
      .mockResolvedValueOnce(undefined);
    const coordinator = new NotesCoordinator({ readNotes, writeNotes });

    await expect(coordinator.appendAnswer("video-1", "助手回答")).rejects.toThrow(
      "database locked",
    );
    const retained = coordinator.getDraft("video-1");
    expect(retained).toBeDefined();
    expect(documentText(retained!)).toContain("数据库旧稿");
    expect(documentText(retained!)).toContain("助手回答");

    await coordinator.flush("video-1");

    expect(readNotes).toHaveBeenCalledTimes(1);
    expect(writeNotes).toHaveBeenCalledTimes(2);
    expect(coordinator.getDraft("video-1")).toBeUndefined();
  });
});
