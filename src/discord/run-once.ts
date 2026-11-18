/**
 * Runs at most one task per key at a time. Used so a meeting is never processed by two runs at
 * once (auto-stop and /retry racing). A task's error is logged, never rethrown.
 */
export class RunOnce {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly log: (key: string, err: unknown) => void = (key, err) =>
      console.error(`Task for ${key} failed:`, err),
  ) {}

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** Starts the task unless one is already running for this key; returns whether it started. */
  run(key: string, task: () => Promise<void>): boolean {
    if (this.running.has(key)) return false;
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
      .finally(() => this.running.delete(key));
    this.running.set(key, done);
    return true;
  }

  /** Resolves when the key's current run (if any) has finished. Never rejects. */
  settled(key: string): Promise<void> {
    return this.running.get(key) ?? Promise.resolve();
  }
}
