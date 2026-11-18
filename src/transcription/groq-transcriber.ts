import type { AudioInput, ProviderName, Transcriber } from '../types.js';
import { ProviderError } from '../util/retry.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

export interface GroqTranscriberOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  /** Minimum gap between requests, to stay under Groq's rate limit. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GroqTranscriber implements Transcriber {
  readonly name: ProviderName = 'groq';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: GroqTranscriberOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 3000;
    this.sleep = opts.sleep ?? realSleep;
  }

  async transcribe(inputs: AudioInput[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    let lastRequestAt: number | undefined;
    for (const input of inputs) {
      if (lastRequestAt !== undefined) {
        const wait = this.minIntervalMs - (Date.now() - lastRequestAt);
        if (wait > 0) await this.sleep(wait);
      }
      lastRequestAt = Date.now();
      result.set(input.id, await this.transcribeOne(input));
    }
    return result;
  }

  private async transcribeOne(input: AudioInput): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.data)], { type: input.mimeType }), `${input.id}.ogg`);
    form.append('model', this.model);
    form.append('language', 'bn');
    form.append('temperature', '0');
    form.append('response_format', 'json');

    const res = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(`Groq request failed (${res.status}): ${detail.slice(0, 200)}`, { status: res.status });
    }
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === 'string' ? body.text.trim() : '';
  }
}
