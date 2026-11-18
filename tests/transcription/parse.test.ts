import { describe, expect, it } from 'vitest';
import { parseTranscriptionResponse } from '../../src/transcription/parse.js';
import { ProviderError } from '../../src/util/retry.js';

describe('parseTranscriptionResponse', () => {
  it('parses a plain JSON array', () => {
    const raw = JSON.stringify([
      { clip_id: 'c1', text: 'হ্যালো' },
      { clip_id: 'c2', text: 'hello' },
    ]);
    const out = parseTranscriptionResponse(raw, ['c1', 'c2']);
    expect(out.get('c1')).toBe('হ্যালো');
    expect(out.get('c2')).toBe('hello');
  });

  it('parses a ```json fenced array', () => {
    const raw = '```json\n[{"clip_id":"c1","text":"hi"}]\n```';
    expect(parseTranscriptionResponse(raw, ['c1']).get('c1')).toBe('hi');
  });

  it('ignores unknown ids', () => {
    const raw = '[{"clip_id":"c1","text":"a"},{"clip_id":"zzz","text":"b"}]';
    const out = parseTranscriptionResponse(raw, ['c1']);
    expect([...out.keys()]).toEqual(['c1']);
  });

  it('maps a missing expected id to an empty string', () => {
    const out = parseTranscriptionResponse('[{"clip_id":"c1","text":"a"}]', ['c1', 'c2']);
    expect(out.get('c2')).toBe('');
  });

  it('throws a retryable ProviderError for a non-array', () => {
    try {
      parseTranscriptionResponse('{"a":1}', ['c1']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).retryable).toBe(true);
    }
  });

  it('throws a retryable ProviderError for invalid JSON', () => {
    try {
      parseTranscriptionResponse('not json', ['c1']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).retryable).toBe(true);
    }
  });
});
