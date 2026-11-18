import { REST, Routes } from 'discord.js';
import { COMMANDS } from './commands.js';

/** Registers (overwrites) the bot's global slash commands. */
export async function registerCommands(token: string, clientId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: COMMANDS });
}
