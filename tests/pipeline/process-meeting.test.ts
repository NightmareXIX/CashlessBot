import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeOggOpus } from '../../src/audio/ogg.js';
import {
  NO_SPEECH_TEXT,
  NOTE_GAPS,
  NOTE_SUMMARY_FAILED,
  NOTE_SUMMARY_STALE,
  processMeeting,
} from '../../src/pipeline/process-meeting.js';
import { buildErrorText } from '../../src/report/report-format.js';
import { MeetingStore } from '../../src/storage/meeting-store.js';
import type {
  AudioInput,
  MeetingSummary,
  ProviderName,
  ReportMessage,
  ReportPoster,
  Summarizer,
  Transcriber,
} from '../../src/types.js';
import { ProviderError, type withRetry } from '../../src/util/retry.js';

const TZ = 'Asia/Dhaka';
const GUILD = '123456789012345678';
const once: typeof withRetry = (fn) => fn();

const SUMMARY: MeetingSummary = {
  overview: 'The team planned the launch.',
  ideas: [{ idea: 'Ship on Friday', raisedBy: 'Alice' }],
  tasks: [{ task: 'Write release notes', owner: 'Bob', due: null }],
};

/** Returns "text-<id>" per input, or throws when an input id is in failIds. */
const transcriber = (name: ProviderName, failIds: string[] = []) => {
  const transcribe = vi.fn(async (inputs: AudioInput[]) => {
    if (inputs.some((i) => failIds.includes(i.id))) throw new ProviderError(`${name} down`, { status: 503 });
    return new Map(inputs.map((i) => [i.id, `text-${i.id}`]));
  });
  return { name, transcribe } satisfies Transcriber;
};

const summarizer = (name: ProviderName, works = true) => {
  const summarize = vi.fn(async (_transcript: string, _participants: string[]) => {
    if (!works) throw new ProviderError(`${name} summary down`, { status: 503 });
    return SUMMARY;
  });
  return { name, summarize } satisfies Summarizer;
};

const fakePoster = () => {
  const posts: { guildId: string; messages: ReportMessage[]; replyTo?: string }[] = [];
  const texts: { guildId: string; text: string }[] = [];
  const poster = {
    failPost: false,
    posts,
    texts,
    async post(guildId: string, messages: ReportMessage[], replyTo?: string) {
      if (poster.failPost) throw new Error('discord unavailable');
      posts.push({ guildId, messages, replyTo });
      return `msg-${posts.length}`;
    },
    async postText(guildId: string, text: string) {
      texts.push({ guildId, text });
    },
  } satisfies ReportPoster & Record<string, unknown>;
  return poster;
};

/**
 * Simulates the process dying mid-run: `hang` never settles, and `untilCrash(run)`
 * resolves once `hang` has been called, so everything saved before it is on disk.
 * It fails fast if the run finishes without reaching the crash point.
 */
function crashPoint() {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => (signal = resolve));
  const hang = (): Promise<never> => {
    signal();
    return new Promise<never>(() => {});
  };
  const untilCrash = (run: Promise<unknown>) =>
    Promise.race([
      reached,
      run.then(() => {
        throw new Error('run finished without reaching the crash point');
      }),
    ]);
  return { hang, untilCrash };
}

const description = (messages: ReportMessage[]) =>
  messages.flatMap((m) => m.embeds.map((e) => e.description ?? '')).join('\n');
const transcriptText = (messages: ReportMessage[]) => messages[0]!.files[0]!.data.toString('utf8');

let root: string;
let store: MeetingStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'process-meeting-'));
  store = new MeetingStore(root);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/**
 * Two clips of 200 s each, so planBatches puts them in separate batches:
 * b001 = c0001 (Alice), b002 = c0002 (Bob).
 */
async function recordMeeting(clipCount = 2): Promise<string> {
  const startedAt = new Date('2026-11-18T15:00:00Z');
  const meta = await store.create({ guildId: GUILD, voiceChannelId: 'v1', voiceChannelName: 'standup', startedAt });
  const speakers = [
    { userId: 'uA', speakerName: 'Alice' },
    { userId: 'uB', speakerName: 'Bob' },
  ];
  for (let i = 0; i < clipCount; i++) {
    const audio = await encodeOggOpus([randomBytes(60), randomBytes(60)]);
    await store.writeClip(meta.id, { ...speakers[i % 2]!, startMs: i * 210_000, durationMs: 200_000 }, audio);
  }
  await store.update(meta.id, (m) => {
    m.endedAt = new Date(startedAt.getTime() + 30 * 60_000).toISOString();
    m.stopReason = 'command';
  });
  return meta.id;
}

function deps(over: {
  primary?: Transcriber;
  fallback?: Transcriber;
  summarizer?: Summarizer;
  poster?: ReturnType<typeof fakePoster>;
} = {}) {
  return {
    store,
    transcribers: { primary: over.primary ?? transcriber('gemini'), fallback: over.fallback },
    summarizers: { primary: over.summarizer ?? summarizer('gemini') },
    poster: over.poster ?? fakePoster(),
    timezone: TZ,
    retry: once,
  };
}

describe('processMeeting', () => {
  it('transcribes, summarizes and posts one report with the transcript file', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    const sum = summarizer('gemini');

    const result = await processMeeting(id, deps({ poster, summarizer: sum }));

    expect(poster.posts).toHaveLength(1);
    const { guildId, messages, replyTo } = poster.posts[0]!;
    expect(guildId).toBe(GUILD);
    expect(replyTo).toBeUndefined();
    expect(messages[0]!.embeds[0]!.title).toMatch(/^📋 Meeting Report/);
    expect(description(messages)).toContain('The team planned the launch.');
    expect(messages[0]!.files[0]!.name).toBe('transcript-2026-11-18-2100.txt');
    expect(transcriptText(messages)).toContain('Alice: text-c0001');
    expect(transcriptText(messages)).toContain('Bob: text-c0002');
    expect(sum.summarize).toHaveBeenCalledWith(
      expect.stringContaining('Alice: text-c0001'),
      ['Alice', 'Bob'],
    );
    expect(poster.texts).toEqual([]);

    expect(result.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(result.reportComplete).toBe(true);
    expect(result.reportMessageId).toBe('msg-1');
    expect(result.summary).toEqual(SUMMARY);
    expect(result.batches.map((b) => [b.id, b.status, b.provider])).toEqual([
      ['b001', 'done', 'gemini'],
      ['b002', 'done', 'gemini'],
    ]);
    expect(await store.load(id)).toEqual(result);
  });

  it('posts the no-speech text and calls no provider when there are no clips', async () => {
    const id = await recordMeeting(0);
    const poster = fakePoster();
    const primary = transcriber('gemini');
    const sum = summarizer('gemini');

    const result = await processMeeting(id, deps({ poster, primary, summarizer: sum }));

    expect(poster.texts).toEqual([{ guildId: GUILD, text: NO_SPEECH_TEXT }]);
    expect(poster.posts).toEqual([]);
    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(sum.summarize).not.toHaveBeenCalled();
    expect(result.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(result.reportComplete).toBe(true);
    expect(await store.load(id)).toEqual(result);
  });

  it('posts the transcript with a note when the summary fails, then a reply once a retry succeeds', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();

    const first = await processMeeting(id, deps({ poster, summarizer: summarizer('gemini', false) }));

    expect(poster.posts).toHaveLength(1);
    expect(description(poster.posts[0]!.messages)).toContain(NOTE_SUMMARY_FAILED);
    expect(transcriptText(poster.posts[0]!.messages)).toContain('Alice: text-c0001');
    expect(first.steps).toEqual({ transcribe: 'done', summarize: 'failed', report: 'done' });
    expect(first.reportComplete).toBe(false);
    expect(first.summary).toBeUndefined();

    const primary = transcriber('gemini');
    const second = await processMeeting(id, deps({ poster, primary }));

    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(poster.posts).toHaveLength(2);
    const reply = poster.posts[1]!;
    expect(reply.replyTo).toBe(first.reportMessageId);
    expect(reply.messages[0]!.embeds[0]!.title).toMatch(/^🔁 Updated 📋 Meeting Report/);
    expect(description(reply.messages)).not.toContain(NOTE_SUMMARY_FAILED);
    expect(second.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(second.reportComplete).toBe(true);
    expect(second.reportMessageId).toBe('msg-1');
  });

  it('uses the fallback summarizer when the primary fails', async () => {
    const id = await recordMeeting();
    const fallback = summarizer('groq');
    const d = deps();

    const result = await processMeeting(id, {
      ...d,
      summarizers: { primary: summarizer('gemini', false), fallback },
    });

    expect(fallback.summarize).toHaveBeenCalledOnce();
    expect(result.summary).toEqual(SUMMARY);
    expect(result.steps.summarize).toBe('done');
  });

  it('marks a batch that fails on both providers as a gap, and a retry fills only that batch', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();

    const first = await processMeeting(
      id,
      deps({ poster, primary: transcriber('gemini', ['c0002']), fallback: transcriber('groq', ['c0002']) }),
    );

    expect(poster.posts).toHaveLength(1);
    expect(description(poster.posts[0]!.messages)).toContain(NOTE_GAPS);
    expect(transcriptText(poster.posts[0]!.messages)).toContain('[untranscribed audio');
    expect(first.batches.map((b) => b.status)).toEqual(['done', 'failed']);
    expect(first.batches[1]!.error).toBe('groq down');
    expect(first.steps).toEqual({ transcribe: 'failed', summarize: 'done', report: 'done' });
    expect(first.reportComplete).toBe(false);

    const primary = transcriber('gemini');
    const sum = summarizer('gemini');
    const second = await processMeeting(id, deps({ poster, primary, fallback: transcriber('groq'), summarizer: sum }));

    expect(primary.transcribe).toHaveBeenCalledOnce();
    expect(primary.transcribe.mock.calls[0]![0].map((i) => i.id)).toEqual(['c0002']);
    expect(sum.summarize).toHaveBeenCalledOnce();
    expect(poster.posts).toHaveLength(2);
    const reply = poster.posts[1]!;
    expect(reply.replyTo).toBe('msg-1');
    expect(description(reply.messages)).not.toContain(NOTE_GAPS);
    expect(transcriptText(reply.messages)).not.toContain('[untranscribed audio');
    expect(transcriptText(reply.messages)).toContain('Bob: text-c0002');
    expect(second.segments.filter((s) => s.batchId === 'b002')).toHaveLength(1);
    expect(second.batches[1]).toMatchObject({ status: 'done', provider: 'gemini' });
    expect(second.batches[1]!.error).toBeUndefined();
    expect(second.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(second.reportComplete).toBe(true);
  });

  it('posts the error text and no report when every batch fails', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    const sum = summarizer('gemini');

    const result = await processMeeting(
      id,
      deps({ poster, primary: transcriber('gemini', ['c0001', 'c0002']), summarizer: sum }),
    );

    expect(poster.posts).toEqual([]);
    expect(poster.texts).toEqual([{ guildId: GUILD, text: buildErrorText(result, 'transcription failed', TZ) }]);
    expect(sum.summarize).not.toHaveBeenCalled();
    expect(result.steps.transcribe).toBe('failed');
    expect(result.batches.map((b) => b.status)).toEqual(['failed', 'failed']);
    expect(await store.load(id)).toEqual(result);
  });

  it('posts nothing when retrying a finished meeting', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    await processMeeting(id, deps({ poster }));

    const primary = transcriber('gemini');
    const sum = summarizer('gemini');
    const result = await processMeeting(id, deps({ poster, primary, summarizer: sum }));

    expect(poster.posts).toHaveLength(1);
    expect(poster.texts).toEqual([]);
    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(sum.summarize).not.toHaveBeenCalled();
    expect(result.reportComplete).toBe(true);
  });

  it('posts nothing when retrying a finished meeting without speech', async () => {
    const id = await recordMeeting(0);
    const poster = fakePoster();
    await processMeeting(id, deps({ poster }));

    await processMeeting(id, deps({ poster }));

    expect(poster.texts).toHaveLength(1);
    expect(poster.posts).toEqual([]);
  });

  it('marks the report failed and rethrows when posting fails, and a retry posts it', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    poster.failPost = true;

    await expect(processMeeting(id, deps({ poster }))).rejects.toThrow('discord unavailable');
    const saved = await store.load(id);
    expect(saved.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'failed' });
    expect(saved.reportMessageId).toBeUndefined();

    poster.failPost = false;
    const primary = transcriber('gemini');
    const sum = summarizer('gemini');
    const result = await processMeeting(id, deps({ poster, primary, summarizer: sum }));

    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(sum.summarize).not.toHaveBeenCalled();
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0]!.replyTo).toBeUndefined();
    expect(result.reportMessageId).toBe('msg-1');
    expect(result.steps.report).toBe('done');
    expect(result.reportComplete).toBe(true);
  });

  it('re-posts the update on retry when the earlier reply failed to post', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    await processMeeting(id, deps({ poster, summarizer: summarizer('gemini', false) }));

    poster.failPost = true;
    await expect(processMeeting(id, deps({ poster }))).rejects.toThrow('discord unavailable');
    expect((await store.load(id)).steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'failed' });

    poster.failPost = false;
    const sum = summarizer('gemini');
    const result = await processMeeting(id, deps({ poster, summarizer: sum }));

    expect(sum.summarize).not.toHaveBeenCalled();
    expect(poster.posts).toHaveLength(2);
    expect(poster.posts[1]!.replyTo).toBe('msg-1');
    expect(description(poster.posts[1]!.messages)).toContain('The team planned the launch.');
    expect(result.steps.report).toBe('done');
    expect(result.reportComplete).toBe(true);
  });

  it('after a crash between filling a gap and posting, a restart still posts the corrected report', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    await processMeeting(
      id,
      deps({ poster, primary: transcriber('gemini', ['c0002']), fallback: transcriber('groq', ['c0002']) }),
    );

    // Retry fills the gap, then dies while summarizing.
    const crash = crashPoint();
    await crash.untilCrash(processMeeting(id, deps({ poster, summarizer: { name: 'gemini', summarize: crash.hang } })));
    const saved = await store.load(id);
    expect(saved.batches.map((b) => b.status)).toEqual(['done', 'done']);
    expect(saved.steps.report).not.toBe('done');

    // A fresh process (new store) resumes from meta.json alone.
    const primary = transcriber('gemini');
    const sum = summarizer('gemini');
    const result = await processMeeting(id, {
      ...deps({ poster, primary, summarizer: sum }),
      store: new MeetingStore(root),
    });

    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(sum.summarize).toHaveBeenCalledOnce();
    expect(poster.posts).toHaveLength(2);
    expect(poster.posts[1]!.replyTo).toBe('msg-1');
    expect(transcriptText(poster.posts[1]!.messages)).not.toContain('[untranscribed audio');
    expect(result.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(result.reportComplete).toBe(true);
  });

  it('after a crash between saving a retried summary and posting, a restart still posts the reply', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    await processMeeting(id, deps({ poster, summarizer: summarizer('gemini', false) }));

    // Retry saves the summary, then dies while posting.
    const crash = crashPoint();
    await crash.untilCrash(processMeeting(id, { ...deps(), poster: { post: crash.hang, postText: crash.hang } }));
    const saved = await store.load(id);
    expect(saved.summary).toEqual(SUMMARY);
    expect(saved.steps.report).not.toBe('done');

    const sum = summarizer('gemini');
    const result = await processMeeting(id, { ...deps({ poster, summarizer: sum }), store: new MeetingStore(root) });

    expect(sum.summarize).not.toHaveBeenCalled();
    expect(poster.posts).toHaveLength(2);
    expect(poster.posts[1]!.replyTo).toBe('msg-1');
    expect(description(poster.posts[1]!.messages)).toContain('The team planned the launch.');
    expect(description(poster.posts[1]!.messages)).not.toContain(NOTE_SUMMARY_FAILED);
    expect(result.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(result.reportComplete).toBe(true);
  });

  it('flags a stale summary when re-summarizing after a filled gap fails, and refreshes it on retry', async () => {
    const id = await recordMeeting();
    const poster = fakePoster();
    await processMeeting(
      id,
      deps({ poster, primary: transcriber('gemini', ['c0002']), fallback: transcriber('groq', ['c0002']) }),
    );

    const second = await processMeeting(id, deps({ poster, summarizer: summarizer('gemini', false) }));

    expect(poster.posts).toHaveLength(2);
    const reply = description(poster.posts[1]!.messages);
    expect(reply).toContain(NOTE_SUMMARY_STALE);
    expect(reply).not.toContain(NOTE_SUMMARY_FAILED);
    expect(reply).not.toContain(NOTE_GAPS);
    expect(second.summary).toEqual(SUMMARY);
    expect(second.steps).toEqual({ transcribe: 'done', summarize: 'failed', report: 'done' });
    expect(second.reportComplete).toBe(false);

    const primary = transcriber('gemini');
    const sum = summarizer('gemini');
    const third = await processMeeting(id, deps({ poster, primary, summarizer: sum }));

    expect(primary.transcribe).not.toHaveBeenCalled();
    expect(sum.summarize).toHaveBeenCalledOnce();
    expect(poster.posts).toHaveLength(3);
    expect(poster.posts[2]!.replyTo).toBe('msg-1');
    expect(description(poster.posts[2]!.messages)).not.toContain(NOTE_SUMMARY_STALE);
    expect(third.steps).toEqual({ transcribe: 'done', summarize: 'done', report: 'done' });
    expect(third.reportComplete).toBe(true);
  });
});
