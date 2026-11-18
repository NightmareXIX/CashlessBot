import {
  ApplicationCommandOptionType,
  InteractionContextType,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS as ALL_COMMANDS } from '../../src/discord/commands.js';

// All three are chat-input (slash) commands.
const COMMANDS = ALL_COMMANDS as RESTPostAPIChatInputApplicationCommandsJSONBody[];

describe('COMMANDS', () => {
  it('defines join, stop and retry', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['join', 'stop', 'retry']);
  });

  it('uses the fixed descriptions', () => {
    const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
    expect(byName.join!.description).toBe('Start recording this voice channel');
    expect(byName.stop!.description).toBe('Stop recording and post the meeting report');
    expect(byName.retry!.description).toBe('Re-process an unfinished meeting');
  });

  it('makes every command guild-only', () => {
    for (const command of COMMANDS) expect(command.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('gives retry an optional string meeting_id option', () => {
    const retry = COMMANDS.find((c) => c.name === 'retry')!;
    expect(retry.options).toHaveLength(1);
    expect(retry.options![0]).toMatchObject({
      name: 'meeting_id',
      type: ApplicationCommandOptionType.String,
      required: false,
    });
  });

  it('gives join and stop no options', () => {
    for (const name of ['join', 'stop']) {
      expect(COMMANDS.find((c) => c.name === name)!.options ?? []).toEqual([]);
    }
  });
});
