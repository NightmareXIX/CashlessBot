import type { MeetingMeta } from '../types.js';
import { formatDate, formatDuration, formatOffset, formatTime } from '../util/time.js';

export type TranscriptLine =
  | { kind: 'speech'; startMs: number; speakerName: string; text: string }
  | { kind: 'gap'; startMs: number; endMs: number };

/**
 * Merges the transcribed segments into readable lines and marks the audio of
 * failed batches as gaps, all ordered by time.
 */
export function buildTranscriptLines(meta: MeetingMeta, mergeGapMs = 3000): TranscriptLine[] {
  const clipsById = new Map(meta.clips.map((c) => [c.id, c]));
  const gaps: Extract<TranscriptLine, { kind: 'gap' }>[] = [];
  for (const batch of meta.batches) {
    if (batch.status !== 'failed') continue;
    const clips = batch.clipIds.flatMap((id) => clipsById.get(id) ?? []);
    if (clips.length === 0) continue;
    gaps.push({
      kind: 'gap',
      startMs: Math.min(...clips.map((c) => c.startMs)),
      endMs: Math.max(...clips.map((c) => c.startMs + c.durationMs)),
    });
  }

  const segments = meta.segments.filter((s) => s.text.trim() !== '').sort((a, b) => a.startMs - b.startMs);

  const speech: TranscriptLine[] = [];
  let lastUserId: string | undefined;
  let lastEndMs = 0;
  for (const seg of segments) {
    const last = speech[speech.length - 1];
    const gapBetween = gaps.some((g) => g.startMs >= lastEndMs && g.startMs < seg.startMs);
    if (
      last?.kind === 'speech' &&
      seg.userId === lastUserId &&
      seg.startMs - lastEndMs <= mergeGapMs &&
      !gapBetween
    ) {
      last.text = `${last.text} ${seg.text}`;
      lastEndMs = Math.max(lastEndMs, seg.endMs);
    } else {
      speech.push({ kind: 'speech', startMs: seg.startMs, speakerName: seg.speakerName, text: seg.text });
      lastUserId = seg.userId;
      lastEndMs = seg.endMs;
    }
  }

  return [...speech, ...gaps].sort((a, b) => a.startMs - b.startMs);
}

export function renderTranscriptLines(lines: TranscriptLine[]): string {
  return lines
    .map((line) =>
      line.kind === 'speech'
        ? `[${formatOffset(line.startMs)}] ${line.speakerName}: ${line.text}`
        : `[${formatOffset(line.startMs)}] [untranscribed audio ${formatOffset(line.startMs)}–${formatOffset(line.endMs)}]`,
    )
    .join('\n');
}

export function renderTranscriptFile(meta: MeetingMeta, lines: TranscriptLine[], tz: string): string {
  const start = new Date(meta.startedAt);
  const end = new Date(meta.endedAt ?? meta.startedAt);
  const header = [
    `Meeting transcript — ${formatDate(start, tz)}, ${formatTime(start, tz)}–${formatTime(end, tz)} (${formatDuration(end.getTime() - start.getTime())})`,
    `Channel: #${meta.voiceChannelName}`,
    `Participants: ${Object.values(meta.participants).join(', ')}`,
  ].join('\n');
  return `${header}\n\n${renderTranscriptLines(lines)}`;
}

/** "transcript-YYYY-MM-DD-HHmm.txt" using the meeting start in the given timezone. */
export function transcriptFileName(meta: MeetingMeta, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(meta.startedAt));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `transcript-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.txt`;
}
