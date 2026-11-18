import { describe, expect, it } from 'vitest';
import { parseSummaryResponse } from '../../src/summary/parse.js';
import { buildSummaryPrompt } from '../../src/summary/prompt.js';
import { ProviderError } from '../../src/util/retry.js';

const valid = {
  overview: 'The team planned the launch.',
  ideas: [{ idea: 'Ship a beta first', raisedBy: 'Rafi' }],
  tasks: [{ task: 'Draft the announcement', owner: 'Nila', due: 'Friday' }],
};

describe('parseSummaryResponse', () => {
  it('parses valid JSON', () => {
    expect(parseSummaryResponse(JSON.stringify(valid))).toEqual(valid);
  });

  it('parses JSON wrapped in a code fence', () => {
    const raw = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseSummaryResponse(raw)).toEqual(valid);
  });

  it('turns empty-string owner and due into null', () => {
    const raw = JSON.stringify({ ...valid, tasks: [{ task: 'Do it', owner: '', due: '' }] });
    expect(parseSummaryResponse(raw).tasks).toEqual([{ task: 'Do it', owner: null, due: null }]);
  });

  it('defaults missing ideas and tasks to empty lists', () => {
    const result = parseSummaryResponse(JSON.stringify({ overview: 'Short chat.' }));
    expect(result).toEqual({ overview: 'Short chat.', ideas: [], tasks: [] });
  });

  it('trims fields', () => {
    const raw = JSON.stringify({
      overview: '  Spaced out.  ',
      ideas: [{ idea: ' An idea ', raisedBy: ' Rafi ' }],
      tasks: [{ task: ' A task ', owner: ' Nila ', due: ' next week ' }],
    });
    expect(parseSummaryResponse(raw)).toEqual({
      overview: 'Spaced out.',
      ideas: [{ idea: 'An idea', raisedBy: 'Rafi' }],
      tasks: [{ task: 'A task', owner: 'Nila', due: 'next week' }],
    });
  });

  it('throws a retryable ProviderError for an empty overview', () => {
    const raw = JSON.stringify({ ...valid, overview: '   ' });
    expect(() => parseSummaryResponse(raw)).toThrow(ProviderError);
    try {
      parseSummaryResponse(raw);
    } catch (e) {
      expect((e as ProviderError).retryable).toBe(true);
    }
  });

  it('throws a retryable ProviderError for invalid JSON', () => {
    try {
      parseSummaryResponse('not json at all');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).retryable).toBe(true);
    }
  });
});

describe('buildSummaryPrompt', () => {
  it('contains every participant and the transcript verbatim', () => {
    const transcript = '[00:00:05] Rafi: আমরা আগামী সপ্তাহে লঞ্চ করব\n[00:00:09] Nila: ঠিক আছে, I will draft it';
    const prompt = buildSummaryPrompt(transcript, ['Rafi', 'Nila', 'Tanvir']);
    expect(prompt).toContain('Participants: Rafi, Nila, Tanvir');
    expect(prompt).toContain('Transcript:\n' + transcript);
    expect(prompt).toContain('Return JSON only');
    expect(prompt).toContain('[untranscribed audio]');
  });
});
