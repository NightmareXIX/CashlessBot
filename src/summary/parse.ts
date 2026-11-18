import { z } from 'zod';
import type { MeetingSummary } from '../types.js';
import { ProviderError } from '../util/retry.js';

/** Trimmed string; missing, null or blank becomes null. */
const optionalText = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() || null : v ?? null),
  z.string().nullable(),
);

const summarySchema = z.object({
  overview: z.string().trim().min(1),
  ideas: z.array(z.object({ idea: z.string().trim().min(1), raisedBy: optionalText })).default([]),
  tasks: z
    .array(z.object({ task: z.string().trim().min(1), owner: optionalText, due: optionalText }))
    .default([]),
});

function stripFence(raw: string): string {
  const match = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(raw.trim());
  return match ? match[1]! : raw.trim();
}

/** Parses a model's JSON reply. Malformed output is retryable: a new attempt may fix it. */
export function parseSummaryResponse(raw: string): MeetingSummary {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(raw));
  } catch (cause) {
    throw new ProviderError('Summary response was not valid JSON', { retryable: true, cause });
  }
  const result = summarySchema.safeParse(json);
  if (!result.success) {
    throw new ProviderError(`Summary response had the wrong shape: ${result.error.message}`, {
      retryable: true,
      cause: result.error,
    });
  }
  return result.data;
}
