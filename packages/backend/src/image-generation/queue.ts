export interface ImageGenerationQueueSnapshot {
  running: string[];
  pending: string[];
  running_count: number;
  pending_count: number;
}

export type ImageGenerationQueueRunner = (jobId: string, signal: AbortSignal) => Promise<void>;

export class ImageGenerationQueue {
  private runningJobId: string | null = null;
  private readonly pending: string[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private draining = false;

  constructor(private readonly runner: ImageGenerationQueueRunner) {}

  enqueue(jobId: string): void {
    if (this.runningJobId === jobId || this.pending.includes(jobId)) return;
    this.pending.push(jobId);
    void this.drain();
  }

  cancel(jobId: string): boolean {
    const pendingIndex = this.pending.indexOf(jobId);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      return true;
    }

    const controller = this.abortControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(jobId: string): boolean {
    return this.runningJobId === jobId && this.abortControllers.has(jobId);
  }

  snapshot(): ImageGenerationQueueSnapshot {
    return {
      running: this.runningJobId ? [this.runningJobId] : [],
      pending: [...this.pending],
      running_count: this.runningJobId ? 1 : 0,
      pending_count: this.pending.length,
    };
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (!this.runningJobId && this.pending.length > 0) {
        const jobId = this.pending.shift();
        if (!jobId) continue;

        const abortController = new AbortController();
        this.runningJobId = jobId;
        this.abortControllers.set(jobId, abortController);
        try {
          await this.runner(jobId, abortController.signal);
        } catch {
          // The service runner owns job status transitions. The queue keeps draining.
        } finally {
          this.abortControllers.delete(jobId);
          this.runningJobId = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.runningJobId && this.pending.length > 0) {
        void this.drain();
      }
    }
  }
}
