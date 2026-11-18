import type { Speaker } from '../recording/recorder.js';
import { isFinished, type MeetingStore } from '../storage/meeting-store.js';

// ---- Fixed user-facing copy ----

export const joinFirstText = 'Join a voice channel first, then run /join.';
export const noReportChannelText =
  'This server has no report channel set up yet. Ask the bot owner to add it to REPORT_CHANNELS.';
export const alreadyRecordingText = (voiceChannelId: string) => `I'm already recording in <#${voiceChannelId}>.`;
export const notRecordingText = "I'm not recording right now.";
export const retryNothingText = "There's no unfinished meeting to retry.";
export const retryBusyText = 'That meeting is still being processed.';
export const joinStartedText = (vcId: string) => `🔴 Recording started in <#${vcId}>.`;
export const recordingNoticeText = (vcId: string, userId: string) =>
  `🔴 Recording started in <#${vcId}> by <@${userId}>. Everything said there will be transcribed and summarized.`;
export const processingText = (reportChannelId: string) =>
  `⏳ Processing the meeting… the report will be posted in <#${reportChannelId}>.`;
export const interruptedText = '⚠️ A recording was cut off by a bot restart. Run /retry to process what was recorded.';

// ---- Copy added for error paths ----

export const joinFailedText = (vcId: string) =>
  `I couldn't join <#${vcId}>. Check that I can see and connect to that channel, then try again.`;
export const noticeFailedText = (reportChannelId: string) =>
  `⚠️ I couldn't post the recording notice in <#${reportChannelId}>. Please tell the others they're being recorded, and check my permissions there.`;
export const retryNotFoundText = (meetingId: string) => `I couldn't find a meeting \`${meetingId}\` in this server.`;
export const processingFailedText = (meetingId: string) =>
  `⚠️ Processing meeting \`${meetingId}\` failed. Run /retry to try again.`;
export const genericErrorText = 'Something went wrong. Please try again.';

// ---- Decisions ----

export function checkJoin(p: {
  memberVoiceChannelId: string | null;
  hasReportChannel: boolean;
  active?: { voiceChannelId: string };
}): string | null {
  if (!p.memberVoiceChannelId) return joinFirstText;
  if (!p.hasReportChannel) return noReportChannelText;
  if (p.active) return alreadyRecordingText(p.active.voiceChannelId);
  return null;
}

export function checkStop(active?: object): string | null {
  return active ? null : notRecordingText;
}

/** Meeting ids are folder names created by MeetingStore; anything else (e.g. a path) is rejected. */
export function isValidMeetingId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export type RetryTarget = { ok: true; meetingId: string } | { ok: false; text: string };

/** Picks the meeting /retry should process: the given id (in this guild), or the latest unfinished one. */
export async function findRetryTarget(
  guildId: string,
  meetingId: string | null,
  store: Pick<MeetingStore, 'load' | 'findLatestUnfinished'>,
): Promise<RetryTarget> {
  if (meetingId === null) {
    const latest = await store.findLatestUnfinished(guildId);
    return latest ? { ok: true, meetingId: latest.id } : { ok: false, text: retryNothingText };
  }
  const notFound = { ok: false, text: retryNotFoundText(meetingId) } as const;
  if (!isValidMeetingId(meetingId)) return notFound;
  const meta = await store.load(meetingId).catch(() => undefined);
  if (!meta || meta.guildId !== guildId) return notFound;
  if (!meta.endedAt || isFinished(meta)) return { ok: false, text: retryNothingText };
  return { ok: true, meetingId: meta.id };
}

/** Number of non-bot members, e.g. of `voiceChannel.members.values()`. */
export function countHumans(members: Iterable<{ user: { bot: boolean } }>): number {
  let humans = 0;
  for (const m of members) if (!m.user.bot) humans++;
  return humans;
}

export interface SpeakerLookups {
  fetchMember(userId: string): Promise<{ displayName: string; user: { bot: boolean } }>;
  fetchUser(userId: string): Promise<{ globalName: string | null; username: string; bot: boolean }>;
}

/**
 * Resolves a speaker's display name. Members who left the server can't be fetched as members,
 * so this falls back to their global user. Throws only when both lookups fail.
 */
export async function resolveSpeaker(userId: string, lookups: SpeakerLookups): Promise<Speaker> {
  try {
    const member = await lookups.fetchMember(userId);
    return { name: member.displayName, isBot: member.user.bot };
  } catch {
    const user = await lookups.fetchUser(userId);
    return { name: user.globalName ?? user.username, isBot: user.bot };
  }
}

export interface ProcessSafelyDeps {
  process(meetingId: string): Promise<unknown>;
  guildIdOf(meetingId: string): Promise<string>;
  postText(guildId: string, text: string): Promise<void>;
  log?: (message: string, err: unknown) => void;
}

/** Processes a meeting; on failure logs it and tries to tell the report channel. Never throws. */
export async function processSafely(meetingId: string, deps: ProcessSafelyDeps): Promise<void> {
  const log = (message: string, err: unknown) => {
    try {
      (deps.log ?? console.error)(message, err);
    } catch {
      // nothing left to do
    }
  };
  try {
    await deps.process(meetingId);
    return;
  } catch (err) {
    log(`Processing meeting ${meetingId} failed:`, err);
  }
  let guildId: string;
  try {
    guildId = await deps.guildIdOf(meetingId);
  } catch (err) {
    log(`Could not find the guild of meeting ${meetingId} to report the failure:`, err);
    return;
  }
  try {
    await deps.postText(guildId, processingFailedText(meetingId));
  } catch (err) {
    log(`Posting the failure notice for meeting ${meetingId} failed:`, err);
  }
}
