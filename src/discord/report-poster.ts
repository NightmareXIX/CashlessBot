import { AttachmentBuilder, type Client, type SendableChannels } from 'discord.js';
import type { ReportMessage, ReportPoster } from '../types.js';

/** Discord refuses replies when the bot lacks Read Message History in the channel. */
const CANNOT_REPLY_WITHOUT_HISTORY = 160002;

/** Posts reports and notices to each guild's configured report channel. */
export class DiscordReportPoster implements ReportPoster {
  constructor(
    private readonly client: Client,
    private readonly reportChannels: Map<string, string>,
  ) {}

  async post(guildId: string, messages: ReportMessage[], replyTo?: string): Promise<string> {
    const channel = await this.channel(guildId);
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
        if (!reply || (err as { code?: unknown }).code !== CANNOT_REPLY_WITHOUT_HISTORY) throw err;
        // Still post the updated report, just not as a reply to the old one.
        sent = await channel.send(payload);
      }
      firstId ??= sent.id;
    }
    if (firstId === undefined) throw new Error('No report messages to post');
    return firstId;
  }

  async postText(guildId: string, text: string): Promise<void> {
    const channel = await this.channel(guildId);
    // Mentions in notices render as names but don't ping anyone.
    await channel.send({ content: text, allowedMentions: { parse: [] } });
  }

  private async channel(guildId: string): Promise<SendableChannels> {
    const channelId = this.reportChannels.get(guildId);
    if (!channelId) throw new Error(`No report channel is configured for guild ${guildId}`);
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Report channel ${channelId} is not a channel I can send messages to`);
    return channel;
  }
}
