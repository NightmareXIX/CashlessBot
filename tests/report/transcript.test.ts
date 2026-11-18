import { describe, expect, it } from 'vitest';
import {
  buildTranscriptLines,
  renderTranscriptFile,
  renderTranscriptLines,
  transcriptFileName,
  type TranscriptLine,
} from '../../src/report/transcript.js';
import type { BatchState, ClipMeta, MeetingMeta, TranscriptSegment } from '../../src/types.js';

function seg(userId: string, startMs: number, endMs: number, text: string, speakerName = userId): TranscriptSegment {
  return { batchId: 'b001', clipIds: [], userId, speakerName, startMs, endMs, text };
}

function clip(id: string, startMs: number, durationMs: number): ClipMeta {
  return { id, userId: 'A', speakerName: 'A', startMs, durationMs, file: `clips/${id}.ogg` };
}

function meta(overrides: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    id: 'm1',
    guildId: 'g1',
    voiceChannelId: 'v1',
    voiceChannelName: 'general',
    startedAt: '2026-11-18T15:00:00.000Z', // 9:00 PM in Dhaka
    endedAt: '2026-11-18T15:52:00.000Z',
    participants: { A: 'Rahim', B: 'Karim' },
    clips: [],
    batches: [],
    segments: [],
    steps: { transcribe: 'done', summarize: 'done', report: 'pending' },
    ...overrides,
  };
}

describe('buildTranscriptLines', () => {
  it('merges same-speaker segments 1 s apart into one line', () => {
    const lines = buildTranscriptLines(
      meta({ segments: [seg('A', 0, 5000, 'hello'), seg('A', 6000, 9000, 'world')] }),
    );
    expect(lines).toEqual([{ kind: 'speech', startMs: 0, speakerName: 'A', text: 'hello world' }]);
  });

  it('keeps same-speaker segments 5 s apart separate', () => {
    const lines = buildTranscriptLines(
      meta({ segments: [seg('A', 0, 5000, 'hello'), seg('A', 10_000, 12_000, 'world')] }),
    );
    expect(lines.map((l) => l.startMs)).toEqual([0, 10_000]);
  });

  it('does not merge across different speakers', () => {
    const lines = buildTranscriptLines(
      meta({ segments: [seg('A', 0, 1000, 'hi'), seg('B', 1500, 2500, 'yo'), seg('A', 3000, 4000, 'again')] }),
    );
    expect(lines).toHaveLength(3);
  });

  it('drops empty-text segments', () => {
    const lines = buildTranscriptLines(
      meta({ segments: [seg('A', 0, 1000, 'hi'), seg('B', 2000, 3000, ''), seg('A', 20_000, 21_000, 'bye')] }),
    );
    expect(lines.map((l) => (l.kind === 'speech' ? l.text : ''))).toEqual(['hi', 'bye']);
  });

  it('sorts segments by startMs', () => {
    const lines = buildTranscriptLines(
      meta({ segments: [seg('B', 20_000, 21_000, 'second'), seg('A', 0, 1000, 'first')] }),
    );
    expect(lines.map((l) => l.startMs)).toEqual([0, 20_000]);
  });

  it('inserts a gap line for a failed batch at the right position', () => {
    const batches: BatchState[] = [
      { id: 'b001', clipIds: ['c1'], status: 'done' },
      { id: 'b002', clipIds: ['c2', 'c3'], status: 'failed', error: 'boom' },
      { id: 'b003', clipIds: ['c4'], status: 'done' },
    ];
    const clips = [clip('c1', 0, 10_000), clip('c2', 750_000, 20_000), clip('c3', 770_000, 20_000), clip('c4', 900_000, 5000)];
    const lines = buildTranscriptLines(
      meta({ batches, clips, segments: [seg('A', 0, 10_000, 'early'), seg('A', 900_000, 905_000, 'late')] }),
    );
    expect(lines).toEqual([
      { kind: 'speech', startMs: 0, speakerName: 'A', text: 'early' },
      { kind: 'gap', startMs: 750_000, endMs: 790_000 },
      { kind: 'speech', startMs: 900_000, speakerName: 'A', text: 'late' },
    ]);
  });
});

describe('renderTranscriptLines', () => {
  it('renders speech and gap lines', () => {
    const lines: TranscriptLine[] = [
      { kind: 'speech', startMs: 192_000, speakerName: 'Rahim', text: 'text' },
      { kind: 'gap', startMs: 750_000, endMs: 790_000 },
    ];
    expect(renderTranscriptLines(lines)).toBe(
      '[00:03:12] Rahim: text\n[00:12:30] [untranscribed audio 00:12:30–00:13:10]',
    );
  });

  it('passes Bangla text through byte-for-byte', () => {
    const bangla = 'আমরা আজকের মিটিং শুরু করছি। কাজটা কালকের মধ্যে শেষ করতে হবে।';
    const out = renderTranscriptLines([{ kind: 'speech', startMs: 0, speakerName: 'রহিম', text: bangla }]);
    expect(out).toBe(`[00:00:00] রহিম: ${bangla}`);
    expect(Buffer.from(out, 'utf8').equals(Buffer.from(`[00:00:00] রহিম: ${bangla}`, 'utf8'))).toBe(true);
  });
});

describe('renderTranscriptFile', () => {
  it('renders the exact header and lines for a 52-minute meeting at 9:00 PM Dhaka time', () => {
    const lines: TranscriptLine[] = [
      { kind: 'speech', startMs: 192_000, speakerName: 'Rahim', text: 'text' },
      { kind: 'gap', startMs: 750_000, endMs: 790_000 },
    ];
    expect(renderTranscriptFile(meta(), lines, 'Asia/Dhaka')).toBe(
      [
        'Meeting transcript — 18 Nov 2026, 9:00 PM–9:52 PM (52 min)',
        'Channel: #general',
        'Participants: Rahim, Karim',
        '',
        '[00:03:12] Rahim: text',
        '[00:12:30] [untranscribed audio 00:12:30–00:13:10]',
      ].join('\n'),
    );
  });
});

describe('transcriptFileName', () => {
  it('uses the local date and time in the given timezone', () => {
    expect(transcriptFileName(meta(), 'Asia/Dhaka')).toBe('transcript-2026-11-18-2100.txt');
  });

  it('rolls the date over for timezones ahead of UTC', () => {
    expect(transcriptFileName(meta({ startedAt: '2026-11-18T19:30:00.000Z' }), 'Asia/Dhaka')).toBe(
      'transcript-2026-11-19-0130.txt',
    );
  });
});
