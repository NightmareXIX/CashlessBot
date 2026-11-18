import { GoogleGenAI } from '@google/genai';
import type { AudioInput, ProviderName, Transcriber } from '../types.js';
import { ProviderError } from '../util/retry.js';
import { parseTranscriptionResponse } from './parse.js';
import { TRANSCRIBE_PROMPT } from './prompt.js';

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiGenerateRequest {
  model: string;
  contents: { role: 'user'; parts: Part[] }[];
  config: {
    temperature: number;
    responseMimeType: string;
    responseJsonSchema: unknown;
  };
}

export interface GeminiClient {
  models: { generateContent(req: GeminiGenerateRequest): Promise<{ text?: string }> };
}

export interface GeminiTranscriberOptions {
  apiKey: string;
  model: string;
  client?: GeminiClient;
}

const RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      clip_id: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['clip_id', 'text'],
  },
};

export class GeminiTranscriber implements Transcriber {
  readonly name: ProviderName = 'gemini';
  private readonly model: string;
  private readonly client: GeminiClient;

  constructor(opts: GeminiTranscriberOptions) {
    this.model = opts.model;
    this.client = opts.client ?? (new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as GeminiClient);
  }

  async transcribe(inputs: AudioInput[]): Promise<Map<string, string>> {
    const parts: Part[] = [{ text: TRANSCRIBE_PROMPT }];
    for (const input of inputs) {
      parts.push({ text: `Clip ${input.id} — speaker: ${input.speakerName}` });
      parts.push({ inlineData: { mimeType: input.mimeType, data: input.data.toString('base64') } });
    }

    let text: string | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: RESPONSE_SCHEMA },
      });
      text = response.text;
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (typeof status === 'number') {
        throw new ProviderError(`Gemini request failed (${status}): ${(e as Error).message}`, { status, cause: e });
      }
      throw e;
    }

    if (!text) throw new ProviderError('Gemini returned an empty response', { retryable: true });
    return parseTranscriptionResponse(
      text,
      inputs.map((i) => i.id),
    );
  }
}
