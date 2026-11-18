import { describe, expect, it } from 'vitest';
import { buildErrorText, buildReportMessages, mentionFor } from '../../src/report/report-format.js';
import type { MeetingMeta, MeetingSummary } from '../../src/types.js';

const TZ = 'Asia/Dhaka';

function makeMeta(overrides: Partial<MeetingMeta> = {}): MeetingMeta {
  return {
    id: 'm1',
    guildId: 'g1',
    voiceChannelId: 'vc1',
    voiceChannelName: 'general-voice',
    startedAt: '2026-11-18T15:00:00.000Z', // 9:00 PM in Dhaka
    endedAt: '2026-11-18T15:52:00.000Z', // 9:52 PM in Dhaka
    participants: { u1: 'Rahim Uddin', u2: 'Karim' },
    clips: [],
    batches: [],
    segments: [],
    steps: { transcribe: 'done', summarize: 'done', report: 'pending' },
    ...overrides,
  };
}

const transcriptFile = { name: 'transcript.txt', content: 'hello transcript' };

const summary: MeetingSummary = {
  overview: 'We planned the launch.',
  ideas: [
    { idea: 'Ship a beta', raisedBy: 'Karim' },
    { idea: 'Add dark mode', raisedBy: null },
  ],
  tasks: [
    { task: 'Write the spec', owner: 'rahim', due: 'Friday' },
    { task: 'Book the venue', owner: null, due: null },
  ],
};

describe('mentionFor', () => {
  const participants = { u1: 'Rahim Uddin' };

  it('matches a first word case-insensitively', () => {
    expect(mentionFor('rahim', participants)).toBe('<@u1>');
  });

  it('matches the full display name case-insensitively', () => {
    expect(mentionFor('RAHIM uddin', participants)).toBe('<@u1>');
  });

  it('returns the name when nobody matches', () => {
    expect(mentionFor('Someone', participants)).toBe('Someone');
  });

  it('returns the plain name when more than one participant matches', () => {
    expect(mentionFor('rahim', { u1: 'Rahim A', u2: 'Rahim B' })).toBe('rahim');
  });

  it('returns the plain name when a full name and a first word both match different people', () => {
    expect(mentionFor('rahim', { u1: 'Rahim', u2: 'Rahim B' })).toBe('rahim');
  });

  it('treats an empty or blank name as unassigned and never matches an empty display name', () => {
    expect(mentionFor('', participants)).toBe('unassigned');
    expect(mentionFor('   ', participants)).toBe('unassigned');
    expect(mentionFor('', { u1: '', u2: '  ' })).toBe('unassigned');
    expect(mentionFor('x', { u1: '' })).toBe('x');
  });

  it('returns "unassigned" for null', () => {
    expect(mentionFor(null, participants)).toBe('unassigned');
  });
});

describe('buildReportMessages', () => {
  it('builds one message with the exact title and description', () => {
    const messages = buildReportMessages({
      meta: makeMeta(),
      summary,
      transcriptFile,
      notes: [],
      timezone: TZ,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].embeds).toHaveLength(1);
    const embed = messages[0].embeds[0];
    expect(embed.title).toBe('📋 Meeting Report — 18 Nov 2026, 9:00 PM–9:52 PM (52 min)');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.footer).toEqual({ text: 'Meeting ID: m1' });
    expect(embed.description).toBe(
      [
        '#general-voice · Participants: Rahim Uddin, Karim',
        '**Overview**\nWe planned the launch.',
        '**💡 Ideas discussed**\n• Ship a beta — Karim\n• Add dark mode',
        '**✅ Tasks**\n• Write the spec — <@u1> (due: Friday)\n• Book the venue — unassigned',
      ].join('\n\n'),
    );
    expect(messages[0].files).toEqual([
      { name: 'transcript.txt', data: Buffer.from('hello transcript', 'utf8') },
    ]);
  });

  it('uses placeholders when there are no ideas or tasks', () => {
    const [message] = buildReportMessages({
      meta: makeMeta(),
      summary: { overview: 'Short.', ideas: [], tasks: [] },
      transcriptFile,
      notes: [],
      timezone: TZ,
    });
    const description = message.embeds[0].description!;
    expect(description).toContain('**💡 Ideas discussed**\n_None_');
    expect(description).toContain('**✅ Tasks**\n_No tasks were assigned._');
  });

  it('with no summary gives the warning and header only, and still attaches the file', () => {
    const [message] = buildReportMessages({
      meta: makeMeta(),
      transcriptFile,
      notes: ['Transcription was partial.'],
      timezone: TZ,
    });
    expect(message.embeds).toHaveLength(1);
    expect(message.embeds[0].description).toBe(
      '⚠️ Transcription was partial.\n\n#general-voice · Participants: Rahim Uddin, Karim',
    );
    expect(message.files).toHaveLength(1);
  });

  it('prefixes every note line with a warning sign', () => {
    const [message] = buildReportMessages({
      meta: makeMeta(),
      transcriptFile,
      notes: ['one', 'two'],
      timezone: TZ,
    });
    expect(message.embeds[0].description!.startsWith('⚠️ one\n⚠️ two\n\n#general-voice')).toBe(true);
  });

  it('starts the title with "🔁 Updated " when updated', () => {
    const [message] = buildReportMessages({
      meta: makeMeta(),
      summary,
      transcriptFile,
      notes: [],
      timezone: TZ,
      updated: true,
    });
    expect(message.embeds[0].title).toBe(
      '🔁 Updated 📋 Meeting Report — 18 Nov 2026, 9:00 PM–9:52 PM (52 min)',
    );
  });

  it('splits a long report within Discord limits without losing content', () => {
    const ideas = Array.from({ length: 60 }, (_, i) => ({
      idea: `idea-${String(i).padStart(2, '0')} `.padEnd(200, 'x'),
      raisedBy: null,
    }));
    const messages = buildReportMessages({
      meta: makeMeta(),
      summary: { overview: 'Lots of ideas.', ideas, tasks: [] },
      transcriptFile,
      notes: [],
      timezone: TZ,
    });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.embeds.length).toBeLessThanOrEqual(10);
      let total = 0;
      for (const embed of message.embeds) {
        expect(embed.description!.length).toBeLessThanOrEqual(4096);
        total += (embed.title?.length ?? 0) + embed.description!.length + (embed.footer?.text.length ?? 0);
      }
      expect(total).toBeLessThanOrEqual(6000);
    }

    const joined = messages.flatMap((m) => m.embeds.map((e) => e.description)).join('\n');
    for (const { idea } of ideas) expect(joined).toContain(`• ${idea}`);

    expect(messages[0].files).toHaveLength(1);
    for (const message of messages.slice(1)) expect(message.files).toHaveLength(0);
    expect(messages[0].embeds[0].title).toBeDefined();
    expect(messages[0].embeds.slice(1).every((e) => e.title === undefined)).toBe(true);
    expect(messages[0].embeds[0].footer).toEqual({ text: 'Meeting ID: m1' });
    expect(messages.flatMap((m) => m.embeds).filter((e) => e.footer !== undefined)).toHaveLength(1);
    for (const message of messages.slice(1)) {
      expect(message.embeds.every((e) => e.title === undefined)).toBe(true);
    }
  });

  it('never ends a description on a block header line', () => {
    const headers = ['**Overview**', '**💡 Ideas discussed**', '**✅ Tasks**'];
    let tasksHeaderStartedAChunk = false;
    for (let filler = 3400; filler <= 4000; filler++) {
      const messages = buildReportMessages({
        meta: makeMeta(),
        summary: {
          overview: 'o',
          ideas: [{ idea: 'z'.repeat(filler), raisedBy: null }],
          tasks: [{ task: 't'.repeat(500), owner: null, due: null }],
        },
        transcriptFile,
        notes: [],
        timezone: TZ,
      });
      for (const embed of messages.flatMap((m) => m.embeds)) {
        const description = embed.description!;
        expect(description.length).toBeLessThanOrEqual(4096);
        const lastLine = description.slice(description.lastIndexOf('\n') + 1);
        expect(headers, `filler ${filler}`).not.toContain(lastLine);
        if (description.startsWith('**✅ Tasks**\n')) tasksHeaderStartedAChunk = true;
      }
    }
    expect(tasksHeaderStartedAChunk).toBe(true);
  });

  it('hard-splits a single line longer than 4096 characters', () => {
    const longIdea = 'y'.repeat(10_000);
    const messages = buildReportMessages({
      meta: makeMeta(),
      summary: { overview: 'o', ideas: [{ idea: longIdea, raisedBy: null }], tasks: [] },
      transcriptFile,
      notes: [],
      timezone: TZ,
    });
    const descriptions = messages.flatMap((m) => m.embeds.map((e) => e.description!));
    for (const d of descriptions) expect(d.length).toBeLessThanOrEqual(4096);
    expect(descriptions.join('')).toContain(longIdea);
    for (const m of messages) {
      const total = m.embeds.reduce(
        (n, e) => n + (e.title?.length ?? 0) + e.description!.length + (e.footer?.text.length ?? 0),
        0,
      );
      expect(total).toBeLessThanOrEqual(6000);
    }
  });
});

describe('buildErrorText', () => {
  it('formats the failure message', () => {
    expect(buildErrorText(makeMeta(), 'Transcription failed', TZ)).toBe(
      '❌ Processing failed for the meeting in #general-voice (18 Nov 2026, 9:00 PM): Transcription failed. Run /retry to try again (meeting `m1`).',
    );
  });
});
