/**
 * 观看时长累加器（纯逻辑，便于单测）。按「播放中」状态累计墙上时钟时间——
 * 这样暂停不计、倍速不影响「学习时长」（学习时长是你花的时间，不是内容时长）。
 * now 可注入以便测试。
 */
export class WatchAccumulator {
  private accumMs = 0;
  private startedAt: number | null = null;

  constructor(private now: () => number = Date.now) {}

  /** 切换播放状态：进入播放开始计时，暂停则把这段计入累计。 */
  setPlaying(playing: boolean): void {
    this.settle();
    if (playing) this.startedAt = this.now();
  }

  private settle(): void {
    if (this.startedAt != null) {
      this.accumMs += this.now() - this.startedAt;
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
