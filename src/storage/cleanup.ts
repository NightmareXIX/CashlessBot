import { rm } from 'node:fs/promises';
import { isFinished, type MeetingStore } from './meeting-store.js';

const DAY_MS = 86_400_000;

/** Deletes finished meetings that ended more than maxAgeDays before now; returns their ids. */
export async function cleanupOldMeetings(store: MeetingStore, now: Date, maxAgeDays = 7): Promise<string[]> {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  const removed: string[] = [];
  for (const m of await store.list()) {
    if (!m.endedAt || !isFinished(m) || Date.parse(m.endedAt) >= cutoff) continue;
    await rm(store.meetingDir(m.id), { recursive: true, force: true });
    removed.push(m.id);
  }
  return removed;
}
