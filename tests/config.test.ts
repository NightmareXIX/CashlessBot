import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DISCORD_TOKEN: 'tok',
  DISCORD_CLIENT_ID: 'cid',
  GEMINI_API_KEY: 'gk',
  REPORT_CHANNELS: 'g1:c1',
};

describe('loadConfig', () => {
  it('parses REPORT_CHANNELS pairs into a Map', () => {
    const cfg = loadConfig({ ...base, REPORT_CHANNELS: 'g1:c1, g2:c2' });
    expect(cfg.reportChannels.size).toBe(2);
    expect(cfg.reportChannels.get('g1')).toBe('c1');
    expect(cfg.reportChannels.get('g2')).toBe('c2');
  });

  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.discordToken).toBe('tok');
    expect(cfg.discordClientId).toBe('cid');
    expect(cfg.timezone).toBe('Asia/Dhaka');
    expect(cfg.recordingsDir).toBe('./recordings');
    expect(cfg.gemini).toEqual({ apiKey: 'gk', model: 'gemini-3.5-flash' });
    expect(cfg.primaryTranscriber).toBe('gemini');
  });

  it('applies Groq defaults when a Groq key is given', () => {
    const cfg = loadConfig({ ...base, GROQ_API_KEY: 'qk' });
    expect(cfg.groq).toEqual({
      apiKey: 'qk',
      transcribeModel: 'whisper-large-v3',
      summaryModel: 'openai/gpt-oss-120b',
    });
  });

  it('honours overrides', () => {
    const cfg = loadConfig({
      ...base,
      TIMEZONE: 'UTC',
      RECORDINGS_DIR: '/data',
      GEMINI_MODEL: 'gm',
      GROQ_API_KEY: 'qk',
      GROQ_MODEL: 'wm',
      GROQ_SUMMARY_MODEL: 'sm',
      TRANSCRIBER: 'groq',
    });
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.recordingsDir).toBe('/data');
    expect(cfg.gemini.model).toBe('gm');
    expect(cfg.groq).toEqual({ apiKey: 'qk', transcribeModel: 'wm', summaryModel: 'sm' });
    expect(cfg.primaryTranscriber).toBe('groq');
  });

  it.each(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'GEMINI_API_KEY'])(
    'throws naming %s when it is missing',
    (name) => {
      const env: NodeJS.ProcessEnv = { ...base };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it('throws when TRANSCRIBER=groq without GROQ_API_KEY', () => {
    expect(() => loadConfig({ ...base, TRANSCRIBER: 'groq' })).toThrow(/GROQ_API_KEY/);
  });

  it('leaves groq undefined without a Groq key', () => {
    expect(loadConfig(base).groq).toBeUndefined();
  });

  it('throws a clear error naming TIMEZONE when it is not a valid IANA time zone', () => {
    expect(() => loadConfig({ ...base, TIMEZONE: 'Asia/Dhakka' })).toThrow(
      'Invalid configuration: TIMEZONE "Asia/Dhakka" is not a valid time zone (e.g. Asia/Dhaka)',
    );
  });

  it('accepts any valid IANA time zone', () => {
    expect(loadConfig({ ...base, TIMEZONE: 'America/New_York' }).timezone).toBe('America/New_York');
  });

  it('throws on a malformed REPORT_CHANNELS pair', () => {
    expect(() => loadConfig({ ...base, REPORT_CHANNELS: 'g1' })).toThrow(/REPORT_CHANNELS/);
  });
});
