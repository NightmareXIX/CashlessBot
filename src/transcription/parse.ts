import { ProviderError } from '../util/retry.js';

const FENCE = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/;

/** Parses the model's JSON array into clip id -> text. Missing expected ids map to ''; unknown ids are dropped. */
export function parseTranscriptionResponse(raw: string, expectedIds: string[]): Map<string, string> {
  let body = raw.trim();
  const fenced = FENCE.exec(body);
  if (fenced) body = fenced[1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new ProviderError('Transcription response was not valid JSON', { retryable: true, cause });
  }
  if (!Array.isArray(parsed)) {
    throw new ProviderError('Transcription response was not a JSON array', { retryable: true });
  }

  const found = new Map<string, string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { clip_id, text } = item as { clip_id?: unknown; text?: unknown };
    if (typeof clip_id === 'string') found.set(clip_id, typeof text === 'string' ? text.trim() : '');
  }

  const result = new Map<string, string>();
  for (const id of expectedIds) result.set(id, found.get(id) ?? '');
  return result;
}
