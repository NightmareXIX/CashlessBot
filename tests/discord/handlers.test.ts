import { describe, expect, it, vi } from 'vitest';
import {
  checkJoin,
  checkStop,
  countHumans,
  findRetryTarget,
  interruptedText,
  isValidMeetingId,
  joinFailedText,
  joinStartedText,
  processingFailedText,
  processingText,
  processSafely,
  recordingNoticeText,
  resolveSpeaker,
  retryBusyText,
  retryNothingText,
  retryNotFoundText,
} from '../../src/discord/handlers.js';
import type { MeetingMeta } from '../../src/types.js';

describe('checkJoin', () => {
  it('asks the user to join a voice channel first', () => {
    expect(checkJoin({ memberVoiceChannelId: null, hasReportChannel: true })).toBe(
      'Join a voice channel first, then run /join.',
    );
  });

  it('refuses a server without a report channel', () => {
    expect(checkJoin({ memberVoiceChannelId: 'vc1', hasReportChannel: false })).toBe(
      'This server has no report channel set up yet. Ask the bot owner to add it to REPORT_CHANNELS.',
    );
  });

  it('says where it is already recording', () => {
    expect(checkJoin({ memberVoiceChannelId: 'vc1', hasReportChannel: true, active: { voiceChannelId: 'vc9' } })).toBe(
      "I'm already recording in <#vc9>.",
    );
  });

  it('checks the voice channel before the report channel, and both before an active session', () => {
    expect(checkJoin({ memberVoiceChannelId: null, hasReportChannel: false, active: { voiceChannelId: 'vc9' } })).toBe(
      'Join a voice channel first, then run /join.',
    );
    expect(checkJoin({ memberVoiceChannelId: 'vc1', hasReportChannel: false, active: { voiceChannelId: 'vc9' } })).toBe(
      'This server has no report channel set up yet. Ask the bot owner to add it to REPORT_CHANNELS.',
    );
  });

  it('allows the join otherwise', () => {
    expect(checkJoin({ memberVoiceChannelId: 'vc1', hasReportChannel: true })).toBeNull();
  });
});

describe('checkStop', () => {
  it('refuses when nothing is recording', () => {
    expect(checkStop(undefined)).toBe("I'm not recording right now.");
  });

  it('allows the stop when a session is active', () => {
    expect(checkStop({ meetingId: 'm1', voiceChannelId: 'vc1' })).toBeNull();
    expect(checkStop({ meetingId: 'm1', voiceChannelId: 'vc1' }, false)).toBeNull();
  });

  it('allows the stop while a join is in progress', () => {
    expect(checkStop(undefined, true)).toBeNull();
  });

  it('refuses when there is neither a session nor a join in progress', () => {
    expect(checkStop(undefined, false)).toBe("I'm not recording right now.");
  });
});

describe('fixed copy', () => {
  it('uses the exact user-facing strings', () => {
    expect(retryNothingText).toBe("There's no unfinished meeting to retry.");
    expect(retryBusyText).toBe('That meeting is still being processed.');
    expect(joinStartedText('vc1')).toBe('🔴 Recording started in <#vc1>.');
    expect(recordingNoticeText('vc1', 'u1')).toBe(
      '🔴 Recording started in <#vc1> by <@u1>. Everything said there will be transcribed and summarized.',
    );
    expect(processingText('rc1')).toBe('⏳ Processing the meeting… the report will be posted in <#rc1>.');
    expect(interruptedText).toBe(
      '⚠️ A recording was cut off by a bot restart. Run /retry to process what was recorded.',
    );
  });

  it('names the channel and meeting in the error texts', () => {
    expect(joinFailedText('vc1')).toContain('<#vc1>');
    expect(retryNotFoundText('m1')).toContain('m1');
    expect(processingFailedText('m1')).toContain('m1');
    expect(processingFailedText('m1')).toContain('/retry');
  });
});

describe('countHumans', () => {
  it('counts members that are not bots', () => {
    const members = [{ user: { bot: false } }, { user: { bot: true } }, { user: { bot: false } }];
    expect(countHumans(members)).toBe(2);
  });

  it('is 0 for an empty channel or one with only bots', () => {
    expect(countHumans([])).toBe(0);
    expect(countHumans([{ user: { bot: true } }])).toBe(0);
  });

  it('accepts a Map-style values() iterator', () => {
    const members = new Map([
      ['a', { user: { bot: false } }],
      ['b', { user: { bot: true } }],
    ]);
    expect(countHumans(members.values())).toBe(1);
  });
});

describe('resolveSpeaker', () => {
  it('uses the guild member display name and bot flag', async () => {
    const fetchUser = vi.fn();
    const speaker = await resolveSpeaker('u1', {
      fetchMember: async () => ({ displayName: 'Nick', user: { bot: false } }),
      fetchUser,
    });
    expect(speaker).toEqual({ name: 'Nick', isBot: false });
    expect(fetchUser).not.toHaveBeenCalled();
  });

  it('falls back to the global user when the member left the server', async () => {
    const speaker = await resolveSpeaker('u1', {
      fetchMember: async () => {
        throw new Error('Unknown Member');
      },
      fetchUser: async () => ({ globalName: 'Global', username: 'user1', bot: false }),
    });
    expect(speaker).toEqual({ name: 'Global', isBot: false });
  });

  it('uses the username when the user has no global name', async () => {
    const speaker = await resolveSpeaker('u1', {
      fetchMember: () => Promise.reject(new Error('Unknown Member')),
      fetchUser: async () => ({ globalName: null, username: 'robo', bot: true }),
    });
    expect(speaker).toEqual({ name: 'robo', isBot: true });
  });

  it('rethrows when both lookups fail', async () => {
    await expect(
      resolveSpeaker('u1', {
        fetchMember: () => Promise.reject(new Error('Unknown Member')),
        fetchUser: () => Promise.reject(new Error('Unknown User')),
      }),
    ).rejects.toThrow('Unknown User');
  });
});

describe('processSafely', () => {
  const deps = () => ({
    process: vi.fn(async () => undefined),
    guildIdOf: vi.fn(async () => 'g1'),
    postText: vi.fn(async () => undefined),
    log: vi.fn(),
  });

  it('runs processing and posts nothing extra on success', async () => {
    const d = deps();
    await processSafely('m1', d);
    expect(d.process).toHaveBeenCalledWith('m1');
    expect(d.postText).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it('logs a failure and posts a short failure text to the guild', async () => {
    const d = deps();
    d.process.mockRejectedValue(new Error('post failed'));
    await processSafely('m1', d);
    expect(d.log).toHaveBeenCalled();
    expect(d.postText).toHaveBeenCalledWith('g1', processingFailedText('m1'));
  });

  it('never throws, even when the failure text cannot be posted', async () => {
    const d = deps();
    d.process.mockRejectedValue(new Error('post failed'));
    d.postText.mockRejectedValue(new Error('missing access'));
    await expect(processSafely('m1', d)).resolves.toBeUndefined();
    expect(d.log).toHaveBeenCalledTimes(2);
  });

  it('never throws when the guild of the meeting cannot be found', async () => {
    const d = deps();
    d.process.mockRejectedValue(new Error('ENOENT'));
    d.guildIdOf.mockRejectedValue(new Error('ENOENT'));
    await expect(processSafely('m1', d)).resolves.toBeUndefined();
    expect(d.postText).not.toHaveBeenCalled();
  });

  it('never throws when the logger itself throws', async () => {
    const d = deps();
    d.process.mockRejectedValue(new Error('x'));
    d.log.mockImplementation(() => {
      throw new Error('log broke');
    });
    await expect(processSafely('m1', d)).resolves.toBeUndefined();
  });
});

describe('isValidMeetingId', () => {
  it('accepts store-generated ids', () => {
    expect(isValidMeetingId('2026-11-18_10-00-00_1234')).toBe(true);
    expect(isValidMeetingId('2026-11-18_10-00-00_1234-2')).toBe(true);
  });

  it('rejects paths and junk', () => {
    for (const id of ['', '..', '../etc', 'a/b', 'a\\b', '.', 'x'.repeat(200)]) {
      expect(isValidMeetingId(id)).toBe(false);
    }
  });
});

describe('findRetryTarget', () => {
  const meta = (over: Partial<MeetingMeta> = {}): MeetingMeta => ({
    id: '2026-11-18_10-00-00_1234',
    guildId: 'g1',
    voiceChannelId: 'vc1',
    voiceChannelName: 'Meeting',
    startedAt: '2026-11-18T10:00:00.000Z',
    endedAt: '2026-11-18T11:00:00.000Z',
    participants: {},
    clips: [],
    batches: [],
    segments: [],
    steps: { transcribe: 'done', summarize: 'failed', report: 'done' },
    ...over,
  });
  const store = (m?: MeetingMeta) => ({
    load: vi.fn(async (id: string) => {
      if (!m || m.id !== id) throw new Error('ENOENT');
      return m;
    }),
    findLatestUnfinished: vi.fn(async () => m),
  });

  it('picks the latest unfinished meeting when no id is given', async () => {
    const s = store(meta());
    expect(await findRetryTarget('g1', null, s)).toEqual({ ok: true, meetingId: meta().id });
    expect(s.findLatestUnfinished).toHaveBeenCalledWith('g1');
  });

  it('says there is nothing to retry when no unfinished meeting exists', async () => {
    expect(await findRetryTarget('g1', null, store(undefined))).toEqual({ ok: false, text: retryNothingText });
  });

  it('loads the given meeting id', async () => {
    const s = store(meta());
    expect(await findRetryTarget('g1', meta().id, s)).toEqual({ ok: true, meetingId: meta().id });
    expect(s.findLatestUnfinished).not.toHaveBeenCalled();
  });

  it('does not find a meeting that does not exist, has a bad id, or is from another server', async () => {
    const notFound = (id: string) => ({ ok: false, text: retryNotFoundText(id) });
    expect(await findRetryTarget('g1', 'nope', store(meta()))).toEqual(notFound('nope'));
    const s = store(meta());
    expect(await findRetryTarget('g1', '../secret', s)).toEqual(notFound('../secret'));
    expect(s.load).not.toHaveBeenCalled();
    expect(await findRetryTarget('g2', meta().id, store(meta()))).toEqual(notFound(meta().id));
  });

  it('says there is nothing to retry for a finished or still-recording meeting', async () => {
    const finished = meta({ steps: { transcribe: 'done', summarize: 'done', report: 'done' }, reportComplete: true });
    expect(await findRetryTarget('g1', finished.id, store(finished))).toEqual({ ok: false, text: retryNothingText });
    const recording = meta({ endedAt: undefined });
    expect(await findRetryTarget('g1', recording.id, store(recording))).toEqual({ ok: false, text: retryNothingText });
  });
});
