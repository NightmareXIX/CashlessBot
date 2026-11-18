/**
 * Runs at most one task per key at a time. Used so a meeting is never processed by two runs at
 * once (auto-stop and /retry racing). A task's error is logged, never rethrown.
 */
export class RunOnce {
  private readonly runs = new Map<string, Promise<void>>();

  constructor(
    private readonly log: (key: string, err: unknown) => void = (key, err) =>
      console.error(`Task for ${key} failed:`, err),
  ) {}

  isRunning(key: string): boolean {
    return this.runs.has(key);
  }

  /** Keys with a run in progress. */
  running(): string[] {
    return [...this.runs.keys()];
  }

  /** Starts the task unless one is already running for this key; returns whether it started. */
  run(key: string, task: () => Promise<void>): boolean {
    if (this.runs.has(key)) return false;
    // Start the task on a later tick, so the key is registered before the task can settle,
    // even if it throws synchronously.
    const done = Promise.resolve()
      .then(task)
      .catch((err: unknown) => {
        try {
          this.log(key, err);
        } catch {
          // Logging must never turn into an unhandled rejection.
        }
      })
      .finally(() => this.runs.delete(key));
    this.runs.set(key, done);
    return true;
  }

  /** Resolves when the key's current run (if any) has finished. Never rejects. */
  whenDone(key: string): Promise<void> {
    return this.runs.get(key) ?? Promise.resolve();
  }

  /**
   * Resolves when every run in progress now has finished, or after timeoutMs, whichever comes
   * first. Never rejects; check running() afterwards for runs that are still going.
   */
  async settled(timeoutMs: number): Promise<void> {
    if (this.runs.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    try {
      await Promise.race([Promise.all(this.runs.values()), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
