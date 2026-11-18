import type { MeetingStore } from '../storage/meeting-store.js';
import { MeetingRecorder, type Speaker, type VoiceReceiverLike } from './recorder.js';

export type StopReason = 'command' | 'empty-channel' | 'max-duration' | 'disconnected';

/** A live voice connection, as the session manager needs it. */
export interface VoiceConnectionLike {
  receiver: VoiceReceiverLike;
  /** Registers a callback for when the connection is lost for good (not via destroy()). */
  onLost(cb: () => void): void;
  destroy(): void;
}

export interface SessionManagerDeps {
  store: MeetingStore;
  connect(guildId: string, channelId: string): Promise<VoiceConnectionLike>;
  resolveSpeaker(guildId: string, userId: string): Promise<Speaker>;
  onStopped(meetingId: string, reason: StopReason): void;
  maxDurationMs?: number;
}

export type StartResult =
  | { ok: true; meetingId: string }
  | { ok: false; reason: 'already-recording'; voiceChannelId: string };

const DEFAULT_MAX_DURATION_MS = 7_200_000;

interface Session {
  meetingId: string;
  voiceChannelId: string;
  connection: VoiceConnectionLike;
  recorder: MeetingRecorder;
  timer: NodeJS.Timeout;
  stopping?: Promise<string>;
}

/** A session still being set up (meeting created, voice connection pending). */
interface PendingStart {
  voiceChannelId: string;
  /** A stop requested during the join, applied as soon as the session exists. */
  stopReason?: StopReason;
  /** Settles when the start finishes, whether or not it succeeded. */
  settled: Promise<void>;
}

/** Runs at most one recording session per guild and stops it on command or automatically. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, PendingStart>();
  private readonly maxDurationMs: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxDurationMs = deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  }

  async start(p: { guildId: string; voiceChannelId: string; voiceChannelName: string }): Promise<StartResult> {
    const { guildId, voiceChannelId } = p;
    const busyChannel = (this.sessions.get(guildId) ?? this.starting.get(guildId))?.voiceChannelId;
    if (busyChannel !== undefined) return { ok: false, reason: 'already-recording', voiceChannelId: busyChannel };

    let settle!: () => void;
    const pending: PendingStart = { voiceChannelId, settled: new Promise((resolve) => (settle = resolve)) };
    this.starting.set(guildId, pending);
    try {
      const meta = await this.deps.store.create({ ...p, startedAt: new Date() });
      let connection: VoiceConnectionLike;
      try {
        connection = await this.deps.connect(guildId, voiceChannelId);
      } catch (err) {
        // Nothing was recorded, so leave nothing for /retry; the connect error is what the caller needs.
        await this.deps.store.remove(meta.id).catch((removeErr: unknown) =>
          console.error(`Removing meeting ${meta.id} after a failed join failed:`, removeErr),
        );
        throw err;
      }

      const recorder = new MeetingRecorder(meta, connection.receiver, {
        store: this.deps.store,
        resolveSpeaker: (userId) => this.deps.resolveSpeaker(guildId, userId),
      });
      recorder.start();
      const timer = setTimeout(() => this.autoStop(guildId, 'max-duration'), this.maxDurationMs);
      this.sessions.set(guildId, { meetingId: meta.id, voiceChannelId, connection, recorder, timer });
      connection.onLost(() => this.autoStop(guildId, 'disconnected'));
      if (pending.stopReason) this.autoStop(guildId, pending.stopReason);
      return { ok: true, meetingId: meta.id };
    } finally {
      this.starting.delete(guildId);
      settle();
    }
  }

  /**
   * Stops the guild's session and returns its meeting id. Concurrent calls share one stop.
   * During a join, the stop is applied once the session exists (undefined if the join fails).
   */
  stop(guildId: string, reason: StopReason): Promise<string | undefined> {
    const session = this.sessions.get(guildId);
    if (session) {
      session.stopping ??= this.finish(guildId, session, reason);
      return session.stopping;
    }
    const pending = this.starting.get(guildId);
    if (!pending) return Promise.resolve(undefined);
    pending.stopReason ??= reason;
    return pending.settled.then(() => this.stop(guildId, reason));
  }

  get(guildId: string): { meetingId: string; voiceChannelId: string } | undefined {
    const session = this.sessions.get(guildId);
    return session && { meetingId: session.meetingId, voiceChannelId: session.voiceChannelId };
  }

  handleHumanCount(guildId: string, channelId: string, humans: number): void {
    const pending = this.starting.get(guildId);
    if (pending?.voiceChannelId === channelId) {
      // Joining: remember an emptied channel, and forget it if someone comes back before the join completes.
      if (humans === 0) pending.stopReason ??= 'empty-channel';
      else if (pending.stopReason === 'empty-channel') pending.stopReason = undefined;
      return;
    }
    if (humans === 0 && this.sessions.get(guildId)?.voiceChannelId === channelId) {
      this.autoStop(guildId, 'empty-channel');
    }
  }

  private autoStop(guildId: string, reason: StopReason): void {
    this.stop(guildId, reason).catch((err: unknown) =>
      console.error(`Stopping the recording in guild ${guildId} (${reason}) failed:`, err),
    );
  }

  private async finish(guildId: string, session: Session, reason: StopReason): Promise<string> {
    const endedAt = new Date().toISOString();
    clearTimeout(session.timer);
    try {
      // recorder.stop() ends its streams synchronously, so the bot leaves the channel right away
      // while the last clips are still being written.
      const recorderStopped = session.recorder.stop();
      session.connection.destroy();
      await recorderStopped;
      await this.deps.store.update(session.meetingId, (m) => {
        m.endedAt = endedAt;
        m.stopReason = reason;
      });
    } finally {
      this.sessions.delete(guildId);
    }
    this.deps.onStopped(session.meetingId, reason);
    return session.meetingId;
  }
}
