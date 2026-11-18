import { z } from 'zod';
import type { ProviderName } from './types.js';

export interface Config {
  discordToken: string;
  discordClientId: string;
  reportChannels: Map<string, string>; // guildId -> channelId
  timezone: string;
  recordingsDir: string;
  gemini: { apiKey: string; model: string };
  groq?: { apiKey: string; transcribeModel: string; summaryModel: string };
  primaryTranscriber: ProviderName;
}

// Blank values (e.g. "KEY=" copied from .env.example) count as unset.
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const required = z.preprocess((v) => (v === '' ? undefined : v), z.string({ error: 'is required' }));

const EnvSchema = z.object({
  DISCORD_TOKEN: required,
  DISCORD_CLIENT_ID: required,
  GEMINI_API_KEY: required,
  REPORT_CHANNELS: optional,
  TIMEZONE: optional.default('Asia/Dhaka'),
  RECORDINGS_DIR: optional.default('./recordings'),
  GEMINI_MODEL: optional.default('gemini-flash-latest'),
  GROQ_API_KEY: optional,
  GROQ_MODEL: optional.default('whisper-large-v3'),
  GROQ_SUMMARY_MODEL: optional.default('openai/gpt-oss-120b'),
  TRANSCRIBER: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['gemini', 'groq'], { error: "must be 'gemini' or 'groq'" }).default('gemini'),
  ),
});

function parseReportChannels(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const pair = part.trim();
    if (!pair) continue;
    const [guildId, channelId, ...rest] = pair.split(':').map((s) => s.trim());
    if (!guildId || !channelId || rest.length > 0) {
      throw new Error(`Invalid REPORT_CHANNELS entry "${pair}": expected guildId:channelId`);
    }
    map.set(guildId, channelId);
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.')} ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  if (e.TRANSCRIBER === 'groq' && !e.GROQ_API_KEY) {
    throw new Error('Invalid configuration: GROQ_API_KEY is required when TRANSCRIBER=groq');
  }

  return {
    discordToken: e.DISCORD_TOKEN,
    discordClientId: e.DISCORD_CLIENT_ID,
    reportChannels: parseReportChannels(e.REPORT_CHANNELS),
    timezone: e.TIMEZONE,
    recordingsDir: e.RECORDINGS_DIR,
    gemini: { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL },
    groq: e.GROQ_API_KEY
      ? { apiKey: e.GROQ_API_KEY, transcribeModel: e.GROQ_MODEL, summaryModel: e.GROQ_SUMMARY_MODEL }
      : undefined,
    primaryTranscriber: e.TRANSCRIBER,
  };
}
