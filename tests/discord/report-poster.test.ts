import { AttachmentBuilder, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordReportPoster } from '../../src/discord/report-poster.js';

function fakeClient(channel: unknown) {
  const fetch = vi.fn(async () => channel);
  return { client: { channels: { fetch } } as unknown as Client, fetch };
}

function sendableChannel() {
  let n = 0;
  const send = vi.fn(async () => ({ id: `msg${++n}` }));
  return { channel: { isSendable: () => true, send }, send };
}

describe('DiscordReportPoster', () => {
  it('sends each message to the guild report channel and returns the first id', async () => {
    const { channel, send } = sendableChannel();
    const { client, fetch } = fakeClient(channel);
    const poster = new DiscordReportPoster(client, new Map([['g1', 'rc1']]));

    const id = await poster.post('g1', [
      { embeds: [{ title: 'Report' }], files: [{ name: 't.txt', data: Buffer.from('hi') }] },
      { content: 'more', embeds: [], files: [] },
    ]);

    expect(id).toBe('msg1');
    expect(fetch).toHaveBeenCalledWith('rc1');
    expect(send).toHaveBeenCalledTimes(2);
    const first = (send.mock.calls[0] as unknown[])[0] as { embeds: unknown; files: AttachmentBuilder[]; reply?: unknown };
    expect(first.embeds).toEqual([{ title: 'Report' }]);
    expect(first.files[0]).toBeInstanceOf(AttachmentBuilder);
    expect(first.files[0]!.name).toBe('t.txt');
    expect(first.reply).toBeUndefined();
    expect((send.mock.calls[1] as unknown[])[0]).toMatchObject({ content: 'more' });
  });

  it('makes only the first message a reply when replyTo is given', async () => {
    const { channel, send } = sendableChannel();
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));

    await poster.post('g1', [{ embeds: [], files: [] }, { embeds: [], files: [] }], 'old1');

    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({
      reply: { messageReference: 'old1', failIfNotExists: false },
    });
    expect(((send.mock.calls[1] as unknown[])[0] as { reply?: unknown }).reply).toBeUndefined();
  });

  const link = 'https://discord.com/channels/g1/rc1/old1';

  it('posts a normal message linking the earlier report when the reply is refused (160002)', async () => {
    const { channel, send } = sendableChannel();
    send.mockRejectedValueOnce(Object.assign(new Error('Cannot reply without permission'), { code: 160002 }));
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));

    const id = await poster.post('g1', [{ embeds: [{ title: 'R' }], files: [] }, { embeds: [], files: [] }], 'old1');

    expect(id).toBe('msg1');
    expect(send).toHaveBeenCalledTimes(3);
    const fallback = (send.mock.calls[1] as unknown[])[0] as { content?: string; embeds: unknown; reply?: unknown };
    expect(fallback.reply).toBeUndefined();
    expect(fallback.content).toBe(`🔁 Update to the earlier report: ${link}`);
    expect(fallback.embeds).toEqual([{ title: 'R' }]);
    // Only the first message carries the link.
    expect(((send.mock.calls[2] as unknown[])[0] as { content?: string }).content).toBeUndefined();
  });

  it('keeps existing content after the link in the fallback message', async () => {
    const { channel, send } = sendableChannel();
    send.mockRejectedValueOnce(Object.assign(new Error('Cannot reply'), { code: 160002 }));
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));

    await poster.post('g1', [{ content: 'Summary below', embeds: [], files: [] }], 'old1');

    const fallback = (send.mock.calls[1] as unknown[])[0] as { content?: string };
    expect(fallback.content).toBe(`🔁 Update to the earlier report: ${link}\nSummary below`);
  });

  it.each([
    ['unknown message (10008)', { code: 10008 }, 'Unknown Message'],
    ['invalid message_reference (50035)', { code: 50035 }, 'Invalid Form Body\nmessage_reference[MESSAGE_REFERENCE_UNKNOWN_MESSAGE]'],
  ])('falls back with the link for other reply-reference errors: %s', async (_name, props, message) => {
    const { channel, send } = sendableChannel();
    send.mockRejectedValueOnce(Object.assign(new Error(message), props));
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));

    await poster.post('g1', [{ embeds: [], files: [] }], 'old1');

    expect(((send.mock.calls[1] as unknown[])[0] as { content?: string }).content).toContain(link);
  });

  it('rethrows a 50035 error that is not about the reply reference', async () => {
    const { channel, send } = sendableChannel();
    send.mockRejectedValueOnce(Object.assign(new Error('Invalid Form Body\nembeds[0].description'), { code: 50035 }));
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));
    await expect(poster.post('g1', [{ embeds: [], files: [] }], 'old1')).rejects.toThrow('embeds[0]');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rethrows other send errors', async () => {
    const { channel, send } = sendableChannel();
    send.mockRejectedValueOnce(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));
    await expect(poster.post('g1', [{ embeds: [], files: [] }], 'old1')).rejects.toThrow('Missing Permissions');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('posts plain text without pinging anyone', async () => {
    const { channel, send } = sendableChannel();
    const poster = new DiscordReportPoster(fakeClient(channel).client, new Map([['g1', 'rc1']]));
    await poster.postText('g1', 'hello <@u1>');
    expect(send).toHaveBeenCalledWith({ content: 'hello <@u1>', allowedMentions: { parse: [] } });
  });

  it('throws for a guild without a report channel', async () => {
    const poster = new DiscordReportPoster(fakeClient(null).client, new Map());
    await expect(poster.postText('g1', 'x')).rejects.toThrow(/report channel/i);
  });

  it('throws when the report channel cannot be sent to', async () => {
    const poster = new DiscordReportPoster(fakeClient({ isSendable: () => false }).client, new Map([['g1', 'rc1']]));
    await expect(poster.postText('g1', 'x')).rejects.toThrow(/rc1/);
  });
});
