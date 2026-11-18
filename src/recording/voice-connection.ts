import { entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import type { VoiceConnectionLike } from './session-manager.js';

const READY_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;

/** Joins a voice channel to listen (not deafened, muted) and reports when the connection is lost for good. */
export async function connectToVoice(guild: Guild, channelId: string): Promise<VoiceConnectionLike> {
  const connection = joinVoiceChannel({
    guildId: guild.id,
    channelId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  const destroyOnce = () => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  };

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (err) {
    destroyOnce();
    throw err;
  }

  const lostCallbacks: (() => void)[] = [];
  let destroyedByUs = false;

  // Documented @discordjs/voice pattern: a Disconnected connection that starts Signalling or
  // Connecting within 5 s is reconnecting (e.g. moved channel or region); otherwise it is gone.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT_MS),
      ]);
    } catch {
      destroyOnce(); // the Destroyed handler below reports the loss
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (destroyedByUs) return;
    for (const cb of lostCallbacks) cb();
  });

  return {
    receiver: connection.receiver,
    onLost: (cb) => {
      lostCallbacks.push(cb);
    },
    destroy: () => {
      destroyedByUs = true;
      destroyOnce();
    },
  };
}
