import { describe, expect, it } from 'vitest';
import { GroqTranscriber } from '../../src/transcription/groq-transcriber.js';
import { ProviderError } from '../../src/util/retry.js';
import type { AudioInput } from '../../src/types.js';

const input = (id: string): AudioInput => ({
  id,
  speakerName: 'A',
  startMs: 0,
  mimeType: 'audio/ogg',
  data: Buffer.from('audio-' + id),
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GroqTranscriber', () => {
  it('makes one sequential request per input with the right form and waits between them', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sleeps: number[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ text: ' টেস্ট ' });
    }) as unknown as typeof fetch;
    const t = new GroqTranscriber({
      apiKey: 'gk',
      model: 'whisper-large-v3',
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = await t.transcribe([input('c1'), input('c2')]);

    expect(t.name).toBe('groq');
    expect(out.get('c1')).toBe('টেস্ট');
    expect(out.get('c2')).toBe('টেস্ট');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer gk');
    const form = calls[1]!.init.body as FormData;
    expect(form.get('language')).toBe('bn');
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('c2.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2900);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it('throws ProviderError with the status on a non-2xx response', async () => {
    const fetchFn = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const t = new GroqTranscriber({ apiKey: 'k', model: 'm', fetchFn, sleep: async () => {} });
    const err = await t.transcribe([input('c1')]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
  });
});
