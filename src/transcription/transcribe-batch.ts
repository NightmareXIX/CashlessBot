import { concatOggOpus } from '../audio/ogg.js';
import type { AudioInput, BatchState, ClipMeta, ProviderName, Transcriber, TranscriptSegment } from '../types.js';
import { withRetry } from '../util/retry.js';
import { groupTurns } from './batching.js';

export interface TranscribeBatchDeps {
  readClip(c: ClipMeta): Promise<Buffer>;
  primary: Transcriber;
  fallback?: Transcriber;
  retry?: typeof withRetry;
}

/**
 * Transcribes one batch's clips with the primary transcriber, or with the
 * fallback if the primary still fails after retries. Groq gets one input per
 * speaker turn (its clips joined); any other transcriber gets one per clip.
 */
export async function transcribeBatch(
  batch: BatchState,
  clips: ClipMeta[],
  deps: TranscribeBatchDeps,
): Promise<{ segments: TranscriptSegment[]; provider: ProviderName }> {
  const retry = deps.retry ?? withRetry;
  const run = async (transcriber: Transcriber) => {
    const groups = transcriber.name === 'groq' ? groupTurns(clips) : clips.map((c) => [c]);
    const inputs = await Promise.all(groups.map((group) => toInput(group, deps.readClip)));
    const texts = await retry(() => transcriber.transcribe(inputs));
    const segments = groups.map((group) => toSegment(batch.id, group, texts.get(group[0]!.id) ?? ''));
    return { segments, provider: transcriber.name };
  };

  try {
    return await run(deps.primary);
  } catch (err) {
    if (!deps.fallback) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `Transcription of batch ${batch.id} with ${deps.primary.name} failed, using ${deps.fallback.name}: ${reason}`,
    );
    return run(deps.fallback);
  }
}

async function toInput(group: ClipMeta[], readClip: (c: ClipMeta) => Promise<Buffer>): Promise<AudioInput> {
  const first = group[0]!;
  const files = await Promise.all(group.map(readClip));
  return {
    id: first.id,
    speakerName: first.speakerName,
    startMs: first.startMs,
    mimeType: 'audio/ogg',
    data: files.length === 1 ? files[0]! : await concatOggOpus(files),
  };
}

function toSegment(batchId: string, group: ClipMeta[], text: string): TranscriptSegment {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  return {
    batchId,
    clipIds: group.map((c) => c.id),
    userId: first.userId,
    speakerName: first.speakerName,
    startMs: first.startMs,
    endMs: last.startMs + last.durationMs,
    text,
  };
}
