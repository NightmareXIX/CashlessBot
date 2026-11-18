import type { BatchState, ClipMeta } from '../types.js';

export const BATCH_LIMITS = { maxSpeechMs: 300_000, maxBytes: 15 * 1024 * 1024, maxClips: 100 };

const byStart = (a: ClipMeta, b: ClipMeta) => a.startMs - b.startMs;

/**
 * Splits clips (in time order) into batches that respect every limit. A clip
 * that exceeds a limit on its own still gets a batch of its own, so no audio
 * is dropped.
 */
export function planBatches(
  clips: ClipMeta[],
  sizes: Map<string, number>,
  limits = BATCH_LIMITS,
): BatchState[] {
  const batches: BatchState[] = [];
  let current: string[] = [];
  let speechMs = 0;
  let bytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({ id: `b${String(batches.length + 1).padStart(3, '0')}`, clipIds: current, status: 'pending' });
    current = [];
    speechMs = 0;
    bytes = 0;
  };

  for (const clip of [...clips].sort(byStart)) {
    const size = sizes.get(clip.id) ?? 0;
    const overflows =
      speechMs + clip.durationMs > limits.maxSpeechMs ||
      bytes + size > limits.maxBytes ||
      current.length + 1 > limits.maxClips;
    if (overflows) flush();
    current.push(clip.id);
    speechMs += clip.durationMs;
    bytes += size;
  }
  flush();
  return batches;
}

/**
 * Groups time-ordered clips into speaker turns: consecutive clips from one
 * user, split on a long silence or when the turn would span more than maxTurnMs.
 */
export function groupTurns(clips: ClipMeta[], maxGapMs = 3000, maxTurnMs = 120_000): ClipMeta[][] {
  const turns: ClipMeta[][] = [];
  for (const clip of [...clips].sort(byStart)) {
    const turn = turns[turns.length - 1];
    const prev = turn?.[turn.length - 1];
    const continues =
      turn !== undefined &&
      prev !== undefined &&
      prev.userId === clip.userId &&
      clip.startMs - (prev.startMs + prev.durationMs) <= maxGapMs &&
      clip.startMs + clip.durationMs - turn[0]!.startMs <= maxTurnMs;
    if (continues) turn.push(clip);
    else turns.push([clip]);
  }
  return turns;
}
