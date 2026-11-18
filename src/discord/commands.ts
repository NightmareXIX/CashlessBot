import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type RESTPostAPIApplicationCommandsJSONBody,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

const guildOnly: Pick<RESTPostAPIChatInputApplicationCommandsJSONBody, 'type' | 'contexts' | 'integration_types'> = {
  type: ApplicationCommandType.ChatInput,
  contexts: [InteractionContextType.Guild],
  integration_types: [ApplicationIntegrationType.GuildInstall],
};

/** The bot's slash commands, registered globally on startup. All work only inside a server. */
export const COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  { ...guildOnly, name: 'join', description: 'Start recording this voice channel' },
  { ...guildOnly, name: 'stop', description: 'Stop recording and post the meeting report' },
  {
    ...guildOnly,
    name: 'retry',
    description: 'Re-process an unfinished meeting',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'meeting_id',
        description: 'Meeting ID to re-process (default: the latest unfinished meeting)',
        required: false,
      },
    ],
  },
];
