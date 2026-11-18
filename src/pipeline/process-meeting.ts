import { buildErrorText, buildReportMessages } from '../report/report-format.js';
import {
  buildTranscriptLines,
  renderTranscriptFile,
  renderTranscriptLines,
  transcriptFileName,
} from '../report/transcript.js';
import { isFinished, type MeetingStore } from '../storage/meeting-store.js';
import { planBatches } from '../transcription/batching.js';
import { transcribeBatch } from '../transcription/transcribe-batch.js';
import type { MeetingMeta, MeetingSummary, ReportPoster, Summarizer, Transcriber } from '../types.js';
import { withRetry } from '../util/retry.js';

export const NOTE_SUMMARY_FAILED = 'Summary failed — run /retry to try again.';
export const NOTE_SUMMARY_STALE = 'Summary is from before missing audio was recovered — run /retry to refresh it.';
export const NOTE_GAPS = 'Some audio could not be transcribed (marked in the transcript). Run /retry to try again.';
export const NO_SPEECH_TEXT = 'No speech was recorded in this meeting.';

export interface ProcessMeetingDeps {
  store: MeetingStore;
  transcribers: { primary: Transcriber; fallback?: Transcriber };
  summarizers: { primary: Summarizer; fallback?: Summarizer };
  poster: ReportPoster;
  timezone: string;
  retry?: typeof withRetry;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Transcribes, summarizes and reports a recorded meeting. Progress is saved
 * after every step, so running it again (/retry) resumes where it stopped and
 * never redoes work that already succeeded. New work resets the later steps to
 * 'pending' in the same save, so a crash before they run can't lose the update.
 */
export async function processMeeting(meetingId: string, deps: ProcessMeetingDeps): Promise<MeetingMeta> {
  const { store, poster, timezone: tz } = deps;
  const retry = deps.retry ?? withRetry;
  let meta = await store.load(meetingId);
  if (isFinished(meta)) return meta;

  if (meta.clips.length === 0) {
    await postOrFail(store, meetingId, () => poster.postText(meta.guildId, NO_SPEECH_TEXT));
    return store.update(meetingId, (m) => {
      m.steps = { transcribe: 'done', summarize: 'done', report: 'done' };
      m.reportComplete = true;
    });
  }

  if (meta.batches.length === 0) {
    const sizes = new Map<string, number>();
    for (const clip of meta.clips) sizes.set(clip.id, await store.clipSize(meetingId, clip));
    const batches = planBatches(meta.clips, sizes);
    meta = await store.update(meetingId, (m) => {
      m.batches = batches;
    });
  }

  // Transcribe every batch that isn't done yet, saving after each one.
  const clipsById = new Map(meta.clips.map((c) => [c.id, c]));
  for (const batch of meta.batches) {
    if (batch.status === 'done') continue;
    const clips = batch.clipIds.flatMap((id) => clipsById.get(id) ?? []);
    try {
      const { segments, provider } = await transcribeBatch(batch, clips, {
        readClip: (c) => store.readClip(meetingId, c),
        primary: deps.transcribers.primary,
        fallback: deps.transcribers.fallback,
        retry,
      });
      meta = await store.update(meetingId, (m) => {
        m.segments = [...m.segments.filter((s) => s.batchId !== batch.id), ...segments];
        const saved = m.batches.find((b) => b.id === batch.id)!;
        saved.status = 'done';
        saved.provider = provider;
        delete saved.error;
        m.steps.summarize = 'pending';
        m.steps.report = 'pending';
      });
    } catch (err) {
      meta = await store.update(meetingId, (m) => {
        const saved = m.batches.find((b) => b.id === batch.id)!;
        saved.status = 'failed';
        saved.error = errorMessage(err);
      });
    }
  }

  if (!meta.batches.some((b) => b.status === 'done')) {
    meta = await store.update(meetingId, (m) => {
      m.steps.transcribe = 'failed';
    });
    await poster.postText(meta.guildId, buildErrorText(meta, 'transcription failed', tz));
    return meta;
  }
  const hasGaps = meta.batches.some((b) => b.status !== 'done');
  meta = await store.update(meetingId, (m) => {
    m.steps.transcribe = hasGaps ? 'failed' : 'done';
  });

  if (!meta.summary || meta.steps.summarize !== 'done') {
    const transcript = renderTranscriptLines(buildTranscriptLines(meta));
    const participants = Object.values(meta.participants);
    const summary = await summarize(deps.summarizers, retry, transcript, participants);
    meta = await store.update(meetingId, (m) => {
      if (summary) {
        m.summary = summary;
        m.steps.report = 'pending';
      }
      m.steps.summarize = summary ? 'done' : 'failed';
    });
  }

  const notes: string[] = [];
  if (!meta.summary) notes.push(NOTE_SUMMARY_FAILED);
  else if (meta.steps.summarize !== 'done') notes.push(NOTE_SUMMARY_STALE);
  if (hasGaps) notes.push(NOTE_GAPS);

  const previousReportId = meta.reportMessageId;
  if (previousReportId === undefined || meta.steps.report !== 'done') {
    const messages = buildReportMessages({
      meta,
      summary: meta.summary,
      transcriptFile: {
        name: transcriptFileName(meta, tz),
        content: renderTranscriptFile(meta, buildTranscriptLines(meta), tz),
      },
      notes,
      timezone: tz,
      updated: previousReportId !== undefined,
    });
    const postedId = await postOrFail(store, meetingId, () => poster.post(meta.guildId, messages, previousReportId));
    if (previousReportId === undefined) {
      meta = await store.update(meetingId, (m) => {
        m.reportMessageId = postedId;
      });
    }
  }

  return store.update(meetingId, (m) => {
    m.steps.report = 'done';
    m.reportComplete = notes.length === 0 && m.steps.summarize === 'done';
  });
}

/** Tries the primary summarizer, then the fallback; undefined when both fail. */
async function summarize(
  summarizers: ProcessMeetingDeps['summarizers'],
  retry: typeof withRetry,
  transcript: string,
  participants: string[],
): Promise<MeetingSummary | undefined> {
  for (const summarizer of [summarizers.primary, summarizers.fallback]) {
    if (!summarizer) continue;
    try {
      return await retry(() => summarizer.summarize(transcript, participants));
    } catch (err) {
      console.warn(`Summary with ${summarizer.name} failed: ${errorMessage(err)}`);
    }
  }
  return undefined;
}

/** Runs a post; if it throws, records the report step as failed and rethrows. */
async function postOrFail<T>(store: MeetingStore, meetingId: string, post: () => Promise<T>): Promise<T> {
  try {
    return await post();
  } catch (err) {
    await store.update(meetingId, (m) => {
      m.steps.report = 'failed';
    });
    throw err;
  }
}
