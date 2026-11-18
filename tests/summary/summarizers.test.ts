import { describe, expect, it, vi } from 'vitest';
import { GeminiSummarizer } from '../../src/summary/gemini-summarizer.js';
import { GroqSummarizer } from '../../src/summary/groq-summarizer.js';
import { ProviderError } from '../../src/util/retry.js';

const summary = {
  overview: 'The team planned the launch.',
  ideas: [{ idea: 'Ship a beta first', raisedBy: 'Rafi' }],
  tasks: [{ task: 'Draft the announcement', owner: 'Nila', due: 'Friday' }],
};
const transcript = '[00:00:05] Rafi: আমরা লঞ্চ করব';

describe('GeminiSummarizer', () => {
  it('sends the model, JSON mode and prompt, and returns the parsed summary', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: JSON.stringify(summary) });
    const s = new GeminiSummarizer({ apiKey: 'k', model: 'gemini-test', client: { models: { generateContent } } });

    expect(s.name).toBe('gemini');
    await expect(s.summarize(transcript, ['Rafi', 'Nila'])).resolves.toEqual(summary);

    const req = generateContent.mock.calls[0]![0];
    expect(req.model).toBe('gemini-test');
    expect(req.contents).toContain(transcript);
    expect(req.contents).toContain('Participants: Rafi, Nila');
    expect(req.config.temperature).toBe(0.2);
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema).toMatchObject({ type: 'object', required: ['overview', 'ideas', 'tasks'] });
  });

  it('maps an API error with a status to a ProviderError carrying that status', async () => {
    const apiError = Object.assign(new Error('overloaded'), { status: 503 });
    const generateContent = vi.fn().mockRejectedValue(apiError);
    const s = new GeminiSummarizer({ apiKey: 'k', model: 'm', client: { models: { generateContent } } });

    const err = await s.summarize(transcript, []).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('throws a retryable ProviderError when the response has no text', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: undefined });
    const s = new GeminiSummarizer({ apiKey: 'k', model: 'm', client: { models: { generateContent } } });
    const err = await s.summarize(transcript, []).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe('GroqSummarizer', () => {
  it('posts a JSON-mode chat completion and returns the parsed summary', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(summary) } }] }), { status: 200 }),
    );
    const s = new GroqSummarizer({ apiKey: 'gk', model: 'llama-test', fetchFn });

    expect(s.name).toBe('groq');
    await expect(s.summarize(transcript, ['Rafi'])).resolves.toEqual(summary);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer gk');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama-test');
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain(transcript);
  });

  it('maps a 503 response to a ProviderError with status 503', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const s = new GroqSummarizer({ apiKey: 'gk', model: 'm', fetchFn });
    const err = await s.summarize(transcript, []).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('throws a retryable ProviderError when the completion has no content', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const s = new GroqSummarizer({ apiKey: 'gk', model: 'm', fetchFn });
    const err = await s.summarize(transcript, []).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });
});
