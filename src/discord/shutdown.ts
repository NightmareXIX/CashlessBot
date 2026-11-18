import { interruptedText, processingInterruptedText } from './handlers.js';
import type { RunOnce } from './run-once.js';

export interface ShutdownDeps {
  /** Guilds with a recording session that is active or still joining. */
  activeGuildIds(): string[];
  /** Stops the guild's session (saving its audio); the meeting id, or undefined if nothing was recorded. */
  stop(guildId: string): Promise<string | undefined>;
  processing: Pick<RunOnce, 'running' | 'settled'>;
  /** How long to let in-flight processing finish. */
  waitMs: number;
  guildIdOf(meetingId: string): Promise<string>;
  postText(guildId: string, text: string): Promise<void>;
  log?: (message: string, err: unknown) => void;
}

/**
 * Before the bot exits: stops active recordings so their audio is saved, gives in-flight
 * processing up to waitMs to finish, and tells each affected guild to /retry after the restart.
 * Never throws.
 */
export async function saveAndFlagForShutdown(deps: ShutdownDeps): Promise<void> {
  const log = (message: string, err: unknown) => {
    try {
      (deps.log ?? console.error)(message, err);
    } catch {
      // nothing left to do
    }
  };
  const notices: Promise<void>[] = [];
  const notify = (guildId: string, text: string) =>
    notices.push(
      deps.postText(guildId, text).catch((err: unknown) => log(`Posting the shutdown notice in guild ${guildId} failed:`, err)),
    );

  let guildIds: string[] = [];
  try {
    guildIds = deps.activeGuildIds();
  } catch (err) {
    log('Listing the active recordings failed:', err);
  }
  const stopping = guildIds.map(async (guildId) => {
    try {
      // The recording isn't processed now (we're exiting), so ask for a /retry after the restart.
      if ((await deps.stop(guildId)) !== undefined) notify(guildId, interruptedText);
    } catch (err) {
      log(`Stopping the recording in guild ${guildId} failed:`, err);
    }
  });
  await Promise.all([...stopping, deps.processing.settled(deps.waitMs).catch(() => undefined)]);

  // Processing still running will be cut off; its progress is saved, so /retry can finish it.
  const flagged = new Set<string>();
  await Promise.all(
    deps.processing.running().map(async (meetingId) => {
      try {
        const guildId = await deps.guildIdOf(meetingId);
        if (flagged.has(guildId)) return;
        flagged.add(guildId);
        notify(guildId, processingInterruptedText);
      } catch (err) {
        log(`Could not find the guild of meeting ${meetingId} to flag its processing:`, err);
      }
    }),
  );
  await Promise.all(notices);
}
