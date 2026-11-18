import type { APIEmbed } from 'discord.js';
import type { MeetingMeta, MeetingSummary, ReportMessage } from '../types.js';
import { formatDate, formatDuration, formatTime } from '../util/time.js';

const EMBED_COLOR = 0x5865f2;
const MAX_DESCRIPTION = 4096;
const MAX_MESSAGE_CHARS = 6000;
const MAX_EMBEDS_PER_MESSAGE = 10;

export interface ReportInput {
  meta: MeetingMeta;
  summary?: MeetingSummary;
  transcriptFile: { name: string; content: string };
  notes: string[];
  timezone: string;
  updated?: boolean;
}

/** `<@id>` when the name matches a participant's display name or its first word; otherwise the plain name. */
export function mentionFor(name: string | null, participants: Record<string, string>): string {
  if (name === null) return 'unassigned';
  const wanted = name.trim().toLowerCase();
  for (const [id, displayName] of Object.entries(participants)) {
    const full = displayName.trim().toLowerCase();
    if (wanted === full || wanted === full.split(/\s+/)[0]) return `<@${id}>`;
  }
  return name;
}

export function buildErrorText(meta: MeetingMeta, what: string, timezone: string): string {
  const start = new Date(meta.startedAt);
  return (
    `❌ Processing failed for the meeting in #${meta.voiceChannelName} ` +
    `(${formatDate(start, timezone)}, ${formatTime(start, timezone)}): ${what}. Run /retry to try again.`
  );
}

function buildTitle(meta: MeetingMeta, timezone: string, updated: boolean): string {
  const start = new Date(meta.startedAt);
  const end = new Date(meta.endedAt ?? meta.startedAt);
  const duration = formatDuration(end.getTime() - start.getTime());
  const title =
    `📋 Meeting Report — ${formatDate(start, timezone)}, ` +
    `${formatTime(start, timezone)}–${formatTime(end, timezone)} (${duration})`;
  return updated ? `🔁 Updated ${title}` : title;
}

function buildDescription(input: ReportInput): string {
  const { meta, summary, notes } = input;
  const blocks: string[] = [];

  if (notes.length > 0) blocks.push(notes.map((note) => `⚠️ ${note}`).join('\n'));
  blocks.push(`#${meta.voiceChannelName} · Participants: ${Object.values(meta.participants).join(', ')}`);

  if (summary) {
    blocks.push(`**Overview**\n${summary.overview}`);

    const ideas = summary.ideas.map(
      (i) => `• ${i.idea}${i.raisedBy ? ` — ${i.raisedBy}` : ''}`,
    );
    blocks.push(`**💡 Ideas discussed**\n${ideas.length > 0 ? ideas.join('\n') : '_None_'}`);

    const tasks = summary.tasks.map(
      (t) =>
        `• ${t.task} — ${mentionFor(t.owner, meta.participants)}${t.due ? ` (due: ${t.due})` : ''}`,
    );
    blocks.push(`**✅ Tasks**\n${tasks.length > 0 ? tasks.join('\n') : '_No tasks were assigned._'}`);
  }

  return blocks.join('\n\n');
}

/** Cuts `line` into pieces of at most `max` UTF-16 units, never splitting a surrogate pair. */
function hardSplit(line: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** Splits at line boundaries into chunks of at most `max` characters. */
function chunkDescription(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current !== '') chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    for (const piece of line.length > max ? hardSplit(line, max) : [line]) {
      if (current === '') current = piece;
      else if (current.length + 1 + piece.length <= max) current += `\n${piece}`;
      else {
        flush();
        current = piece;
      }
    }
  }
  flush();
  return chunks;
}

const embedSize = (embed: APIEmbed) => (embed.title?.length ?? 0) + (embed.description?.length ?? 0);

export function buildReportMessages(input: ReportInput): ReportMessage[] {
  const title = buildTitle(input.meta, input.timezone, input.updated ?? false);
  const chunks = chunkDescription(buildDescription(input), MAX_DESCRIPTION);

  const embeds: APIEmbed[] = chunks.map((description, i) => ({
    ...(i === 0 ? { title } : {}),
    description,
    color: EMBED_COLOR,
  }));

  const groups: APIEmbed[][] = [];
  let current: APIEmbed[] = [];
  let size = 0;
  for (const embed of embeds) {
    const next = embedSize(embed);
    if (current.length > 0 && (size + next > MAX_MESSAGE_CHARS || current.length >= MAX_EMBEDS_PER_MESSAGE)) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(embed);
    size += next;
  }
  groups.push(current);

  return groups.map((group, i) => ({
    embeds: group,
    files:
      i === 0
        ? [{ name: input.transcriptFile.name, data: Buffer.from(input.transcriptFile.content, 'utf8') }]
        : [],
  }));
}
