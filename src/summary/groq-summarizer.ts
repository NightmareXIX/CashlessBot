import type { MeetingSummary, Summarizer } from '../types.js';
import { isRetryableError, ProviderError } from '../util/retry.js';
import { parseSummaryResponse } from './parse.js';
import { buildSummaryPrompt } from './prompt.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqSummarizerOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export class GroqSummarizer implements Summarizer {
  readonly name = 'groq' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GroqSummarizerOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async summarize(transcript: string, participants: string[]): Promise<MeetingSummary> {
    let res: Response;
    try {
      res = await this.fetchFn(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: buildSummaryPrompt(transcript, participants) }],
        }),
      });
    } catch (e) {
      throw new ProviderError(`Groq summary request failed: ${e instanceof Error ? e.message : String(e)}`, {
        retryable: isRetryableError(e),
        cause: e,
      });
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`Groq summary request failed with HTTP ${res.status}: ${detail}`, { status: res.status });
    }

    let content: unknown;
    try {
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      content = data.choices?.[0]?.message?.content;
    } catch (cause) {
      throw new ProviderError('Groq returned a response that was not JSON', { retryable: true, cause });
    }
    if (typeof content !== 'string' || !content) {
      throw new ProviderError('Groq returned no summary text', { retryable: true });
    }
    return parseSummaryResponse(content);
  }
}
