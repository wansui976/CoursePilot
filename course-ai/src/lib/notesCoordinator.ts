import type { JSONContent } from "@tiptap/core";
import { ipc } from "@/lib/ipc";
import { markdownToTiptap } from "@/lib/markdownToTiptap";
import { NotesWriteQueue } from "@/lib/notesWriteQueue";

export type NotesSaveStatus = "unsaved" | "saving" | "saved" | "error";

export interface NotesSaveState {
  status: NotesSaveStatus;
  error: unknown | null;
}

export interface NotesEditorBridge {
  getDocument: () => JSONContent;
  replaceDocument: (document: JSONContent) => void;
}

export interface NotesAppendResult {
  contentJson: string;
}

interface NotesCoordinatorDependencies {
  readNotes: (videoId: string) => Promise<string | null>;
  writeNotes: (videoId: string, contentJson: string) => Promise<void>;
}

interface Draft {
  contentJson: string;
  revision: number;
}

const SAVED_STATE: NotesSaveState = { status: "saved", error: null };

function parseDocument(content: string | null | undefined): JSONContent {
  const source = content?.trim() ?? "";
  if (source) {
    try {
      const parsed = JSON.parse(source) as JSONContent;
      if (parsed?.type === "doc" && Array.isArray(parsed.content)) return parsed;
    } catch {
      // Markdown notes are converted below.
    }
  }
  return markdownToTiptap(source) as JSONContent;
}

function appendMarkdown(document: JSONContent, markdown: string): JSONContent {
  const addition = markdownToTiptap(markdown) as JSONContent;
  return {
    type: "doc",
    content: [...(document.content ?? []), ...(addition.content ?? [])],
  };
}

/**
 * Owns every full-document notes write. A mounted editor supplies the newest
 * in-memory document; without one, append operations serialize read/merge/write.
 */
export class NotesCoordinator {
  private readonly writer: NotesWriteQueue;
  private readonly readNotes: NotesCoordinatorDependencies["readNotes"];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drafts = new Map<string, Draft>();
  private readonly revisions = new Map<string, number>();
  private readonly states = new Map<string, NotesSaveState>();
  private readonly listeners = new Map<string, Set<(state: NotesSaveState) => void>>();
  private readonly editors = new Map<
    string,
    { token: symbol; bridge: NotesEditorBridge }
  >();
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor({ readNotes, writeNotes }: NotesCoordinatorDependencies) {
    this.readNotes = readNotes;
    this.writer = new NotesWriteQueue(writeNotes);
  }

  getState(videoId: string): NotesSaveState {
    return this.states.get(videoId) ?? SAVED_STATE;
  }

  subscribe(videoId: string, listener: (state: NotesSaveState) => void): () => void {
    let listeners = this.listeners.get(videoId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(videoId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(videoId);
    };
  }

  registerEditor(videoId: string, bridge: NotesEditorBridge): () => void {
    const token = Symbol(videoId);
    this.editors.set(videoId, { token, bridge });
    return () => {
      if (this.editors.get(videoId)?.token === token) this.editors.delete(videoId);
    };
  }

  getDraft(videoId: string): string | undefined {
    return this.drafts.get(videoId)?.contentJson;
  }

  scheduleSave(videoId: string, contentJson: string, delayMs = 800): void {
    const draft = this.stage(videoId, contentJson);
    const timer = setTimeout(() => {
      if (this.timers.get(videoId) !== timer) return;
      this.timers.delete(videoId);
      void this.persist(videoId, draft).catch(() => {});
    }, delayMs);
    this.timers.set(videoId, timer);
  }

  async flush(videoId: string): Promise<void> {
    this.clearTimer(videoId);
    const draft = this.drafts.get(videoId);
    if (draft) {
      await this.persist(videoId, draft);
      return;
    }
    try {
      await this.writer.flush(videoId);
    } catch (error) {
      this.setState(videoId, { status: "error", error });
      throw error;
    }
  }

  appendAnswer(videoId: string, markdown: string): Promise<NotesAppendResult> {
    return this.runAppendExclusive(videoId, async () => {
      let editor = this.editors.get(videoId)?.bridge;
      let document: JSONContent;

      if (editor) {
        document = editor.getDocument();
      } else {
        const draft = this.drafts.get(videoId);
        if (draft) {
          document = parseDocument(draft.contentJson);
        } else {
          await this.flush(videoId);
          const existing = await this.readNotes(videoId);
          // Mounting or an autosave may have happened while the IPC read was in flight.
          editor = this.editors.get(videoId)?.bridge;
          const latestDraft = this.drafts.get(videoId);
          document = editor
            ? editor.getDocument()
            : latestDraft
              ? parseDocument(latestDraft.contentJson)
              : parseDocument(existing);
        }
      }

      const merged = appendMarkdown(document, markdown);
      editor?.replaceDocument(merged);
      const contentJson = JSON.stringify(merged);
      const mergedDraft = this.stage(videoId, contentJson);
      await this.persist(videoId, mergedDraft);
      return { contentJson };
    });
  }

  private stage(videoId: string, contentJson: string): Draft {
    this.clearTimer(videoId);
    const revision = (this.revisions.get(videoId) ?? 0) + 1;
    this.revisions.set(videoId, revision);
    const draft = { contentJson, revision };
    this.drafts.set(videoId, draft);
    this.setState(videoId, { status: "unsaved", error: null });
    return draft;
  }

  private async persist(videoId: string, requested: Draft): Promise<void> {
    const current = this.drafts.get(videoId);
    const draft = current && current.revision >= requested.revision ? current : requested;
    this.setState(videoId, { status: "saving", error: null });
    try {
      await this.writer.enqueue(videoId, draft.contentJson);
      if (
        this.drafts.get(videoId)?.revision === draft.revision &&
        !this.timers.has(videoId)
      ) {
        this.drafts.delete(videoId);
        this.setState(videoId, SAVED_STATE);
      }
    } catch (error) {
      if (this.drafts.get(videoId)?.revision === draft.revision) {
        this.setState(videoId, { status: "error", error });
      }
      throw error;
    }
  }

  private clearTimer(videoId: string): void {
    const timer = this.timers.get(videoId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(videoId);
  }

  private setState(videoId: string, state: NotesSaveState): void {
    const previous = this.getState(videoId);
    if (previous.status === state.status && previous.error === state.error) return;
    this.states.set(videoId, state);
    this.listeners.get(videoId)?.forEach((listener) => listener(state));
  }

  private runAppendExclusive<T>(videoId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.appendTails.get(videoId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.appendTails.set(videoId, tail);
    void tail.then(() => {
      if (this.appendTails.get(videoId) === tail) this.appendTails.delete(videoId);
    });
    return result;
  }
}

export const notesCoordinator = new NotesCoordinator({
  readNotes: (videoId) => ipc.ai.getNotes(videoId),
  writeNotes: (videoId, contentJson) => ipc.ai.saveNotes(videoId, contentJson),
});
