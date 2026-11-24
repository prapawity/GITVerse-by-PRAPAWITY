export interface SchedulerClockDependencies {
  poll(canRunOnTime: boolean): Promise<void>;
  onError(error: unknown): void;
  setInterval(callback: () => void, ms: number): () => void;
}

/**
 * Serializes polls and gives startup/resume priority over ordinary timer ticks.
 * A failed poll stops the clock until it is explicitly restarted.
 */
export class SchedulerClock {
  private active = false;
  private suspended = false;
  private pending: boolean | null = null;
  private polling: Promise<void> | null = null;
  private stopTimer: (() => void) | null = null;
  private lastTick = 0;

  constructor(private readonly deps: SchedulerClockDependencies) {}

  async start(): Promise<void> {
    if (this.active || this.polling) throw new Error('The scheduler clock is already running or stopping.');
    this.active = true;
    this.suspended = false;
    this.lastTick = Date.now();
    this.stopTimer = this.deps.setInterval(() => {
      const now = Date.now();
      const onTime = now >= this.lastTick && now - this.lastTick <= 5_000;
      this.lastTick = now;
      void this.request(onTime).catch(() => {
        // The error is reported by drain.
      });
    }, 1_000);
    await this.request(false);
  }

  suspend(): void {
    this.suspended = true;
    this.pending = null;
  }

  resume(): void {
    if (!this.active) return;
    this.suspended = false;
    this.lastTick = Date.now();
    void this.request(false).catch(() => {
      // The error is reported by drain.
    });
  }

  stop(): void {
    this.active = false;
    this.pending = null;
    this.stopTimer?.();
    this.stopTimer = null;
  }

  private request(canRunOnTime: boolean): Promise<void> {
    if (!this.active || this.suspended) return Promise.resolve();
    this.pending = this.pending === false ? false : canRunOnTime;
    if (this.polling) return this.polling;
    this.polling = this.drain().finally(() => {
      this.polling = null;
      if (this.active && !this.suspended && this.pending !== null) {
        void this.request(this.pending).catch(() => {
          // The error is reported by drain.
        });
      }
    });
    return this.polling;
  }

  private async drain(): Promise<void> {
    while (this.active && !this.suspended && this.pending !== null) {
      const canRunOnTime = this.pending;
      this.pending = null;
      try {
        await this.deps.poll(canRunOnTime);
      } catch (error) {
        this.stop();
        this.deps.onError(error);
        throw error;
      }
    }
  }
}
