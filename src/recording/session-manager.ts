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

/** Runs at most one recording session per guild and stops it on command or automatically. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** Guilds whose session is still being set up, mapped to the channel being joined. */
  private readonly starting = new Map<string, string>();
  private readonly maxDurationMs: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxDurationMs = deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  }

  async start(p: { guildId: string; voiceChannelId: string; voiceChannelName: string }): Promise<StartResult> {
    const { guildId, voiceChannelId } = p;
    const busyChannel = this.sessions.get(guildId)?.voiceChannelId ?? this.starting.get(guildId);
    if (busyChannel !== undefined) return { ok: false, reason: 'already-recording', voiceChannelId: busyChannel };

    this.starting.set(guildId, voiceChannelId);
    try {
      const meta = await this.deps.store.create({ ...p, startedAt: new Date() });
      let connection: VoiceConnectionLike;
      try {
        connection = await this.deps.connect(guildId, voiceChannelId);
      } catch (err) {
        await this.deps.store.update(meta.id, (m) => {
          m.endedAt = m.startedAt;
          m.stopReason = 'disconnected';
        });
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
      return { ok: true, meetingId: meta.id };
    } finally {
      this.starting.delete(guildId);
    }
  }

  /** Stops the guild's session and returns its meeting id. Concurrent calls share one stop. */
  stop(guildId: string, reason: StopReason): Promise<string | undefined> {
    const session = this.sessions.get(guildId);
    if (!session) return Promise.resolve(undefined);
    session.stopping ??= this.finish(guildId, session, reason);
    return session.stopping;
  }

  get(guildId: string): { meetingId: string; voiceChannelId: string } | undefined {
    const session = this.sessions.get(guildId);
    return session && { meetingId: session.meetingId, voiceChannelId: session.voiceChannelId };
  }

  handleHumanCount(guildId: string, channelId: string, humans: number): void {
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
