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
    await runs.settled('m1');
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
    await runs.settled('m1');
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('runs different keys side by side', async () => {
    const runs = new RunOnce();
    const gate = deferred();
    expect(runs.run('m1', () => gate.promise)).toBe(true);
    expect(runs.run('m2', () => gate.promise)).toBe(true);
    gate.resolve();
    await Promise.all([runs.settled('m1'), runs.settled('m2')]);
  });

  it('allows a new run once the previous one finished', async () => {
    const runs = new RunOnce();
    runs.run('m1', async () => {});
    await runs.settled('m1');
    const again = vi.fn(async () => {});
    expect(runs.run('m1', again)).toBe(true);
    await runs.settled('m1');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('frees the key and logs instead of rejecting when the task fails', async () => {
    const log = vi.fn();
    const runs = new RunOnce(log);
    const gate = deferred();
    runs.run('m1', () => gate.promise);
    gate.reject(new Error('boom'));
    await expect(runs.settled('m1')).resolves.toBeUndefined();
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
    await runs.settled('m1');
    expect(runs.isRunning('m1')).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('settled() resolves immediately for a key that is not running', async () => {
    await expect(new RunOnce().settled('nope')).resolves.toBeUndefined();
  });
});
