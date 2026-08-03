/**
 * 观看时长累加器（纯逻辑，便于单测）。按「播放中」状态累计墙上时钟时间——
 * 这样暂停不计、倍速不影响「学习时长」（学习时长是你花的时间，不是内容时长）。
 * now 可注入以便测试。
 */
export class WatchAccumulator {
  private accumMs = 0;
  private startedAt: number | null = null;

  /**
   * @param now 可注入的时钟，便于测试。
   * @param maxSegmentMs 单段最多计多少。见 settle()。
   */
  constructor(
    private now: () => number = Date.now,
    private maxSegmentMs = Number.POSITIVE_INFINITY,
  ) {}

  /** 切换播放状态：进入播放开始计时，暂停则把这段计入累计。 */
  setPlaying(playing: boolean): void {
    this.settle();
    if (playing) this.startedAt = this.now();
  }

  /**
   * 结算当前这一段。
   *
   * 单段要封顶。这里用的是墙上时钟，而系统睡眠期间我们的代码一行都不跑：合上笔记本
   * 一夜，醒来后第一次结算算出来的是「现在 − 开始播放」，整晚都被记成学习时长。
   * 就算播放器在睡眠时发了暂停事件也救不回来——那个事件同样要等到醒来才被处理，
   * 时间戳还是醒来的时刻。
   *
   * 判据是：我们本来就会定期结算，所以一段远超结算周期，只可能是我们整段没在跑。
   * 上限取得比「后台节流」宽松得多（那种情况最长约一分钟一次，是真实的观看时间），
   * 只把小时级的空档挡在外面。
   */
  private settle(): void {
    if (this.startedAt != null) {
      this.accumMs += Math.min(this.now() - this.startedAt, this.maxSegmentMs);
      this.startedAt = null;
    }
  }

  /** 取出并清零累计毫秒；若仍在播放则继续计时（不打断当前会话）。 */
  drain(): number {
    const wasPlaying = this.startedAt != null;
    this.settle();
    const ms = this.accumMs;
    this.accumMs = 0;
    if (wasPlaying) this.startedAt = this.now();
    return ms;
  }
}

export type WriteWatchLog = (videoId: string, watchedMs: number) => Promise<void>;

/**
 * Coalesces unsaved watch time per video. A failed write is restored to the
 * same video's bucket so a later flush can retry it without misattribution.
 */
export class WatchLogQueue {
  private pending = new Map<string, number>();
  private active = new Map<string, Promise<void>>();

  constructor(private write: WriteWatchLog) {}

  enqueue(videoId: string, watchedMs: number): Promise<void> {
    if (watchedMs > 0) {
      this.pending.set(videoId, (this.pending.get(videoId) ?? 0) + watchedMs);
    }
    return this.flush(videoId);
  }

  async retryAll(): Promise<void> {
    await Promise.allSettled([...this.pending.keys()].map((videoId) => this.flush(videoId)));
  }

  pendingMs(videoId: string): number {
    return this.pending.get(videoId) ?? 0;
  }

  private flush(videoId: string): Promise<void> {
    const existing = this.active.get(videoId);
    if (existing) return existing;

    const task = (async () => {
      while ((this.pending.get(videoId) ?? 0) > 0) {
        const watchedMs = this.pending.get(videoId)!;
        this.pending.delete(videoId);
        try {
          await this.write(videoId, watchedMs);
        } catch (error) {
          this.pending.set(videoId, watchedMs + (this.pending.get(videoId) ?? 0));
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
}
