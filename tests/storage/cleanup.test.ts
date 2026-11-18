import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupOldMeetings } from '../../src/storage/cleanup.js';
import { MeetingStore } from '../../src/storage/meeting-store.js';

const DAY = 86_400_000;
const now = new Date('2026-06-30T12:00:00Z');

let root: string;
let store: MeetingStore;

const exists = (p: string) => access(p).then(() => true, () => false);

async function seed(guildId: string, endedDaysAgo: number, finished: boolean) {
  const endedAt = new Date(now.getTime() - endedDaysAgo * DAY);
  const meta = await store.create({
    guildId,
    voiceChannelId: 'v1',
    voiceChannelName: 'General',
    startedAt: new Date(endedAt.getTime() - 3600_000),
  });
  await store.update(meta.id, (m) => {
    m.endedAt = endedAt.toISOString();
    if (finished) {
      m.steps = { transcribe: 'done', summarize: 'done', report: 'done' };
      m.reportComplete = true;
    }
  });
  return meta.id;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cleanup-'));
  store = new MeetingStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('cleanupOldMeetings', () => {
  it('deletes finished meetings older than 7 days and keeps the rest', async () => {
    const old = await seed('1001', 8, true);
    const recent = await seed('1002', 6, true);
    const unfinished = await seed('1003', 30, false);

    const removed = await cleanupOldMeetings(store, now);

    expect(removed).toEqual([old]);
    expect(await exists(store.meetingDir(old))).toBe(false);
    expect(await exists(store.meetingDir(recent))).toBe(true);
    expect(await exists(store.meetingDir(unfinished))).toBe(true);
  });

  it('honours a custom maxAgeDays', async () => {
    const id = await seed('1001', 3, true);
    expect(await cleanupOldMeetings(store, now, 2)).toEqual([id]);
  });
});
