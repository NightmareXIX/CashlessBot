import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceReceiverLike } from '../../src/recording/recorder.js';
import {
  SessionManager,
  type StopReason,
  type VoiceConnectionLike,
} from '../../src/recording/session-manager.js';
import { MeetingStore } from '../../src/storage/meeting-store.js';

class FakeReceiver implements VoiceReceiverLike {
  readonly speaking = new EventEmitter();
  readonly subscriptions = new Map<string, PassThrough>();
  subscribe(userId: string) {
    const stream = new PassThrough({ objectMode: true });
    stream.once('close', () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, stream);
    return stream;
  }
}

class FakeConnection implements VoiceConnectionLike {
  readonly receiver = new FakeReceiver();
  readonly destroy = vi.fn();
  lost?: () => void;
  onLost(cb: () => void) {
    this.lost = cb;
  }
}

const G = 'guild-1';
const VC = 'vc-1';
const TWO_HOURS = 7_200_000;

let root: string;
let store: MeetingStore;
let connections: FakeConnection[];
let connect: ReturnType<typeof vi.fn<(guildId: string, channelId: string) => Promise<VoiceConnectionLike>>>;
let resolveSpeaker: ReturnType<typeof vi.fn<(guildId: string, userId: string) => Promise<{ name: string; isBot: boolean }>>>;
let onStopped: ReturnType<typeof vi.fn<(meetingId: string, reason: StopReason) => void>>;
let manager: SessionManager;

const start = () => manager.start({ guildId: G, voiceChannelId: VC, voiceChannelName: 'General' });

async function startOk(): Promise<string> {
  const result = await start();
  if (!result.ok) throw new Error('expected the session to start');
  return result.meetingId;
}

/** Resolves with the next onStopped call. */
const nextStop = () =>
  new Promise<[string, StopReason]>((resolve) => onStopped.mockImplementationOnce((...args) => resolve(args)));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-03-04T05:06:07Z'));
  root = await mkdtemp(path.join(tmpdir(), 'session-manager-'));
  store = new MeetingStore(root);
  connections = [];
  connect = vi.fn(async () => {
    const connection = new FakeConnection();
    connections.push(connection);
    return connection;
  });
  resolveSpeaker = vi.fn(async (_guildId: string, userId: string) => ({ name: `Name of ${userId}`, isBot: false }));
  onStopped = vi.fn();
  manager = new SessionManager({ store, connect, resolveSpeaker, onStopped });
});

afterEach(async () => {
  await manager.stop(G, 'command');
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('starts a session: creates the meeting, connects, and records with guild-scoped speaker names', async () => {
    const meetingId = await startOk();
    expect(manager.get(G)).toEqual({ meetingId, voiceChannelId: VC });
    expect(connect).toHaveBeenCalledWith(G, VC);
    expect(await store.load(meetingId)).toMatchObject({
      guildId: G,
      voiceChannelId: VC,
      voiceChannelName: 'General',
      startedAt: '2026-03-04T05:06:07.000Z',
    });

    const receiver = connections[0]!.receiver;
    receiver.speaking.emit('start', 'u1');
    await vi.waitFor(() => expect(receiver.subscriptions.has('u1')).toBe(true));
    const stream = receiver.subscriptions.get('u1')!;
    for (let i = 0; i < 30; i++) stream.write(Buffer.from([0xfc, i]));

    expect(await manager.stop(G, 'command')).toBe(meetingId);
    expect(resolveSpeaker).toHaveBeenCalledWith(G, 'u1');
    expect((await store.load(meetingId)).clips).toMatchObject([{ userId: 'u1', speakerName: 'Name of u1' }]);
  });

  it('refuses a second start in the same guild with already-recording', async () => {
    await startOk();
    expect(await start()).toEqual({ ok: false, reason: 'already-recording', voiceChannelId: VC });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('lets only one of two concurrent starts in a guild through', async () => {
    const results = await Promise.all([start(), start()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'already-recording', voiceChannelId: VC }]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('on a failed connect, removes the meeting, frees the guild and rethrows', async () => {
    connect.mockRejectedValueOnce(new Error('join timed out'));
    await expect(start()).rejects.toThrow('join timed out');
    expect(manager.get(G)).toBeUndefined();
    expect(manager.isStarting(G)).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(onStopped).not.toHaveBeenCalled();

    await startOk();
  });

  it('rethrows the connect error even when removing the meeting fails, and logs the remove failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    connect.mockRejectedValueOnce(new Error('join timed out'));
    vi.spyOn(store, 'remove').mockRejectedValueOnce(new Error('EACCES'));

    await expect(start()).rejects.toThrow('join timed out');

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0])).toContain('EACCES');
    expect(manager.get(G)).toBeUndefined();
    error.mockRestore();
  });

  describe('stop signals while the join is in progress', () => {
    let finishConnect!: () => void;
    let connection: FakeConnection;

    /** Starts a session and waits until it is joining, with connect pending until finishConnect(). */
    async function startJoining(): Promise<{ starting: ReturnType<typeof start> }> {
      connection = new FakeConnection();
      connect.mockImplementationOnce(
        () => new Promise((resolve) => (finishConnect = () => resolve(connection))),
      );
      const starting = start();
      await vi.waitFor(() => expect(connect).toHaveBeenCalled());
      return { starting };
    }

    it('isStarting() is true only while the join is in progress', async () => {
      expect(manager.isStarting(G)).toBe(false);
      const { starting } = await startJoining();
      expect(manager.isStarting(G)).toBe(true);
      expect(manager.isStarting('other-guild')).toBe(false);
      expect(manager.get(G)).toBeUndefined();
      finishConnect();
      await starting;
      expect(manager.isStarting(G)).toBe(false);
      expect(manager.get(G)).toBeDefined();
    });

    it('activeGuildIds() lists guilds that are joining or recording', async () => {
      expect(manager.activeGuildIds()).toEqual([]);
      const { starting } = await startJoining();
      expect(manager.activeGuildIds()).toEqual([G]);
      finishConnect();
      await starting;
      expect(manager.activeGuildIds()).toEqual([G]);
      await manager.stop(G, 'command');
      expect(manager.activeGuildIds()).toEqual([]);
    });

    it('stops with empty-channel right after connecting when the channel emptied during the join', async () => {
      const { starting } = await startJoining();
      const stopped = nextStop();

      manager.handleHumanCount(G, VC, 0);
      await new Promise((r) => setImmediate(r));
      expect(onStopped).not.toHaveBeenCalled();
      finishConnect();

      const result = await starting;
      expect(result.ok).toBe(true);
      const meetingId = result.ok ? result.meetingId : '';
      expect(await stopped).toEqual([meetingId, 'empty-channel']);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
      expect(manager.get(G)).toBeUndefined();
    });

    it('stop() during the join stops the session once it connects, under the first requested reason', async () => {
      const { starting } = await startJoining();

      const stopping = manager.stop(G, 'command');
      manager.handleHumanCount(G, VC, 0); // a later stop signal does not change the reason
      finishConnect();

      const result = await starting;
      expect(await stopping).toBe(result.ok ? result.meetingId : 'not ok');
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(onStopped).toHaveBeenCalledWith(result.ok && result.meetingId, 'command');
    });

    it('keeps recording when a human comes back before the join completes', async () => {
      const { starting } = await startJoining();

      manager.handleHumanCount(G, VC, 0);
      manager.handleHumanCount(G, VC, 1);
      finishConnect();
      await starting;
      await new Promise((r) => setImmediate(r));

      expect(connection.destroy).not.toHaveBeenCalled();
      expect(onStopped).not.toHaveBeenCalled();
    });

    it('ignores an empty count for another channel during the join', async () => {
      const { starting } = await startJoining();

      manager.handleHumanCount(G, 'other-vc', 0);
      finishConnect();
      await starting;
      await new Promise((r) => setImmediate(r));

      expect(connection.destroy).not.toHaveBeenCalled();
    });
  });

  it('stops with empty-channel when the active channel has no humans left', async () => {
    const meetingId = await startOk();
    const stopped = nextStop();
    vi.setSystemTime(new Date('2026-03-04T05:36:07Z'));

    manager.handleHumanCount(G, VC, 0);

    expect(await stopped).toEqual([meetingId, 'empty-channel']);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(manager.get(G)).toBeUndefined();
    expect(await store.load(meetingId)).toMatchObject({
      endedAt: '2026-03-04T05:36:07.000Z',
      stopReason: 'empty-channel',
    });
  });

  it('keeps recording while a human remains, and ignores counts for other channels', async () => {
    const meetingId = await startOk();

    manager.handleHumanCount(G, VC, 1);
    manager.handleHumanCount(G, 'other-vc', 0);
    manager.handleHumanCount('other-guild', VC, 0);

    expect(connections[0]!.destroy).not.toHaveBeenCalled();
    expect(manager.get(G)).toEqual({ meetingId, voiceChannelId: VC });
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('stops with max-duration after 2 hours', async () => {
    const meetingId = await startOk();
    const stopped = nextStop();

    await vi.advanceTimersByTimeAsync(TWO_HOURS - 1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await stopped).toEqual([meetingId, 'max-duration']);
    expect((await store.load(meetingId)).stopReason).toBe('max-duration');
  });

  it('stops with disconnected when the connection is lost, saving endedAt', async () => {
    const meetingId = await startOk();
    const stopped = nextStop();

    connections[0]!.lost!();

    expect(await stopped).toEqual([meetingId, 'disconnected']);
    expect(await store.load(meetingId)).toMatchObject({
      endedAt: '2026-03-04T05:06:07.000Z',
      stopReason: 'disconnected',
    });
  });

  it('stops only once for concurrent stop calls', async () => {
    const meetingId = await startOk();

    const results = await Promise.all([manager.stop(G, 'command'), manager.stop(G, 'empty-channel')]);

    expect(results).toEqual([meetingId, meetingId]);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith(meetingId, 'command');
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(await manager.stop(G, 'command')).toBeUndefined();
  });

  it('clears the max-duration timer on stop', async () => {
    await startOk();
    expect(vi.getTimerCount()).toBe(1);

    await manager.stop(G, 'command');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TWO_HOURS);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});
