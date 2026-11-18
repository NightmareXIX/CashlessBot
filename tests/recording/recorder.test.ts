import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EndBehaviorType } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeOggOpusPackets } from '../../src/audio/ogg.js';
import {
  CLIP_SILENCE_MS,
  MAX_CLIP_PACKETS,
  MeetingRecorder,
  MIN_CLIP_PACKETS,
  type VoiceReceiverLike,
} from '../../src/recording/recorder.js';
import { MeetingStore } from '../../src/storage/meeting-store.js';
import type { MeetingMeta } from '../../src/types.js';

class FakeReceiver implements VoiceReceiverLike {
  readonly speaking = new EventEmitter();
  readonly subscriptions = new Map<string, PassThrough>();
  readonly subscribe = vi.fn((userId: string, _opts: { end: { behavior: EndBehaviorType; duration: number } }) => {
    const stream = new PassThrough({ objectMode: true });
    // Mirrors @discordjs/voice: the subscription is dropped once the stream closes.
    stream.once('close', () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, stream);
    return stream;
  });
}

const START = Date.parse('2026-03-04T05:06:07Z');
const packet = (i: number) => Buffer.from([0xfc, i & 0xff, (i >> 8) & 0xff]);
const packets = (n: number) => Array.from({ length: n }, (_, i) => packet(i));

let root: string;
let store: MeetingStore;
let meta: MeetingMeta;
let receiver: FakeReceiver;
let clock: number;
let names: Record<string, { name: string; isBot: boolean }>;
let resolveSpeaker: ReturnType<typeof vi.fn<(userId: string) => Promise<{ name: string; isBot: boolean }>>>;
let recorder: MeetingRecorder;

/** Emits a speaking start and waits until the recorder has subscribed to that user. */
async function startSpeaking(userId: string): Promise<PassThrough> {
  receiver.speaking.emit('start', userId);
  await vi.waitFor(() => expect(receiver.subscriptions.has(userId)).toBe(true));
  return receiver.subscriptions.get(userId)!;
}

async function speak(userId: string, count: number): Promise<void> {
  const stream = await startSpeaking(userId);
  for (const p of packets(count)) stream.write(p);
  stream.end();
}

async function waitForClips(n: number) {
  await vi.waitFor(async () => expect((await store.load(meta.id)).clips).toHaveLength(n));
  return store.load(meta.id);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'recorder-'));
  store = new MeetingStore(root);
  meta = await store.create({
    guildId: '123456789012345678',
    voiceChannelId: 'v1',
    voiceChannelName: 'General',
    startedAt: new Date(START),
  });
  receiver = new FakeReceiver();
  clock = START;
  names = {
    u1: { name: 'Rahim', isBot: false },
    u2: { name: 'Karim', isBot: false },
    bot: { name: 'Music Bot', isBot: true },
  };
  resolveSpeaker = vi.fn(async (userId: string) => ({ ...names[userId]! }));
  recorder = new MeetingRecorder(meta, receiver, { store, resolveSpeaker, now: () => clock });
  recorder.start();
});

afterEach(async () => {
  await recorder.stop();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('MeetingRecorder', () => {
  it('exposes the clip thresholds', () => {
    expect(CLIP_SILENCE_MS).toBe(1000);
    expect(MIN_CLIP_PACKETS).toBe(25);
    expect(MAX_CLIP_PACKETS).toBe(3000);
  });

  it('writes one clip of 30 packets with its duration, start offset and audio', async () => {
    clock = START + 5_000;
    await speak('u1', 30);

    const saved = await waitForClips(1);
    expect(receiver.subscribe).toHaveBeenCalledWith('u1', {
      end: { behavior: EndBehaviorType.AfterSilence, duration: CLIP_SILENCE_MS },
    });
    expect(saved.clips[0]).toMatchObject({ userId: 'u1', speakerName: 'Rahim', startMs: 5_000, durationMs: 600 });
    expect(await decodeOggOpusPackets(await store.readClip(meta.id, saved.clips[0]!))).toEqual(packets(30));
  });

  it('splits a long utterance into 60 s clips while it is still going, keeping every packet', async () => {
    clock = START + 5_000;
    const stream = await startSpeaking('u1');
    const all = packets(6_500);
    for (const p of all.slice(0, 3_000)) stream.write(p);

    // The first chunk is written before the speaker stops.
    const early = await waitForClips(1);
    expect(early.clips[0]).toMatchObject({ userId: 'u1', speakerName: 'Rahim', startMs: 5_000, durationMs: 60_000 });

    for (const p of all.slice(3_000)) stream.write(p);
    stream.end();

    const saved = await waitForClips(3);
    expect(saved.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [5_000, 60_000],
      [65_000, 60_000],
      [125_000, 10_000],
    ]);
    const decoded = await Promise.all(saved.clips.map(async (c) => decodeOggOpusPackets(await store.readClip(meta.id, c))));
    expect(decoded).toEqual([all.slice(0, 3_000), all.slice(3_000, 6_000), all.slice(6_000)]);
  });

  it('keeps a remainder shorter than MIN_CLIP_PACKETS after a long utterance was split', async () => {
    await speak('u1', 3_010);

    const saved = await waitForClips(2);
    expect(saved.clips.map((c) => [c.startMs, c.durationMs])).toEqual([
      [0, 60_000],
      [60_000, 200],
    ]);
  });

  it('writes nothing more when a long utterance ends exactly on a chunk boundary', async () => {
    await speak('u1', 3_000);
    await waitForClips(1);
    await recorder.stop();

    expect((await store.load(meta.id)).clips).toHaveLength(1);
  });

  it('drops an utterance shorter than MIN_CLIP_PACKETS', async () => {
    await speak('u1', 10);
    await recorder.stop();

    expect((await store.load(meta.id)).clips).toEqual([]);
  });

  it('keeps every packet of a first utterance even when the speaker lookup is slow', async () => {
    let finishLookup!: (s: { name: string; isBot: boolean }) => void;
    resolveSpeaker.mockImplementationOnce(() => new Promise((r) => (finishLookup = r)));

    receiver.speaking.emit('start', 'u1');
    expect(receiver.subscribe).toHaveBeenCalledTimes(1); // subscribed before the lookup resolves
    const stream = receiver.subscriptions.get('u1')!;
    for (const p of packets(30)) stream.write(p);
    stream.end();
    await new Promise((r) => setImmediate(r));
    finishLookup({ name: 'Rahim', isBot: false });

    const saved = await waitForClips(1);
    expect(saved.clips[0]).toMatchObject({ userId: 'u1', speakerName: 'Rahim', durationMs: 600 });
    expect(await decodeOggOpusPackets(await store.readClip(meta.id, saved.clips[0]!))).toEqual(packets(30));
  });

  it("discards a bot's audio, ends its stream, and then ignores the bot without a lookup", async () => {
    let finishLookup!: (s: { name: string; isBot: boolean }) => void;
    resolveSpeaker.mockImplementationOnce(() => new Promise((r) => (finishLookup = r)));
    receiver.speaking.emit('start', 'bot');
    const stream = receiver.subscriptions.get('bot')!;
    for (const p of packets(30)) stream.write(p);

    finishLookup({ name: 'Music Bot', isBot: true });
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    receiver.speaking.emit('start', 'bot');
    await recorder.stop();

    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
    expect(resolveSpeaker).toHaveBeenCalledTimes(1);
    expect((await store.load(meta.id)).clips).toEqual([]);
  });

  it('writes the clip as "Unknown speaker" with a warning when the lookup fails, and looks up again next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveSpeaker.mockRejectedValueOnce(new Error('member fetch failed'));

    await speak('u1', 30);
    await waitForClips(1);
    await speak('u1', 30);

    const saved = await waitForClips(2);
    expect(saved.clips.map((c) => c.speakerName)).toEqual(['Unknown speaker', 'Rahim']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('member fetch failed');
  });

  it('subscribes only once when start fires again while the user is subscribed', async () => {
    receiver.speaking.emit('start', 'u1');
    receiver.speaking.emit('start', 'u1'); // before the first bot check has resolved
    const stream = await startSpeaking('u1'); // again, once subscribed
    for (const p of packets(30)) stream.write(p);
    stream.end();

    await waitForClips(1);
    await recorder.stop();
    expect(receiver.subscribe).toHaveBeenCalledTimes(1);
    expect((await store.load(meta.id)).clips).toHaveLength(1);
  });

  it('keeps each clip under the name its speaker had then, and participants under the latest name', async () => {
    await speak('u1', 30);
    await waitForClips(1);
    names.u1 = { name: 'Rahim (PM)', isBot: false };
    clock = START + 60_000;
    await speak('u1', 30);

    const saved = await waitForClips(2);
    expect(saved.clips.map((c) => c.speakerName)).toEqual(['Rahim', 'Rahim (PM)']);
    expect(saved.participants).toEqual({ u1: 'Rahim (PM)' });
  });

  it('adds a late joiner to the participants with their first clip', async () => {
    await speak('u1', 30);
    await waitForClips(1);
    clock = START + 600_000;
    await speak('u2', 40);

    const saved = await waitForClips(2);
    expect(saved.participants).toEqual({ u1: 'Rahim', u2: 'Karim' });
    expect(saved.clips[1]).toMatchObject({ userId: 'u2', startMs: 600_000, durationMs: 800 });
  });

  it('stop() ends an active stream and resolves only after its clip is written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const writeClip = store.writeClip.bind(store);
    const writeSpy = vi.spyOn(store, 'writeClip').mockImplementation(async (...args) => {
      await gate;
      return writeClip(...args);
    });

    const stream = await startSpeaking('u1');
    for (const p of packets(30)) stream.write(p); // still speaking: stream not ended

    let stopped = false;
    const stopping = recorder.stop().then(() => (stopped = true));
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect((await store.load(meta.id)).clips).toHaveLength(1);
  });

  it('ignores speaking starts after stop()', async () => {
    await recorder.stop();
    receiver.speaking.emit('start', 'u1');
    await new Promise((r) => setImmediate(r));

    expect(resolveSpeaker).not.toHaveBeenCalled();
    expect(receiver.subscribe).not.toHaveBeenCalled();
  });

  it('logs a failed clip write without throwing, and keeps recording', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeClip = store.writeClip.bind(store);
    vi.spyOn(store, 'writeClip')
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation((...args) => writeClip(...args));

    await speak('u1', 30);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await speak('u2', 30);

    const saved = await waitForClips(1);
    expect(saved.clips[0]!.userId).toBe('u2');
    expect(String(error.mock.calls[0])).toContain('disk full');
  });
});
