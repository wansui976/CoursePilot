export type WriteNote = (videoId: string, contentJson: string) => Promise<void>;

/**
 * Serializes note writes per video and keeps only the newest queued document.
 * Failed content remains pending until another edit or an explicit retry.
 */
export class NotesWriteQueue {
  private pending = new Map<string, string>();
  private active = new Map<string, Promise<void>>();

  constructor(private write: WriteNote) {}

  enqueue(videoId: string, contentJson: string): Promise<void> {
    this.pending.set(videoId, contentJson);
    return this.flush(videoId);
  }

  flush(videoId: string): Promise<void> {
    const existing = this.active.get(videoId);
    if (existing) return existing;

    const task = (async () => {
      while (this.pending.has(videoId)) {
        const contentJson = this.pending.get(videoId)!;
        this.pending.delete(videoId);
        try {
          await this.write(videoId, contentJson);
        } catch (error) {
          // A newer edit supersedes the failed document and should still get a chance to save.
          if (this.pending.has(videoId)) continue;
          this.pending.set(videoId, contentJson);
          throw error;
        }
      }
    })();
    this.active.set(videoId, task);
    const cleanup = () => {
      if (this.active.get(videoId) === task) this.active.delete(videoId);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  hasPending(videoId: string): boolean {
    return this.pending.has(videoId) || this.active.has(videoId);
  }
}
