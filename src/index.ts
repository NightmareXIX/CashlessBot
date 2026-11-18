import 'dotenv/config';
import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  type VoiceState,
} from 'discord.js';
import { type Config, loadConfig } from './config.js';
import {
  alreadyRecordingText,
  checkJoin,
  checkStop,
  countHumans,
  findRetryTarget,
  genericErrorText,
  interruptedText,
  joinFailedText,
  joinStartedText,
  noReportChannelText,
  noticeFailedText,
  processingText,
  processSafely,
  recordingNoticeText,
  resolveSpeaker,
  retryBusyText,
} from './discord/handlers.js';
import { registerCommands } from './discord/register-commands.js';
import { DiscordReportPoster } from './discord/report-poster.js';
import { RunOnce } from './discord/run-once.js';
import { processMeeting, type ProcessMeetingDeps } from './pipeline/process-meeting.js';
import { SessionManager, type StartResult } from './recording/session-manager.js';
import { connectToVoice } from './recording/voice-connection.js';
import { cleanupOldMeetings } from './storage/cleanup.js';
import { MeetingStore } from './storage/meeting-store.js';
import { GeminiSummarizer } from './summary/gemini-summarizer.js';
import { GroqSummarizer } from './summary/groq-summarizer.js';
import { GeminiTranscriber } from './transcription/gemini-transcriber.js';
import { GroqTranscriber } from './transcription/groq-transcriber.js';

const CLEANUP_INTERVAL_MS = 86_400_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;

type GuildCommand = ChatInputCommandInteraction<'cached'>;

/** Gemini and (optionally) Groq; the primary transcriber follows TRANSCRIBER, summaries are Gemini-first. */
function buildProviders(config: Config): Pick<ProcessMeetingDeps, 'transcribers' | 'summarizers'> {
  const geminiTranscriber = new GeminiTranscriber({ apiKey: config.gemini.apiKey, model: config.gemini.model });
  const geminiSummarizer = new GeminiSummarizer({ apiKey: config.gemini.apiKey, model: config.gemini.model });
  if (!config.groq) {
    return { transcribers: { primary: geminiTranscriber }, summarizers: { primary: geminiSummarizer } };
  }
  const groqTranscriber = new GroqTranscriber({ apiKey: config.groq.apiKey, model: config.groq.transcribeModel });
  const groqSummarizer = new GroqSummarizer({ apiKey: config.groq.apiKey, model: config.groq.summaryModel });
  return {
    transcribers:
      config.primaryTranscriber === 'groq'
        ? { primary: groqTranscriber, fallback: geminiTranscriber }
        : { primary: geminiTranscriber, fallback: groqTranscriber },
    summarizers: { primary: geminiSummarizer, fallback: groqSummarizer },
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error((err as Error).message);
    console.error('Copy .env.example to .env and fill in the values (see docs/setup.md).');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const store = new MeetingStore(config.recordingsDir);
  const poster = new DiscordReportPoster(client, config.reportChannels);
  const pipeline: ProcessMeetingDeps = { store, poster, timezone: config.timezone, ...buildProviders(config) };
  const processing = new RunOnce();
  let shuttingDown = false;

  /** Starts processing a meeting in the background unless it is already being processed. Never throws. */
  const startProcessing = (meetingId: string): boolean =>
    processing.run(meetingId, () =>
      processSafely(meetingId, {
        process: (id) => processMeeting(id, pipeline),
        guildIdOf: async (id) => (await store.load(id)).guildId,
        postText: (guildId, text) => poster.postText(guildId, text),
      }),
    );

  const sessions = new SessionManager({
    store,
    connect: async (guildId, channelId) => connectToVoice(await client.guilds.fetch(guildId), channelId),
    resolveSpeaker: (guildId, userId) =>
      resolveSpeaker(userId, {
        fetchMember: async (id) => (await client.guilds.fetch(guildId)).members.fetch(id),
        fetchUser: (id) => client.users.fetch(id),
      }),
    onStopped: (meetingId, reason) => {
      console.log(`Meeting ${meetingId} stopped (${reason}).`);
      // On shutdown the audio is saved and the guild is told to /retry after the restart.
      if (!shuttingDown) startProcessing(meetingId);
    },
  });

  // Meetings left recording by a crash. Done before logging in, so it can't touch a new /join.
  const interrupted = await store.markInterrupted();

  const runCleanup = () => {
    cleanupOldMeetings(store, new Date())
      .then((removed) => {
        if (removed.length) console.log(`Deleted ${removed.length} old meeting(s): ${removed.join(', ')}`);
      })
      .catch((err: unknown) => console.error('Cleaning up old meetings failed:', err));
  };
  let cleanupTimer: NodeJS.Timeout | undefined;

  client.on(Events.Error, (err) => console.error('Discord client error:', err));

  client.once(Events.ClientReady, (ready) => {
    console.log(`Ready as ${ready.user.tag}.`);
    registerCommands(config.discordToken, config.discordClientId)
      .then(() => console.log('Slash commands registered.'))
      .catch((err: unknown) => console.error('Registering slash commands failed:', err));
    for (const guildId of new Set(interrupted.map((m) => m.guildId))) {
      poster
        .postText(guildId, interruptedText)
        .catch((err: unknown) => console.error(`Posting the restart notice in guild ${guildId} failed:`, err));
    }
    runCleanup();
    cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  });

  client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
    try {
      const guild = newState.guild;
      // The session manager ignores channels it isn't recording (or joining), so report both sides.
      for (const channelId of new Set([oldState.channelId, newState.channelId])) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isVoiceBased()) continue;
        sessions.handleHumanCount(guild.id, channelId, countHumans(channel.members.values()));
      }
    } catch (err) {
      console.error('Handling a voice state update failed:', err);
    }
  });

  const handleJoin = async (i: GuildCommand) => {
    const voiceChannel = i.member.voice.channel;
    const reportChannelId = config.reportChannels.get(i.guildId);
    const refusal = checkJoin({
      memberVoiceChannelId: voiceChannel?.id ?? null,
      hasReportChannel: reportChannelId !== undefined,
      active: sessions.get(i.guildId),
    });
    if (refusal || !voiceChannel || !reportChannelId) {
      await i.reply({ content: refusal ?? genericErrorText, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!voiceChannel.joinable) {
      await i.reply({ content: joinFailedText(voiceChannel.id), flags: MessageFlags.Ephemeral });
      return;
    }

    // Joining can take several seconds, longer than Discord waits for a reply.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let result: StartResult;
    try {
      result = await sessions.start({
        guildId: i.guildId,
        voiceChannelId: voiceChannel.id,
        voiceChannelName: voiceChannel.name,
      });
    } catch (err) {
      console.error(`Joining voice channel ${voiceChannel.id} in guild ${i.guildId} failed:`, err);
      await i.editReply(joinFailedText(voiceChannel.id));
      return;
    }
    if (!result.ok) {
      await i.editReply(alreadyRecordingText(result.voiceChannelId));
      return;
    }

    let reply = joinStartedText(voiceChannel.id);
    try {
      await poster.postText(i.guildId, recordingNoticeText(voiceChannel.id, i.user.id));
    } catch (err) {
      console.error(`Posting the recording notice in guild ${i.guildId} failed:`, err);
      reply += `\n${noticeFailedText(reportChannelId)}`;
    }
    await i.editReply(reply);
  };

  const handleStop = async (i: GuildCommand) => {
    const refusal = checkStop(sessions.get(i.guildId));
    if (refusal) {
      await i.reply({ content: refusal, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    await sessions.stop(i.guildId, 'command');
    // A session can only start with a report channel, and REPORT_CHANNELS can't change while running.
    const reportChannelId = config.reportChannels.get(i.guildId) ?? i.channelId;
    await i.editReply(processingText(reportChannelId));
  };

  const handleRetry = async (i: GuildCommand) => {
    const reportChannelId = config.reportChannels.get(i.guildId);
    if (!reportChannelId) {
      await i.reply({ content: noReportChannelText, flags: MessageFlags.Ephemeral });
      return;
    }
    const target = await findRetryTarget(i.guildId, i.options.getString('meeting_id'), store);
    if (!target.ok) {
      await i.reply({ content: target.text, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!startProcessing(target.meetingId)) {
      await i.reply({ content: retryBusyText, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply(processingText(reportChannelId));
  };

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (!interaction.inCachedGuild()) {
        await interaction.reply({ content: genericErrorText, flags: MessageFlags.Ephemeral });
        return;
      }
      if (shuttingDown) {
        await interaction.reply({ content: genericErrorText, flags: MessageFlags.Ephemeral });
        return;
      }
      switch (interaction.commandName) {
        case 'join':
          return await handleJoin(interaction);
        case 'stop':
          return await handleStop(interaction);
        case 'retry':
          return await handleRetry(interaction);
      }
    } catch (err) {
      console.error(`/${interaction.commandName} in guild ${interaction.guildId} failed:`, err);
      try {
        if (interaction.replied) {
          await interaction.followUp({ content: genericErrorText, flags: MessageFlags.Ephemeral });
        } else if (interaction.deferred) {
          await interaction.editReply(genericErrorText);
        } else {
          await interaction.reply({ content: genericErrorText, flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        console.error('Replying with the error message failed:', replyErr);
      }
    }
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`${signal} again, exiting now.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`${signal} received: saving recordings and shutting down.`);
    setTimeout(() => {
      console.error('Shutdown took too long, exiting.');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    clearInterval(cleanupTimer);

    const guildIds = [...client.guilds.cache.keys()];
    const stops = await Promise.allSettled(guildIds.map((id) => sessions.stop(id, 'command')));
    const notices: Promise<void>[] = [];
    stops.forEach((s, n) => {
      const guildId = guildIds[n]!;
      if (s.status === 'rejected') console.error(`Stopping the recording in guild ${guildId} failed:`, s.reason);
      else if (s.value !== undefined) notices.push(poster.postText(guildId, interruptedText));
    });
    await Promise.allSettled(notices);
    await client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.discordToken);
}

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));

main().catch((err: unknown) => {
  console.error('The bot failed to start:', err);
  process.exit(1);
});
