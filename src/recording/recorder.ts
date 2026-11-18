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
/**
 * Longest clip in packets (3000 × 20 ms = 60 s). A longer utterance (e.g. an open mic that is
 * never silent for a second) is written in chunks while it goes on, so memory use and clip size
 * stay bounded and a crash loses at most one chunk.
 */
export const MAX_CLIP_PACKETS = 3000;
/** Speaker name used when the name lookup fails, so the clip is still kept. */
export const UNKNOWN_SPEAKER = 'Unknown speaker';

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
  private readonly streams = new Set<Readable>();
  private readonly pending = new Set<Promise<void>>();
  /** Users found to be bots; they are ignored without subscribing. */
  private readonly knownBots = new Set<string>();
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
    if (this.stopping || this.knownBots.has(userId) || this.receiver.subscriptions.has(userId)) return;
    // Subscribe at once so no packet is lost while the speaker is looked up.
    const stream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: CLIP_SILENCE_MS },
    });
    const task = this.capture(userId, this.now() - this.startedAtMs, stream)
      .catch((err: unknown) => console.error(`Recording clip for user ${userId} in meeting ${this.meta.id} failed:`, err))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  };

  private async capture(userId: string, startMs: number, stream: Readable): Promise<void> {
    this.streams.add(stream);
    const lookup = this.lookUpSpeaker(userId).then((speaker) => {
      if (speaker.isBot) stream.destroy(); // stop buffering a bot's audio right away
      return speaker;
    });

    // Chunks are written one after another so their clip ids stay in time order.
    let chunksWritten = 0;
    let writes: Promise<void> = Promise.resolve();
    const flush = (packets: Buffer[]) => {
      const chunkStartMs = startMs + chunksWritten * MAX_CLIP_PACKETS * FRAME_MS;
      chunksWritten++;
      writes = writes
        .then(() => this.writeClip(userId, chunkStartMs, packets, lookup))
        .catch((err: unknown) => console.error(`Recording clip for user ${userId} in meeting ${this.meta.id} failed:`, err));
    };

    let current: Buffer[] = [];
    await collectPackets(stream, userId, (packet) => {
      current.push(packet);
      if (current.length >= MAX_CLIP_PACKETS) {
        flush(current);
        current = [];
      }
    });
    this.streams.delete(stream);

    // A short utterance is dropped, but the tail of a split one is always kept.
    if (current.length >= MIN_CLIP_PACKETS || (chunksWritten > 0 && current.length > 0)) flush(current);
    await lookup;
    await writes;
  }

  private async writeClip(userId: string, startMs: number, packets: Buffer[], lookup: Promise<Speaker>): Promise<void> {
    const speaker = await lookup;
    if (speaker.isBot) return;
    const data = await encodeOggOpus(packets);
    await this.deps.store.writeClip(
      this.meta.id,
      { userId, speakerName: speaker.name, startMs, durationMs: packets.length * FRAME_MS },
      data,
    );
  }

  /** Resolves the speaker; on failure logs a warning and treats them as a human named UNKNOWN_SPEAKER. */
  private async lookUpSpeaker(userId: string): Promise<Speaker> {
    try {
      const speaker = await this.deps.resolveSpeaker(userId);
      if (speaker.isBot) this.knownBots.add(userId);
      return speaker;
    } catch (err) {
      console.warn(`Could not look up speaker ${userId} in meeting ${this.meta.id}; using "${UNKNOWN_SPEAKER}":`, err);
      return { name: UNKNOWN_SPEAKER, isBot: false };
    }
  }
}

/** Passes each packet to `onPacket` until the stream ends, closes or errors; on error keeps what arrived. */
function collectPackets(stream: Readable, userId: string, onPacket: (packet: Buffer) => void): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    stream.on('data', onPacket);
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', (err) => {
      console.error(`Audio stream for user ${userId} failed:`, err);
      done();
    });
  });
}
