export type StepStatus = 'pending' | 'done' | 'failed';
export type ProviderName = 'gemini' | 'groq';

export interface ClipMeta {
  id: string;          // "c0001", sequential per meeting
  userId: string;
  speakerName: string; // display name when this clip was spoken
  startMs: number;     // offset from meeting start
  durationMs: number;  // packets * 20
  file: string;        // relative to meeting dir: "clips/c0001.ogg"
}

export interface BatchState {
  id: string;          // "b001"
  clipIds: string[];
  status: StepStatus;
  provider?: ProviderName;
  error?: string;
}

export interface TranscriptSegment {
  batchId: string;
  clipIds: string[];
  userId: string;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;        // may be '' (no intelligible speech)
}

export interface IdeaItem { idea: string; raisedBy: string | null }
export interface TaskItem { task: string; owner: string | null; due: string | null }
export interface MeetingSummary { overview: string; ideas: IdeaItem[]; tasks: TaskItem[] }

export interface MeetingMeta {
  id: string;
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  startedAt: string;               // ISO
  endedAt?: string;                // ISO; absent while recording
  stopReason?: 'command' | 'empty-channel' | 'max-duration' | 'disconnected' | 'interrupted';
  participants: Record<string, string>; // userId -> latest display name
  clips: ClipMeta[];
  batches: BatchState[];
  segments: TranscriptSegment[];
  summary?: MeetingSummary;
  steps: { transcribe: StepStatus; summarize: StepStatus; report: StepStatus };
  reportMessageId?: string;
  reportComplete?: boolean;        // posted with summary and no gaps
}

export interface AudioInput {
  id: string;                      // clip id, or first clip id of a turn
  speakerName: string;
  startMs: number;
  mimeType: 'audio/ogg';
  data: Buffer;
}

export interface Transcriber {
  readonly name: ProviderName;
  /** Returns text per AudioInput.id ('' when nothing intelligible). Throws ProviderError. */
  transcribe(inputs: AudioInput[]): Promise<Map<string, string>>;
}

export interface Summarizer {
  readonly name: ProviderName;
  /** transcript = rendered lines without file header. Throws ProviderError. */
  summarize(transcript: string, participants: string[]): Promise<MeetingSummary>;
}

export interface ReportMessage {
  content?: string;
  embeds: import('discord.js').APIEmbed[];
  files: { name: string; data: Buffer }[];
}

export interface ReportPoster {
  /** Posts messages to the guild's report channel; first message replies to replyTo if given. Returns first message id. */
  post(guildId: string, messages: ReportMessage[], replyTo?: string): Promise<string>;
  postText(guildId: string, text: string): Promise<void>;
}
