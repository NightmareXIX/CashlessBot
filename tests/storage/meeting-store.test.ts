import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingStore, isFinished } from '../../src/storage/meeting-store.js';

let root: string;
let store: MeetingStore;

const init = (over: Partial<{ guildId: string; startedAt: Date }> = {}) => ({
  guildId: '123456789012345678',
  voiceChannelId: 'v1',
  voiceChannelName: 'General',
  startedAt: new Date('2026-03-04T05:06:07Z'),
  ...over,
});

const clipInput = (userId = 'u1', speakerName = 'Alice') => ({
  userId,
  speakerName,
  startMs: 0,
  durationMs: 1000,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'meeting-store-'));
  store = new MeetingStore(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('MeetingStore', () => {
  it('creates a meeting with a UTC id, pending steps and a clips folder, and load round-trips it', async () => {
    const meta = await store.create(init());
    expect(meta.id).toBe('2026-03-04_05-06-07_5678');
    expect(meta.startedAt).toBe('2026-03-04T05:06:07.000Z');
    expect(meta.steps).toEqual({ transcribe: 'pending', summarize: 'pending', report: 'pending' });
    expect(meta.clips).toEqual([]);
    expect(meta.batches).toEqual([]);
    expect(meta.segments).toEqual([]);
    expect(meta.participants).toEqual({});
    expect((await stat(path.join(store.meetingDir(meta.id), 'clips'))).isDirectory()).toBe(true);
    expect(await store.load(meta.id)).toEqual(meta);
  });

  it('saves atomically and leaves no .tmp file behind', async () => {
    const meta = await store.create(init());
    meta.reportMessageId = 'm1';
    await store.save(meta);
    const files = await readdir(store.meetingDir(meta.id));
    expect(files).toContain('meta.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await store.load(meta.id)).reportMessageId).toBe('m1');
  });

  it('serializes 20 concurrent writeClip calls', async () => {
    const meta = await store.create(init());
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.writeClip(meta.id, { ...clipInput('u1'), startMs: i * 1000 }, Buffer.from(`clip-${i}`)),
      ),
    );
    const ids = results.map((c) => c.id).sort();
    const expected = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(4, '0')}`);
    expect(ids).toEqual(expected);
    const loaded = await store.load(meta.id);
    expect(loaded.clips.map((c) => c.id).sort()).toEqual(expected);
    expect(await readdir(path.join(store.meetingDir(meta.id), 'clips'))).toHaveLength(20);
    for (const clip of results) {
      const i = clip.startMs / 1000;
      expect((await store.readClip(meta.id, clip)).toString()).toBe(`clip-${i}`);
    }
  });

  it('reports clip size', async () => {
    const meta = await store.create(init());
    const clip = await store.writeClip(meta.id, clipInput(), Buffer.alloc(42));
    expect(await store.clipSize(meta.id, clip)).toBe(42);
  });

  it('tracks participants and keeps the speakerName each clip was spoken with', async () => {
    const meta = await store.create(init());
    await store.writeClip(meta.id, clipInput('u1', 'Alice'), Buffer.from('a'));
    await store.writeClip(meta.id, clipInput('u2', 'Bob'), Buffer.from('b'));
    await store.writeClip(meta.id, clipInput('u1', 'Ally'), Buffer.from('c'));
    const loaded = await store.load(meta.id);
    expect(loaded.participants).toEqual({ u1: 'Ally', u2: 'Bob' });
    expect(loaded.clips.map((c) => c.speakerName)).toEqual(['Alice', 'Bob', 'Ally']);
  });

  it('update applies fn, saves and returns the new meta', async () => {
    const meta = await store.create(init());
    const updated = await store.update(meta.id, (m) => {
      m.steps.transcribe = 'done';
    });
    expect(updated.steps.transcribe).toBe('done');
    expect((await store.load(meta.id)).steps.transcribe).toBe('done');
  });

  it('findLatestUnfinished ignores recording and finished meetings and returns the newest of the rest', async () => {
    const mk = async (startedAt: string, guildId = '1111') => store.create(init({ guildId, startedAt: new Date(startedAt) }));
    const end = (id: string, finished = false) =>
      store.update(id, (m) => {
        m.endedAt = m.startedAt;
        if (finished) {
          m.steps = { transcribe: 'done', summarize: 'done', report: 'done' };
          m.reportComplete = true;
        }
      });

    const old = await mk('2026-03-01T00:00:00Z');
    await end(old.id);
    const newer = await mk('2026-03-02T00:00:00Z');
    await end(newer.id);
    const finished = await mk('2026-03-03T00:00:00Z');
    await end(finished.id, true);
    await mk('2026-03-04T00:00:00Z'); // still recording
    const otherGuild = await mk('2026-03-05T00:00:00Z', '9999');
    await end(otherGuild.id);

    expect((await store.findLatestUnfinished('1111'))?.id).toBe(newer.id);
    expect(await store.findLatestUnfinished('4242')).toBeUndefined();
  });

  it('markInterrupted ends un-ended meetings and leaves ended ones untouched', async () => {
    const open = await store.create(init({ startedAt: new Date('2026-03-01T00:00:00Z') }));
    await store.writeClip(open.id, { ...clipInput(), startMs: 5000, durationMs: 2000 }, Buffer.from('x'));
    const emptyOpen = await store.create(init({ startedAt: new Date('2026-03-02T00:00:00Z') }));
    const ended = await store.create(init({ startedAt: new Date('2026-03-03T00:00:00Z') }));
    await store.update(ended.id, (m) => {
      m.endedAt = '2026-03-03T01:00:00.000Z';
      m.stopReason = 'command';
    });

    const result = await store.markInterrupted();
    expect(result.map((m) => m.id).sort()).toEqual([open.id, emptyOpen.id].sort());

    const a = await store.load(open.id);
    expect(a.stopReason).toBe('interrupted');
    expect(a.endedAt).toBe('2026-03-01T00:00:07.000Z');
    const b = await store.load(emptyOpen.id);
    expect(b.stopReason).toBe('interrupted');
    expect(b.endedAt).toBe(emptyOpen.startedAt);
    const c = await store.load(ended.id);
    expect(c.stopReason).toBe('command');
    expect(c.endedAt).toBe('2026-03-03T01:00:00.000Z');
  });

  it('create does not overwrite an existing meeting and appends -2, -3 to the id', async () => {
    const a = await store.create(init());
    await store.writeClip(a.id, clipInput(), Buffer.from('keep'));
    const b = await store.create(init());
    const c = await store.create(init());
    expect(b.id).toBe(`${a.id}-2`);
    expect(c.id).toBe(`${a.id}-3`);
    expect((await store.load(a.id)).clips).toHaveLength(1);
    expect(await store.load(b.id)).toEqual(b);
  });

  it('create gives unique ids to concurrent starts in the same second', async () => {
    const metas = await Promise.all(Array.from({ length: 5 }, () => store.create(init())));
    expect(new Set(metas.map((m) => m.id)).size).toBe(5);
  });

  it('list skips corrupt or missing meta.json and warns with the id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = await store.create(init({ startedAt: new Date('2026-03-01T00:00:00Z') }));
    await mkdir(path.join(root, 'bad-json'));
    await writeFile(path.join(root, 'bad-json', 'meta.json'), '{ not json');
    await mkdir(path.join(root, 'bad-shape'));
    await writeFile(path.join(root, 'bad-shape', 'meta.json'), 'null');
    await mkdir(path.join(root, 'no-meta'));

    expect((await store.list()).map((m) => m.id)).toEqual([good.id]);
    const warned = warn.mock.calls.map((c) => String(c[0]));
    for (const id of ['bad-json', 'bad-shape', 'no-meta']) {
      expect(warned.some((w) => w.includes(id))).toBe(true);
    }
    expect(await store.markInterrupted()).toHaveLength(1);
  });

  it('list returns all meetings', async () => {
    const a = await store.create(init({ startedAt: new Date('2026-03-01T00:00:00Z') }));
    const b = await store.create(init({ startedAt: new Date('2026-03-02T00:00:00Z') }));
    expect((await store.list()).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('remove deletes a meeting folder with its clips and leaves other meetings', async () => {
    const a = await store.create(init({ startedAt: new Date('2026-03-01T00:00:00Z') }));
    const b = await store.create(init({ startedAt: new Date('2026-03-02T00:00:00Z') }));
    await store.writeClip(a.id, clipInput(), Buffer.from('audio'));

    await store.remove(a.id);

    expect(await readdir(root)).toEqual([b.id]);
  });
});

describe('isFinished', () => {
  it('requires all steps done and reportComplete', async () => {
    const m = await store.create(init());
    expect(isFinished(m)).toBe(false);
    m.steps = { transcribe: 'done', summarize: 'done', report: 'done' };
    expect(isFinished(m)).toBe(false);
    m.reportComplete = true;
    expect(isFinished(m)).toBe(true);
    m.steps.summarize = 'failed';
    expect(isFinished(m)).toBe(false);
  });
});
