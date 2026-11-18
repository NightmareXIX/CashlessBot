import { describe, expect, it, vi } from 'vitest';
import { interruptedText, processingInterruptedText } from '../../src/discord/handlers.js';
import { RunOnce } from '../../src/discord/run-once.js';
import { saveAndFlagForShutdown } from '../../src/discord/shutdown.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

function makeDeps(over: { activeGuildIds?: string[]; waitMs?: number } = {}) {
  return {
    activeGuildIds: vi.fn((): string[] => over.activeGuildIds ?? []),
    stop: vi.fn(async (guildId: string): Promise<string | undefined> => `meeting-of-${guildId}`),
    processing: new RunOnce(vi.fn()),
    waitMs: over.waitMs ?? 20,
    guildIdOf: vi.fn(async (meetingId: string) => meetingId.split(':')[0]!),
    postText: vi.fn(async (_guildId: string, _text: string) => undefined),
    log: vi.fn(),
  };
}

describe('saveAndFlagForShutdown', () => {
  it('stops each active session and tells its guild to /retry after the restart', async () => {
    const deps = makeDeps({ activeGuildIds: ['g1', 'g2'] });
    deps.stop.mockImplementation(async (g) => (g === 'g2' ? undefined : `m-${g}`)); // g2's join failed

    await saveAndFlagForShutdown(deps);

    expect(deps.stop).toHaveBeenCalledWith('g1');
    expect(deps.stop).toHaveBeenCalledWith('g2');
    expect(deps.postText).toHaveBeenCalledTimes(1);
    expect(deps.postText).toHaveBeenCalledWith('g1', interruptedText);
  });

  it('waits for in-flight processing that finishes within the budget, and flags nothing', async () => {
    const deps = makeDeps({ waitMs: 1_000 });
    const run = deferred();
    deps.processing.run('g1:m1', () => run.promise);
    setTimeout(run.resolve, 5);

    await saveAndFlagForShutdown(deps);

    expect(deps.processing.running()).toEqual([]);
    expect(deps.postText).not.toHaveBeenCalled();
  });

  it('flags processing still running after the budget, once per guild', async () => {
    const deps = makeDeps({ waitMs: 10 });
    const hang = deferred();
    deps.processing.run('g1:m1', () => hang.promise);
    deps.processing.run('g1:m2', () => hang.promise);
    deps.processing.run('g2:m3', () => hang.promise);

    await saveAndFlagForShutdown(deps);

    expect(deps.guildIdOf).toHaveBeenCalledTimes(3);
    expect(deps.postText).toHaveBeenCalledTimes(2);
    expect(deps.postText).toHaveBeenCalledWith('g1', processingInterruptedText);
    expect(deps.postText).toHaveBeenCalledWith('g2', processingInterruptedText);
    hang.resolve();
  });

  it('never throws when stopping, looking up a guild, or posting fails', async () => {
    const deps = makeDeps({ activeGuildIds: ['g1'], waitMs: 10 });
    deps.stop.mockRejectedValue(new Error('disk full'));
    deps.guildIdOf.mockRejectedValue(new Error('ENOENT'));
    deps.postText.mockRejectedValue(new Error('missing access'));
    const hang = deferred();
    deps.processing.run('m1', () => hang.promise);

    await expect(saveAndFlagForShutdown(deps)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalled();
    hang.resolve();
  });

  it('still flags processing when activeGuildIds throws', async () => {
    const deps = makeDeps({ waitMs: 10 });
    deps.activeGuildIds.mockImplementation(() => {
      throw new Error('boom');
    });
    const hang = deferred();
    deps.processing.run('g1:m1', () => hang.promise);

    await expect(saveAndFlagForShutdown(deps)).resolves.toBeUndefined();
    expect(deps.postText).toHaveBeenCalledWith('g1', processingInterruptedText);
    hang.resolve();
  });
});
