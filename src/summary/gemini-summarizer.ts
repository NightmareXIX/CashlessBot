import { GoogleGenAI } from '@google/genai';
import type { MeetingSummary, Summarizer } from '../types.js';
import { isRetryableError, ProviderError } from '../util/retry.js';
import { parseSummaryResponse } from './parse.js';
import { buildSummaryPrompt } from './prompt.js';

/** The slice of GoogleGenAI that this class uses, so tests can pass a plain fake. */
export interface GeminiSummaryClient {
  models: {
    generateContent(params: {
      model: string;
      contents: string;
      config: Record<string, unknown>;
    }): Promise<{ text?: string }>;
  };
}

export interface GeminiSummarizerOptions {
  apiKey: string;
  model: string;
  client?: GeminiSummaryClient;
}

const nullableString = { type: ['string', 'null'] };

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { idea: { type: 'string' }, raisedBy: nullableString },
        required: ['idea', 'raisedBy'],
      },
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'string' }, owner: nullableString, due: nullableString },
        required: ['task', 'owner', 'due'],
      },
    },
  },
  required: ['overview', 'ideas', 'tasks'],
};

export class GeminiSummarizer implements Summarizer {
  readonly name = 'gemini' as const;
  private readonly client: GeminiSummaryClient;
  private readonly model: string;

  constructor(opts: GeminiSummarizerOptions) {
    this.model = opts.model;
    this.client = opts.client ?? (new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as GeminiSummaryClient);
  }

  async summarize(transcript: string, participants: string[]): Promise<MeetingSummary> {
    let text: string | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: buildSummaryPrompt(transcript, participants),
        config: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
        },
      });
      text = response.text;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const status = (e as { status?: unknown } | null)?.status;
      throw new ProviderError(`Gemini summary request failed: ${e instanceof Error ? e.message : String(e)}`, {
        status: typeof status === 'number' ? status : undefined,
        retryable: isRetryableError(e),
        cause: e,
      });
    }
    if (!text) throw new ProviderError('Gemini returned no summary text', { retryable: true });
    return parseSummaryResponse(text);
  }
}
