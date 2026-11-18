import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { EndBehaviorType } from '@discordjs/voice';
import { encodeOggOpus, FRAME_MS } from '../audio/ogg.js';
import type { MeetingStore } from '../storage/meeting-store.js';
import type { MeetingMeta } from '../types.js';

/** A clip ends after this much silence from its speaker. */
export const CLIP_SILENCE_MS = 1000;
/** Utterances shorter than this many packets (25 × 20 ms = 0.5 s) are dropped. */
export const MIN_CLIP_PACKETS = 25;

/** The parts of @discordjs/voice's VoiceReceiver the recorder uses. */
export interface VoiceReceiverLike {
  /** Emits 'start'(userId) when a user begins speaking. */
  speaking: EventEmitter;
  /** Returns a stream of raw (already decrypted) Opus packets from the user. */
  subscribe(userId: string, opts: { end: { behavior: EndBehaviorType; duration: number } }): Readable;
  subscriptions: Map<string, unknown>;
}

export interface Speaker {
  name: string;
  isBot: boolean;
}

export interface MeetingRecorderDeps {
  store: MeetingStore;
  resolveSpeaker(userId: string): Promise<Speaker>;
  now?: () => number;
}

/** Records each speaker's utterances in a meeting as separate Ogg/Opus clips. */
export class MeetingRecorder {
  private stopping = false;
  /** Users with a capture in progress, from their speaking start until their stream closes. */
  private readonly capturing = new Set<string>();
  private readonly streams = new Set<Readable>();
  private readonly pending = new Set<Promise<void>>();
  private readonly botCache = new Map<string, boolean>();
  private readonly startedAtMs: number;
  private readonly now: () => number;

  constructor(
    private readonly meta: MeetingMeta,
    private readonly receiver: VoiceReceiverLike,
    private readonly deps: MeetingRecorderDeps,
  ) {
    this.startedAtMs = Date.parse(meta.startedAt);
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.receiver.speaking.on('start', this.onSpeakingStart);
  }

  /** Stops listening, ends the active streams and waits until every pending clip is written. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.receiver.speaking.off('start', this.onSpeakingStart);
    for (const stream of this.streams) stream.destroy();
    await Promise.all(this.pending);
  }

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.stopping || this.capturing.has(userId) || this.receiver.subscriptions.has(userId)) return;
    this.capturing.add(userId);
    const task = this.capture(userId, this.now() - this.startedAtMs)
      .catch((err: unknown) => console.error(`Recording clip for user ${userId} in meeting ${this.meta.id} failed:`, err))
      .finally(() => {
        this.capturing.delete(userId);
        this.pending.delete(task);
      });
    this.pending.add(task);
  };

  private async capture(userId: string, startMs: number): Promise<void> {
    if (await this.isBot(userId)) return;
    if (this.stopping) return;

    const stream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: CLIP_SILENCE_MS },
    });
    this.streams.add(stream);
    const packets = await collectPackets(stream, userId);
    this.streams.delete(stream);
    this.capturing.delete(userId);

    if (packets.length < MIN_CLIP_PACKETS) return;
    const speaker = await this.deps.resolveSpeaker(userId);
    const data = await encodeOggOpus(packets);
    await this.deps.store.writeClip(
      this.meta.id,
      { userId, speakerName: speaker.name, startMs, durationMs: packets.length * FRAME_MS },
      data,
    );
  }

  private async isBot(userId: string): Promise<boolean> {
    const cached = this.botCache.get(userId);
    if (cached !== undefined) return cached;
    const { isBot } = await this.deps.resolveSpeaker(userId);
    this.botCache.set(userId, isBot);
    return isBot;
  }
}

/** Collects packets until the stream ends, closes or errors; on error keeps what arrived. */
function collectPackets(stream: Readable, userId: string): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const packets: Buffer[] = [];
    const done = () => resolve(packets);
    stream.on('data', (packet: Buffer) => packets.push(packet));
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', (err) => {
      console.error(`Audio stream for user ${userId} failed:`, err);
      done();
    });
  });
}
