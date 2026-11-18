import { describe, expect, it } from 'vitest';
import { GeminiTranscriber } from '../../src/transcription/gemini-transcriber.js';
import { TRANSCRIBE_PROMPT } from '../../src/transcription/prompt.js';
import { ProviderError } from '../../src/util/retry.js';
import type { AudioInput } from '../../src/types.js';

const input = (id: string, speakerName: string, bytes: string): AudioInput => ({
  id,
  speakerName,
  startMs: 0,
  mimeType: 'audio/ogg',
  data: Buffer.from(bytes),
});

describe('GeminiTranscriber', () => {
  it('sends prompt, then label + audio per clip, and keys results by clip id', async () => {
    const requests: any[] = [];
    const client = {
      models: {
        generateContent: async (req: any) => {
          requests.push(req);
          return {
            text: JSON.stringify([
              { clip_id: 'c1', text: 'আমি' },
              { clip_id: 'c2', text: 'ok' },
            ]),
          };
        },
      },
    };
    const t = new GeminiTranscriber({ apiKey: 'k', model: 'gemini-x', client });
    const result = await t.transcribe([input('c1', 'Rafi', 'aaa'), input('c2', 'Mim', 'bbb')]);

    expect(t.name).toBe('gemini');
    expect(result.get('c1')).toBe('আমি');
    expect(result.get('c2')).toBe('ok');

    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.model).toBe('gemini-x');
    expect(req.config.temperature).toBe(0);
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.contents).toHaveLength(1);
    expect(req.contents[0].role).toBe('user');
    const parts = req.contents[0].parts;
    expect(parts).toHaveLength(5);
    expect(parts[0]).toEqual({ text: TRANSCRIBE_PROMPT });
    expect(parts[1]).toEqual({ text: 'Clip c1 — speaker: Rafi' });
    expect(parts[2].inlineData.mimeType).toBe('audio/ogg');
    expect(parts[2].inlineData.data).toBe(Buffer.from('aaa').toString('base64'));
    expect(parts[3]).toEqual({ text: 'Clip c2 — speaker: Mim' });
    expect(parts[4].inlineData.data).toBe(Buffer.from('bbb').toString('base64'));
  });

  it('maps an SDK error with a status to ProviderError with the same status', async () => {
    const client = {
      models: {
        generateContent: async () => {
          throw Object.assign(new Error('quota'), { status: 429 });
        },
      },
    };
    const t = new GeminiTranscriber({ apiKey: 'k', model: 'm', client });
    const err = await t.transcribe([input('c1', 'A', 'x')]).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
  });
});
