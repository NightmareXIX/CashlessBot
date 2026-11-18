import { describe, expect, it, vi } from 'vitest';
import { RunOnce } from '../../src/discord/run-once.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RunOnce', () => {
  it('runs a task and reports it as running until it settles', async () => {
    const runs = new RunOnce();
    const gate = deferred();
    expect(runs.run('m1', () => gate.promise)).toBe(true);
    expect(runs.isRunning('m1')).toBe(true);
    gate.resolve();
    await runs.whenDone('m1');
    expect(runs.isRunning('m1')).toBe(false);
  });

  it('does not start a second run for the same key while one is running', async () => {
    const runs = new RunOnce();
    const gate = deferred();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn(async () => {});
    expect(runs.run('m1', first)).toBe(true);
    expect(runs.run('m1', second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await runs.whenDone('m1');
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('runs different keys side by side', async () => {
    const runs = new RunOnce();
    const gate = deferred();
    expect(runs.run('m1', () => gate.promise)).toBe(true);
    expect(runs.run('m2', () => gate.promise)).toBe(true);
    gate.resolve();
    await Promise.all([runs.whenDone('m1'), runs.whenDone('m2')]);
  });

  it('allows a new run once the previous one finished', async () => {
    const runs = new RunOnce();
    runs.run('m1', async () => {});
    await runs.whenDone('m1');
    const again = vi.fn(async () => {});
    expect(runs.run('m1', again)).toBe(true);
    await runs.whenDone('m1');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('frees the key and logs instead of rejecting when the task fails', async () => {
    const log = vi.fn();
    const runs = new RunOnce(log);
    const gate = deferred();
    runs.run('m1', () => gate.promise);
    gate.reject(new Error('boom'));
    await expect(runs.whenDone('m1')).resolves.toBeUndefined();
    expect(runs.isRunning('m1')).toBe(false);
    expect(log).toHaveBeenCalledWith('m1', expect.objectContaining({ message: 'boom' }));
  });

  it('catches a task that throws synchronously', async () => {
    const log = vi.fn();
    const runs = new RunOnce(log);
    expect(
      runs.run('m1', () => {
        throw new Error('sync');
      }),
    ).toBe(true);
    await runs.whenDone('m1');
    expect(runs.isRunning('m1')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('whenDone() resolves immediately for a key that is not running', async () => {
    await expect(new RunOnce().whenDone('nope')).resolves.toBeUndefined();
  });

  it('running() lists the keys with a run in progress', async () => {
    const runs = new RunOnce();
    expect(runs.running()).toEqual([]);
    const a = deferred();
    const b = deferred();
    runs.run('m1', () => a.promise);
    runs.run('m2', () => b.promise);
    expect(runs.running().sort()).toEqual(['m1', 'm2']);
    a.resolve();
    await runs.whenDone('m1');
    expect(runs.running()).toEqual(['m2']);
    b.resolve();
    await runs.whenDone('m2');
    expect(runs.running()).toEqual([]);
  });

  describe('settled(timeoutMs)', () => {
    it('resolves at once when nothing is running', async () => {
      vi.useFakeTimers();
      try {
        await expect(new RunOnce().settled(5_000)).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves when every run has finished, before the timeout', async () => {
      vi.useFakeTimers();
      try {
        const runs = new RunOnce(vi.fn());
        const a = deferred();
        const b = deferred();
        runs.run('m1', () => a.promise);
        runs.run('m2', () => b.promise);
        let done = false;
        const settled = runs.settled(5_000).then(() => (done = true));
        a.resolve();
        await vi.advanceTimersByTimeAsync(10);
        expect(done).toBe(false);
        b.reject(new Error('failed run still counts as settled'));
        await settled;
        expect(runs.running()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves after the timeout when a run is still going, leaving it listed', async () => {
      vi.useFakeTimers();
      try {
        const runs = new RunOnce();
        const hang = deferred();
        runs.run('m1', () => hang.promise);
        let done = false;
        const settled = runs.settled(5_000).then(() => (done = true));
        await vi.advanceTimersByTimeAsync(4_999);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await settled;
        expect(runs.running()).toEqual(['m1']);
        hang.resolve();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
