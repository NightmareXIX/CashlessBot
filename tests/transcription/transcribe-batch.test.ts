import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeOggOpusPackets, encodeOggOpus } from '../../src/audio/ogg.js';
import { transcribeBatch } from '../../src/transcription/transcribe-batch.js';
import type { AudioInput, BatchState, ClipMeta, ProviderName, Transcriber } from '../../src/types.js';
import { ProviderError, type withRetry } from '../../src/util/retry.js';

const packets = (n = 3) => Array.from({ length: n }, () => randomBytes(50));

const clip = (id: string, userId: string, startMs: number, durationMs = 1000): ClipMeta => ({
  id,
  userId,
  speakerName: userId === 'uA' ? 'Alice' : 'Bob',
  startMs,
  durationMs,
  file: `clips/${id}.ogg`,
});

const working = (name: ProviderName) => {
  const transcribe = vi.fn(async (inputs: AudioInput[]) => new Map(inputs.map((i) => [i.id, `text-${i.id}`])));
  return { name, transcribe } satisfies Transcriber;
};

const failing = (name: ProviderName, message = `${name} down`) => {
  const transcribe = vi.fn(async (_inputs: AudioInput[]): Promise<Map<string, string>> => {
    throw new ProviderError(message, { status: 503 });
  });
  return { name, transcribe } satisfies Transcriber;
};

const once: typeof withRetry = (fn) => fn();

async function setup(clips: ClipMeta[]) {
  const audio = new Map<string, Buffer[]>();
  const files = new Map<string, Buffer>();
  for (const c of clips) {
    const p = packets();
    audio.set(c.id, p);
    files.set(c.id, await encodeOggOpus(p));
  }
  const batch: BatchState = { id: 'b001', clipIds: clips.map((c) => c.id), status: 'pending' };
  const readClip = async (c: ClipMeta) => files.get(c.id)!;
  return { audio, files, batch, readClip };
}

describe('transcribeBatch', () => {
  it('transcribes each clip with the primary and builds one segment per clip', async () => {
    const clips = [clip('c0001', 'uA', 0, 1500), clip('c0002', 'uB', 2000, 800)];
    const { batch, readClip, files } = await setup(clips);
    const primary = working('gemini');
    const fallback = working('groq');

    const result = await transcribeBatch(batch, clips, { readClip, primary, fallback, retry: once });

    expect(result.provider).toBe('gemini');
    expect(fallback.transcribe).not.toHaveBeenCalled();
    const inputs = primary.transcribe.mock.calls[0]![0];
    expect(inputs.map((i) => i.id)).toEqual(['c0001', 'c0002']);
    expect(inputs[0]).toMatchObject({ speakerName: 'Alice', startMs: 0, mimeType: 'audio/ogg' });
    expect(inputs[0]!.data.equals(files.get('c0001')!)).toBe(true);
    expect(result.segments).toEqual([
      { batchId: 'b001', clipIds: ['c0001'], userId: 'uA', speakerName: 'Alice', startMs: 0, endMs: 1500, text: 'text-c0001' },
      { batchId: 'b001', clipIds: ['c0002'], userId: 'uB', speakerName: 'Bob', startMs: 2000, endMs: 2800, text: 'text-c0002' },
    ]);
  });

  it('runs every transcriber call through retry', async () => {
    const clips = [clip('c0001', 'uA', 0)];
    const { batch, readClip } = await setup(clips);
    let retryCalls = 0;
    const retry: typeof withRetry = (fn) => {
      retryCalls++;
      return fn();
    };

    await transcribeBatch(batch, clips, { readClip, primary: failing('gemini'), fallback: working('groq'), retry });

    expect(retryCalls).toBe(2);
  });

  it('falls back when the primary fails and reports the fallback provider', async () => {
    const clips = [clip('c0001', 'uA', 0)];
    const { batch, readClip } = await setup(clips);
    const primary = failing('gemini');
    const fallback = working('groq');

    const result = await transcribeBatch(batch, clips, { readClip, primary, fallback, retry: once });

    expect(primary.transcribe).toHaveBeenCalledOnce();
    expect(result.provider).toBe('groq');
    expect(result.segments.map((s) => s.text)).toEqual(['text-c0001']);
  });

  it("rejects with the fallback's error when both providers fail", async () => {
    const clips = [clip('c0001', 'uA', 0)];
    const { batch, readClip } = await setup(clips);

    await expect(
      transcribeBatch(batch, clips, {
        readClip,
        primary: failing('gemini', 'gemini down'),
        fallback: failing('groq', 'groq down'),
        retry: once,
      }),
    ).rejects.toThrow('groq down');
  });

  it("rejects with the primary's error when there is no fallback", async () => {
    const clips = [clip('c0001', 'uA', 0)];
    const { batch, readClip } = await setup(clips);

    await expect(
      transcribeBatch(batch, clips, { readClip, primary: failing('gemini', 'gemini down'), retry: once }),
    ).rejects.toThrow('gemini down');
  });

  it('sends Groq one concatenated input per speaker turn', async () => {
    const clips = [clip('c0001', 'uA', 0, 1000), clip('c0002', 'uA', 1500, 1000), clip('c0003', 'uB', 3000, 700)];
    const { batch, readClip, audio } = await setup(clips);
    const primary = working('groq');

    const result = await transcribeBatch(batch, clips, { readClip, primary, retry: once });

    const inputs = primary.transcribe.mock.calls[0]![0];
    expect(inputs.map((i) => i.id)).toEqual(['c0001', 'c0003']);
    expect(await decodeOggOpusPackets(inputs[0]!.data)).toEqual([...audio.get('c0001')!, ...audio.get('c0002')!]);
    expect(result.provider).toBe('groq');
    expect(result.segments).toEqual([
      { batchId: 'b001', clipIds: ['c0001', 'c0002'], userId: 'uA', speakerName: 'Alice', startMs: 0, endMs: 2500, text: 'text-c0001' },
      { batchId: 'b001', clipIds: ['c0003'], userId: 'uB', speakerName: 'Bob', startMs: 3000, endMs: 3700, text: 'text-c0003' },
    ]);
  });
});
