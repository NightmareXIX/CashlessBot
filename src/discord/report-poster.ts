import { AttachmentBuilder, type Client, type SendableChannels } from 'discord.js';
import type { ReportMessage, ReportPoster } from '../types.js';

const CANNOT_REPLY_WITHOUT_HISTORY = 160002; // the bot lacks Read Message History (not in the invite)
const UNKNOWN_MESSAGE = 10008;
const INVALID_FORM_BODY = 50035;

/** Whether a send failed because of its reply reference, rather than the message itself. */
function isReplyReferenceError(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  if (code === CANNOT_REPLY_WITHOUT_HISTORY || code === UNKNOWN_MESSAGE) return true;
  return code === INVALID_FORM_BODY && typeof message === 'string' && /message_reference/i.test(message);
}

export const updateLinkText = (guildId: string, channelId: string, messageId: string) =>
  `🔁 Update to the earlier report: https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/** Posts reports and notices to each guild's configured report channel. */
export class DiscordReportPoster implements ReportPoster {
  constructor(
    private readonly client: Client,
    private readonly reportChannels: Map<string, string>,
  ) {}

  async post(guildId: string, messages: ReportMessage[], replyTo?: string): Promise<string> {
    const { channel, channelId } = await this.channel(guildId);
    let firstId: string | undefined;
    for (const [i, message] of messages.entries()) {
      const payload = {
        content: message.content,
        embeds: message.embeds,
        files: message.files.map((f) => new AttachmentBuilder(f.data, { name: f.name })),
      };
      const reply = i === 0 && replyTo ? { messageReference: replyTo, failIfNotExists: false } : undefined;
      let sent;
      try {
        sent = await channel.send({ ...payload, reply });
      } catch (err) {
        if (!reply || !isReplyReferenceError(err)) throw err;
        // Post the update as a normal message that links the earlier report instead.
        const link = updateLinkText(guildId, channelId, reply.messageReference);
        sent = await channel.send({ ...payload, content: payload.content ? `${link}\n${payload.content}` : link });
      }
      firstId ??= sent.id;
    }
    if (firstId === undefined) throw new Error('No report messages to post');
    return firstId;
  }

  async postText(guildId: string, text: string): Promise<void> {
    const { channel } = await this.channel(guildId);
    // Mentions in notices render as names but don't ping anyone.
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }

  private async channel(guildId: string): Promise<{ channel: SendableChannels; channelId: string }> {
    const channelId = this.reportChannels.get(guildId);
    if (!channelId) throw new Error(`No report channel is configured for guild ${guildId}`);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Report channel ${channelId} is not a channel I can send messages to`);
    return { channel, channelId };
  }
}
