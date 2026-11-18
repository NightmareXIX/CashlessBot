import { describe, expect, it } from 'vitest';
import { BATCH_LIMITS, groupTurns, planBatches } from '../../src/transcription/batching.js';
import type { ClipMeta } from '../../src/types.js';

function clip(n: number, userId: string, startMs: number, durationMs: number): ClipMeta {
  const id = `c${String(n).padStart(4, '0')}`;
  return { id, userId, speakerName: userId, startMs, durationMs, file: `clips/${id}.ogg` };
}

describe('planBatches', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => clip(i + 1, 'A', i * 30_000, 30_000));
  const sizes = new Map(twelve.map((c) => [c.id, 1000]));

  it('splits 12 clips of 30 s into batches of 10 and 2', () => {
    const batches = planBatches(twelve, sizes);
    expect(batches.map((b) => b.id)).toEqual(['b001', 'b002']);
    expect(batches.map((b) => b.clipIds.length)).toEqual([10, 2]);
    expect(batches.every((b) => b.status === 'pending')).toBe(true);
  });

  it('keeps batches at 12 MB, so they stay under the inline request limit once base64-encoded', () => {
    expect(BATCH_LIMITS.maxBytes).toBe(12 * 1024 * 1024);
  });

  it('splits when the byte limit would be exceeded', () => {
    // Three 5 MB clips (15 MB) would exceed the limit, so each batch holds two.
    const big = new Map(twelve.map((c) => [c.id, 5 * 1024 * 1024]));
    const batches = planBatches(twelve, big);
    expect(batches.map((b) => b.clipIds.length)).toEqual(Array(6).fill(2));
  });

  it('splits when the clip count limit would be exceeded', () => {
    const batches = planBatches(twelve, sizes, { ...BATCH_LIMITS, maxClips: 5 });
    expect(batches.map((b) => b.clipIds.length)).toEqual([5, 5, 2]);
  });

  it('keeps every clip id once, in time order', () => {
    const shuffled = [...twelve].reverse();
    const ids = planBatches(shuffled, sizes).flatMap((b) => b.clipIds);
    expect(ids).toEqual(twelve.map((c) => c.id));
  });

  it('puts an oversized clip in a batch of its own instead of dropping it', () => {
    const huge = new Map(sizes).set('c0001', BATCH_LIMITS.maxBytes + 1);
    const batches = planBatches(twelve.slice(0, 3), huge);
    expect(batches.map((b) => b.clipIds)).toEqual([['c0001'], ['c0002', 'c0003']]);
  });

  it('returns no batches for no clips', () => {
    expect(planBatches([], new Map())).toEqual([]);
  });
});

describe('groupTurns', () => {
  it('groups consecutive same-speaker clips: A, A, B, A makes 3 turns', () => {
    const clips = [
      clip(1, 'A', 0, 2000),
      clip(2, 'A', 2000, 2000),
      clip(3, 'B', 4000, 2000),
      clip(4, 'A', 6000, 2000),
    ];
    const turns = groupTurns(clips);
    expect(turns.map((t) => t.map((c) => c.id))).toEqual([['c0001', 'c0002'], ['c0003'], ['c0004']]);
  });

  it('splits a turn on a gap longer than 3 s but not on exactly 3 s', () => {
    const a = clip(1, 'A', 0, 2000);
    const exact = clip(2, 'A', 5000, 2000); // gap 3000
    const longer = clip(3, 'A', 11_000, 2000); // gap 4000 after exact (ends 7000)
    const turns = groupTurns([a, exact, longer]);
    expect(turns.map((t) => t.map((c) => c.id))).toEqual([['c0001', 'c0002'], ['c0003']]);
  });

  it('never lets a turn grow past 120 s', () => {
    const clips = Array.from({ length: 10 }, (_, i) => clip(i + 1, 'A', i * 30_000, 30_000));
    const turns = groupTurns(clips);
    expect(turns.map((t) => t.length)).toEqual([4, 4, 2]);
    for (const t of turns) {
      const last = t[t.length - 1]!;
      expect(last.startMs + last.durationMs - t[0]!.startMs).toBeLessThanOrEqual(120_000);
    }
  });

  it('sorts clips by startMs before grouping', () => {
    const turns = groupTurns([clip(2, 'A', 2000, 2000), clip(1, 'A', 0, 2000)]);
    expect(turns.map((t) => t.map((c) => c.id))).toEqual([['c0001', 'c0002']]);
  });
});
