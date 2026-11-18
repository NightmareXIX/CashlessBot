import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClipMeta, MeetingMeta } from '../types.js';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function meetingId(startedAt: Date, guildId: string): string {
  const d = startedAt;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  return `${date}_${time}_${guildId.slice(-4)}`;
}

export function isFinished(m: MeetingMeta): boolean {
  const { transcribe, summarize, report } = m.steps;
  return transcribe === 'done' && summarize === 'done' && report === 'done' && m.reportComplete === true;
}

export class MeetingStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly rootDir: string) {}

  meetingDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  private metaPath(id: string): string {
    return path.join(this.meetingDir(id), 'meta.json');
  }

  async create(init: {
    guildId: string;
    voiceChannelId: string;
    voiceChannelName: string;
    startedAt: Date;
  }): Promise<MeetingMeta> {
    const meta: MeetingMeta = {
      id: meetingId(init.startedAt, init.guildId),
      guildId: init.guildId,
      voiceChannelId: init.voiceChannelId,
      voiceChannelName: init.voiceChannelName,
      startedAt: init.startedAt.toISOString(),
      participants: {},
      clips: [],
      batches: [],
      segments: [],
      steps: { transcribe: 'pending', summarize: 'pending', report: 'pending' },
    };
    await mkdir(path.join(this.meetingDir(meta.id), 'clips'), { recursive: true });
    await this.save(meta);
    return meta;
  }

  async load(id: string): Promise<MeetingMeta> {
    return JSON.parse(await readFile(this.metaPath(id), 'utf8')) as MeetingMeta;
  }

  /** Writes meta.json.tmp then renames it over meta.json, so readers never see a partial file. */
  async save(meta: MeetingMeta): Promise<void> {
    const file = this.metaPath(meta.id);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, file);
  }

  update(id: string, fn: (m: MeetingMeta) => void): Promise<MeetingMeta> {
    return this.serialized(id, async () => {
      const meta = await this.load(id);
      fn(meta);
      await this.save(meta);
      return meta;
    });
  }

  writeClip(id: string, clip: Omit<ClipMeta, 'id' | 'file'>, data: Buffer): Promise<ClipMeta> {
    return this.serialized(id, async () => {
      const meta = await this.load(id);
      const clipId = `c${pad(meta.clips.length + 1, 4)}`;
      const full: ClipMeta = { ...clip, id: clipId, file: `clips/${clipId}.ogg` };
      await writeFile(path.join(this.meetingDir(id), full.file), data);
      meta.clips.push(full);
      meta.participants[clip.userId] = clip.speakerName;
      await this.save(meta);
      return full;
    });
  }

  readClip(id: string, clip: ClipMeta): Promise<Buffer> {
    return readFile(path.join(this.meetingDir(id), clip.file));
  }

  async clipSize(id: string, clip: ClipMeta): Promise<number> {
    return (await stat(path.join(this.meetingDir(id), clip.file))).size;
  }

  async list(): Promise<MeetingMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const metas: MeetingMeta[] = [];
    for (const id of entries) {
      try {
        metas.push(await this.load(id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
      }
    }
    return metas;
  }

  async findLatestUnfinished(guildId: string): Promise<MeetingMeta | undefined> {
    const candidates = (await this.list()).filter((m) => m.guildId === guildId && m.endedAt && !isFinished(m));
    candidates.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return candidates[0];
  }

  /** Marks meetings left recording by a crash as ended, using the last clip's end as the end time. */
  async markInterrupted(): Promise<MeetingMeta[]> {
    const interrupted: MeetingMeta[] = [];
    for (const m of await this.list()) {
      if (m.endedAt) continue;
      interrupted.push(
        await this.update(m.id, (fresh) => {
          const lastEndMs = fresh.clips.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0);
          fresh.endedAt = fresh.clips.length
            ? new Date(Date.parse(fresh.startedAt) + lastEndMs).toISOString()
            : fresh.startedAt;
          fresh.stopReason = 'interrupted';
        }),
      );
    }
    return interrupted;
  }

  private serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }
}
