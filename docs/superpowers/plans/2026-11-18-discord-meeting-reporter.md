# Discord Meeting Reporter: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. The tasks are grouped into **waves**. Tasks in the same wave touch different files and can be given to parallel subagents.

**Goal:** Build a Discord bot that records a voice meeting on command and posts a Bangla transcript plus an English summary (overview, ideas, tasks) to a configured channel. It must run 24/7 for free.

**Architecture:**
- **Recording:** discord.js and `@discordjs/voice` (which handles Discord's DAVE encryption) receive each speaker's audio separately. Each utterance is saved as an Ogg/Opus clip on local disk.
- **Processing:** a resumable pipeline transcribes the clips with Gemini, falling back to Groq Whisper. It then summarizes with Gemini, falling back to a Groq chat model, and posts an embed with the transcript attached.
- **State:** every step's progress is stored in `recordings/<meetingId>/meta.json`, so `/retry` can resume after a failure.

**Tech Stack:**
- Node ≥ 22, TypeScript 5 (ESM, `NodeNext`)
- discord.js 14, `@discordjs/voice` 0.19, `prism-media` 1.3
- `@google/genai`, Groq REST through `fetch`
- zod, dotenv
- vitest, tsx

**Spec:** `docs/superpowers/specs/2026-11-18-discord-meeting-reporter-design.md`. Executors read both the spec and this plan.

## Global Constraints

- **Cost:** $0 to run. Only free tiers (Gemini, Groq) and free hosting (Northflank Sandbox; no card).
- **Voice library:** `@discordjs/voice` must be `^0.19.2`, the version that bundles DAVE support. Join with `selfDeaf: false` (required to receive audio) and `selfMute: true`.
- **No ffmpeg anywhere.** Audio stays Ogg/Opus, read and written with `prism-media`.
- **Intents:** `Guilds`, `GuildVoiceStates` only. Bot permissions: View Channel, Connect, Send Messages, Embed Links, Attach Files (permissions integer `1100800`).
- **Commands** are registered **globally** on every startup.
- **Language rules:**
  - The transcript is in Bangla script. English words that were spoken in English stay in English. It is verbatim, never translated.
  - The summary is in English.
- **Never invented:** no tasks, owners, or deadlines that nobody said. An unknown owner is shown as `unassigned`.
- **Discord limits:**
  - Never cut text off; split it across embeds or messages instead.
  - 4,096 characters per embed description, 6,000 total per message, 10 embeds per message, 256 per embed title.
- **Recording rules:**
  - Auto-stop **immediately** when no humans are left in the voice channel.
  - Hard cap of 2 hours per recording.
  - Clips shorter than 500 ms (25 packets of 20 ms) are dropped.
  - The silence that ends a clip is 1,000 ms.
- **Audio retention:** audio is never deleted while any step is unfinished. Finished meetings are deleted 7 days after `endedAt`.
- **Defaults:** `TIMEZONE=Asia/Dhaka`, `GEMINI_MODEL=gemini-flash-latest`, `GROQ_MODEL=whisper-large-v3`, `GROQ_SUMMARY_MODEL=openai/gpt-oss-120b`. All are configurable. Verify the model IDs at setup, since they change.
- **Secrets** live only in `.env`, which is git-ignored, along with `recordings/`, `dist/`, and `node_modules/`.
- **Imports** are ESM with `.js` extensions on relative paths. Use `strict` TypeScript.

## Git Workflow (applies to every task)

The repository is at `/home/sed/cAI/CashlessBot`, with default branch `main`. `main` only receives reviewed merges.

- **Branch per task:** `<type>/t<NN>-<slug>`, for example `feat/t02-meeting-store`, `chore/t01-project-setup`, or `docs/t08-deploy`. Each branch starts from the current `main`.
- **Worktree per task:** this is what lets tasks run in parallel without stepping on each other.
  ```bash
  git -C /home/sed/cAI/CashlessBot worktree add ../CashlessBot.worktrees/t02-meeting-store -b feat/t02-meeting-store main
  cd ../CashlessBot.worktrees/t02-meeting-store && npm ci
  ```
- **Conventional Commits:**
  - Format: `type(scope): imperative summary`, with a subject of 72 characters or less.
  - Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `build`.
  - The scope is the folder name, for example `feat(storage): add atomic meta writes`.
  - Commit at each green step. Never commit failing tests to a branch that's being handed back.
- **Before handing back:** run `npm run typecheck && npm test` in the worktree and make sure both pass. Do not merge.
- **The controller merges after review:**
  - If an `origin` remote exists, push the branch, then `gh pr create --base main` with a Conventional Commit title and a body that lists what changed and how it was tested. Then `gh pr merge --squash --delete-branch`.
  - With no remote, run `git merge --no-ff` locally and delete the branch.
  - Then `git worktree remove` the task's worktree.
- **Files:** a task touches only the files listed for it. `package.json` and `package-lock.json` change **only in Task 1**, so every dependency is installed there.

## Folder Structure

```
CashlessBot/
├── src/
│   ├── index.ts                     # entrypoint: wires everything (T11)
│   ├── config.ts                    # env → Config (T1)
│   ├── types.ts                     # shared domain types and interfaces (T1)
│   ├── util/retry.ts, util/time.ts  # (T1)
│   ├── storage/meeting-store.ts, storage/cleanup.ts            # (T2)
│   ├── audio/ogg.ts                 # (T3)
│   ├── transcription/batching.ts    # (T4)
│   ├── transcription/prompt.ts, parse.ts, gemini-transcriber.ts, groq-transcriber.ts  # (T6)
│   ├── transcription/transcribe-batch.ts                        # (T10)
│   ├── summary/prompt.ts, parse.ts, gemini-summarizer.ts, groq-summarizer.ts          # (T7)
│   ├── report/transcript.ts         # (T4)
│   ├── report/report-format.ts      # (T5)
│   ├── recording/recorder.ts, session-manager.ts, voice-connection.ts                 # (T9)
│   ├── pipeline/process-meeting.ts  # (T10)
│   └── discord/commands.ts, register-commands.ts, report-poster.ts, handlers.ts       # (T11)
├── tests/                           # mirrors src/, e.g. tests/storage/meeting-store.test.ts
├── Dockerfile, .dockerignore        # (T8)
├── docs/setup.md, docs/deploy.md    # (T8)
├── docs/superpowers/{specs,plans}/
├── .env.example, .gitignore, README.md (T11)
├── package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
```

## Waves

| Wave | Tasks (parallel within a wave) | Depends on |
|---|---|---|
| 0 | T1 Foundation | — |
| 1 | T2 Storage · T3 Ogg · T4 Batching and transcript · T5 Report format · T6 Transcribers · T7 Summarizers | T1 merged |
| 2 | T9 Recording · T10 Pipeline · T8 Container and docs | all of wave 1 merged |
| 3 | T11 Discord wiring | wave 2 merged |
| 4 | T12 End-to-end check and deploy (with the user) | T11 merged |

## Review Focus

These are the five conditions a user is most likely to hit that the spec doesn't spell out. Each one gets a test in the task named.

1. **The bot restarts or crashes mid-meeting.** The clips on disk must survive. On startup the meeting is marked ended, a notice is posted, and `/retry` processes it. Covered by `markInterrupted` in **T2** and the startup notice in **T11**.
2. **The bot is kicked or disconnected from voice.** The recording stops with reason `disconnected` and gets processed, not lost. Covered in **T9**.
3. **Nobody spoke.** Post "No speech was recorded in this meeting." with no AI calls. Covered in **T10**.
4. **The model returns broken output:** code fences, missing or extra clip IDs, or invalid JSON. Fences are tolerated, missing clips become empty text, and invalid output raises a retryable error. Covered in **T6** and **T7**.
5. **Someone joins mid-meeting or changes nickname.** They appear in the participants list, and each line uses the name the speaker had when they spoke. Covered in **T2** (`writeClip` updates participants) and **T9**.

---

### Task 1: Foundation (wave 0)

Branch: `chore/t01-project-setup`.

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`
- Modify: `.gitignore` (it already exists; keep its entries)
- Create: `src/types.ts`, `src/config.ts`, `src/util/retry.ts`, `src/util/time.ts`
- Test: `tests/config.test.ts`, `tests/util/retry.test.ts`, `tests/util/time.test.ts`

**Interfaces:**
- Produces: everything in `src/types.ts` below, plus:
  - `loadConfig(env: NodeJS.ProcessEnv): Config`
  - `withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>`
  - `isRetryableError(e: unknown): boolean`
  - `class ProviderError extends Error { status?: number; retryable: boolean }`
  - `formatOffset(ms: number): string`, which returns `"HH:MM:SS"`
  - `formatDate(d: Date, tz: string): string`, which returns `"18 Nov 2026"`
  - `formatTime(d: Date, tz: string): string`, which returns `"9:00 PM"`
  - `formatDuration(ms: number): string`, which returns `"52 min"` or `"1 h 5 min"`

- [ ] **Step 1: Scaffold the project and install everything**

```bash
npm init -y
npm pkg set type=module engines.node=">=22" \
  scripts.dev="tsx watch src/index.ts" scripts.build="tsc -p tsconfig.build.json" \
  scripts.start="node dist/index.js" scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
npm i discord.js@^14 @discordjs/voice@^0.19.2 prism-media@^1.3.5 @google/genai zod dotenv
npm i -D typescript@^5 tsx vitest @types/node
```

- `tsconfig.json`: `target` es2023, `module`/`moduleResolution` NodeNext, `strict`, `noEmit`, `skipLibCheck`, and `include` both `["src", "tests"]`.
- `tsconfig.build.json`: extends `tsconfig.json`, includes only `src`, with `noEmit: false`, `outDir` `dist`, `rootDir` `src`.
- `vitest.config.ts`: `test.include = ["tests/**/*.test.ts"]`.
- `.env.example`: every variable from the spec's Configuration table, each with a one-line comment. Include `REPORT_CHANNELS=111111111111111111:222222222222222222`, plus the defaults from Global Constraints and `RECORDINGS_DIR=./recordings`.

- [ ] **Step 2: Write `src/types.ts`.** This is the contract for every other task, so write it exactly as follows.

```ts
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
```

`Config`, defined in `src/config.ts`:

```ts
{ discordToken; discordClientId; reportChannels: Map<string, string>; timezone; recordingsDir;
  gemini: { apiKey; model }; groq?: { apiKey; transcribeModel; summaryModel }; primaryTranscriber: ProviderName }
```

- [ ] **Step 3: Write the failing tests**
- `config.test.ts`:
  - parses `REPORT_CHANNELS="g1:c1, g2:c2"` into a Map with 2 entries
  - applies every default from Global Constraints
  - throws, naming the variable, when `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, or `GEMINI_API_KEY` is missing
  - throws when `TRANSCRIBER=groq` and there's no `GROQ_API_KEY`
  - `groq` is `undefined` when there's no Groq key
  - throws on a malformed pair like `"g1"`
- `retry.test.ts`, using an injected `sleep` so no real delays happen:
  - retries a `ProviderError` with status 429 and then succeeds on attempt 3
  - stops after `attempts` (default 4), with delays of 2000, 4000, and 8000 ms
  - does not retry `new ProviderError('bad', { status: 400, retryable: false })`
  - `isRetryableError` is true for status 429 or ≥ 500, for `retryable: true`, and for errors whose `code` is `ECONNRESET` or `ETIMEDOUT` or whose message contains `fetch failed`
- `time.test.ts`:
  - `formatOffset(3_723_000) === "01:02:03"`
  - `formatDuration(52*60_000) === "52 min"` and `formatDuration(65*60_000) === "1 h 5 min"`
  - `formatTime(new Date('2026-11-18T15:00:00Z'), 'Asia/Dhaka') === "9:00 PM"`
  - `formatDate(...) === "18 Nov 2026"`

- [ ] **Step 4: Run `npm test` and confirm the tests fail.** Expected: FAIL, because the modules aren't found.
- [ ] **Step 5: Implement `config.ts`, `retry.ts`, and `time.ts`.** Use a zod object for the environment and `Intl.DateTimeFormat` for times. The `ProviderError` constructor is `(message: string, opts?: { status?: number; retryable?: boolean; cause?: unknown })`. When `retryable` isn't given, it's derived from the status.
- [ ] **Step 6: Run `npm run typecheck && npm test` and confirm both pass.**
- [ ] **Step 7: Commit.** For example `build: scaffold TypeScript project and dependencies` and `feat(core): add shared types, config, retry and time utils`. Then hand back for review and merge.

---

### Task 2: Meeting store and cleanup (wave 1)

Branch: `feat/t02-meeting-store`.

**Files:**
- Create: `src/storage/meeting-store.ts`, `src/storage/cleanup.ts`
- Test: `tests/storage/meeting-store.test.ts`, `tests/storage/cleanup.test.ts`

**Interfaces:**
- Consumes: `MeetingMeta`, `ClipMeta` from `types.ts`.
- Produces:
  - `class MeetingStore`, created with `new MeetingStore(rootDir: string)`. Its methods:
    - `meetingDir(id: string): string`
    - `create(init: { guildId: string; voiceChannelId: string; voiceChannelName: string; startedAt: Date }): Promise<MeetingMeta>`. The id is `YYYY-MM-DD_HH-mm-ss_<last 4 digits of guildId>` in UTC. All steps start `pending`, and the arrays start empty.
    - `load(id): Promise<MeetingMeta>`
    - `save(meta): Promise<void>`
    - `update(id, fn: (m: MeetingMeta) => void): Promise<MeetingMeta>`. Applies `fn`, saves, and returns the new meta. Calls are serialized per meeting.
    - `writeClip(id, clip: Omit<ClipMeta, 'id' | 'file'>, data: Buffer): Promise<ClipMeta>`. Assigns the next `cNNNN` id, writes the file, appends the clip, and sets `participants[userId] = speakerName`. Serialized per meeting.
    - `readClip(id, clip: ClipMeta): Promise<Buffer>`
    - `clipSize(id, clip: ClipMeta): Promise<number>`
    - `list(): Promise<MeetingMeta[]>`
    - `findLatestUnfinished(guildId): Promise<MeetingMeta | undefined>`. Latest by `startedAt`, among meetings with `endedAt` set and `!isFinished`.
    - `markInterrupted(): Promise<MeetingMeta[]>`. For every meeting without `endedAt`: sets `endedAt` to the last clip's end (or `startedAt` if it has no clips) and `stopReason: 'interrupted'`. Returns those meetings.
  - `isFinished(m: MeetingMeta): boolean`. True when all three steps are `done` and `reportComplete === true`.
  - `cleanupOldMeetings(store: MeetingStore, now: Date, maxAgeDays = 7): Promise<string[]>`. Deletes the folders of finished meetings whose `endedAt` is more than 7 days before `now`, and returns their ids.

- [ ] **Step 1: Write the failing tests.** Each test uses a temporary directory from `fs.mkdtemp`.
  - `create` then `load` round-trips the meta, and the `clips/` folder exists.
  - `save` is atomic: it writes `meta.json.tmp` and then renames it. After `save`, no `.tmp` file is left behind.
  - **20 concurrent `writeClip` calls** produce 20 clips with unique ids `c0001`–`c0020`, 20 files, and a meta containing all 20.
  - `writeClip` for a user who joined later adds them to `participants`. A second clip with a new nickname updates `participants`, while the first clip keeps its old `speakerName`.
  - `findLatestUnfinished` ignores meetings that are still recording or finished, and returns the newest of the rest.
  - `markInterrupted` sets `endedAt` and `stopReason` on an un-ended meeting, and leaves ended ones untouched.
  - `cleanupOldMeetings` deletes a finished meeting that ended 8 days ago. It keeps a finished one from 6 days ago, and keeps an unfinished one from 30 days ago.
- [ ] **Step 2: Run `npx vitest run tests/storage` and confirm the tests fail.**
- [ ] **Step 3: Implement.** Serialize calls with a per-meeting promise chain, kept in a `Map<string, Promise<unknown>>`.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run tests/storage` and confirm both pass.**
- [ ] **Step 5: Commit** `feat(storage): add meeting store with atomic, serialized writes`, then `feat(storage): add 7-day cleanup of finished meetings`.

---

### Task 3: Ogg/Opus encode, decode and concat (wave 1)

Branch: `feat/t03-ogg`.

**Files:**
- Create: `src/audio/ogg.ts`
- Test: `tests/audio/ogg.test.ts`

**Interfaces:**
- Produces:
  - `encodeOggOpus(packets: Buffer[]): Promise<Buffer>`. Throws a `RangeError` when `packets` is empty.
  - `decodeOggOpusPackets(data: Buffer): Promise<Buffer[]>`. Returns the audio packets only, not the headers.
  - `concatOggOpus(files: Buffer[]): Promise<Buffer>`
  - `FRAME_MS = 20`

- [ ] **Step 1: Write the failing tests.** The fixtures are 30 random packets of 40–120 bytes. Content isn't validated, so real Opus isn't needed.
  - `decode(await encode(p))` deep-equals `p`.
  - The output starts with the bytes `OggS`.
  - `decode(await concat([a, b]))` equals `[...decode(a), ...decode(b)]`.
  - `encode([])` rejects with a `RangeError`.
- [ ] **Step 2: Run `npx vitest run tests/audio` and confirm the tests fail.**
- [ ] **Step 3: Implement it with prism-media.**
  - Encoding uses `new prism.opus.OggLogicalBitstream({ opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48000 }), pageSizeControl: { maxPackets: 10 }, crc: true })`. Write every packet, end the stream, and collect the output.
  - Decoding uses `new prism.opus.OggDemuxer()`.
  - If prism's typings lack these classes, add `src/audio/prism-media.d.ts` with minimal declarations.
- [ ] **Step 4: Run the tests again and confirm they pass**, along with `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(audio): add Ogg/Opus encode, decode and concat`.

---

### Task 4: Batching and transcript assembly (wave 1)

Branch: `feat/t04-batching-transcript`.

**Files:**
- Create: `src/transcription/batching.ts`, `src/report/transcript.ts`
- Test: `tests/transcription/batching.test.ts`, `tests/report/transcript.test.ts`

**Interfaces:**
- Consumes: the types, and `formatOffset`, `formatDate`, `formatTime`, `formatDuration`.
- Produces:
  - `BATCH_LIMITS = { maxSpeechMs: 300_000, maxBytes: 15 * 1024 * 1024, maxClips: 100 }`
  - `planBatches(clips: ClipMeta[], sizes: Map<string, number>, limits = BATCH_LIMITS): BatchState[]`. Sorts the clips by `startMs`, then fills batches in order until adding the next clip would exceed any limit. Ids are `b001`, `b002`, and so on. Every batch starts `pending`.
  - `groupTurns(clips: ClipMeta[], maxGapMs = 3000, maxTurnMs = 120_000): ClipMeta[][]`. Groups clips that are consecutive in `startMs` order and share a `userId`. A new turn starts when the gap from the previous clip's end is more than `maxGapMs`, or when the turn would grow past `maxTurnMs`.
  - `type TranscriptLine = { kind: 'speech'; startMs: number; speakerName: string; text: string } | { kind: 'gap'; startMs: number; endMs: number }`
  - `buildTranscriptLines(meta: MeetingMeta, mergeGapMs = 3000): TranscriptLine[]`:
    - Takes the segments with non-empty text, sorted by `startMs`.
    - Merges consecutive segments that have the same `userId` and a gap of `mergeGapMs` or less, joining their text with a space.
    - Adds one `gap` line for each batch with `status: 'failed'`, spanning that batch's first clip start to its last clip end.
    - Interleaves everything by `startMs`.
  - `renderTranscriptLines(lines: TranscriptLine[]): string`. Output looks like `[00:03:12] Rahim: text` and `[00:12:30] [untranscribed audio 00:12:30–00:13:10]`, joined with `\n`.
  - `renderTranscriptFile(meta: MeetingMeta, lines: TranscriptLine[], tz: string): string`. A header followed by a blank line and then the lines. The header is:
    - `Meeting transcript — <date>, <start>–<end> (<duration>)`
    - `Channel: #<voiceChannelName>`
    - `Participants: <comma-separated names>`
  - `transcriptFileName(meta: MeetingMeta, tz: string): string`, which returns `transcript-YYYY-MM-DD-HHmm.txt`

- [ ] **Step 1: Write the failing tests.**
  - `planBatches`:
    - 12 clips of 30 s each make 2 batches (10 clips, then 2).
    - A size limit forces a split.
    - The clip ids across batches equal all the input ids, in time order.
  - `groupTurns`:
    - A, A, B, A makes 3 turns.
    - A 4 s gap splits a turn.
    - A turn never goes past 120 s.
  - `buildTranscriptLines`:
    - Same-speaker segments 1 s apart merge into one line.
    - Segments 5 s apart don't.
    - Empty-text segments are dropped.
    - A failed batch produces a `gap` line in the right position.
  - `renderTranscriptFile`: the exact header and line format for a 52-minute meeting at 9:00 PM Dhaka time.
  - Bangla text passes through byte-for-byte unchanged.
- [ ] **Step 2: Run `npx vitest run tests/transcription/batching.test.ts tests/report/transcript.test.ts` and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again and confirm they pass**, along with `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(transcription): add clip batching and speaker turns`, then `feat(report): render merged transcript with gap markers`.

---

### Task 5: Report message formatting (wave 1)

Branch: `feat/t05-report-format`.

**Files:**
- Create: `src/report/report-format.ts`
- Test: `tests/report/report-format.test.ts`

**Interfaces:**
- Consumes: `MeetingMeta`, `MeetingSummary`, `ReportMessage`, and the time utilities.
- Produces:
  - `buildReportMessages(input: { meta: MeetingMeta; summary?: MeetingSummary; transcriptFile: { name: string; content: string }; notes: string[]; timezone: string; updated?: boolean }): ReportMessage[]`
  - `mentionFor(name: string | null, participants: Record<string, string>): string`. Returns `<@id>` on a case-insensitive match against a display name or its first word. Otherwise it returns the name, or `unassigned` when the name is `null`.
  - `buildErrorText(meta: MeetingMeta, what: string, timezone: string): string`

**Layout.** This is copy the spec fixes, so build it exactly:
- The title is `📋 Meeting Report — <date>, <start>–<end> (<duration>)`. When `updated` is true, the title starts with `🔁 Updated `.
- The description is these blocks, joined by a blank line:
  1. The notes, each line starting with `⚠️ `.
  2. `#<voiceChannelName> · Participants: <names>`
  3. `**Overview**\n<overview>`
  4. `**💡 Ideas discussed**\n• <idea>`, with ` — <raisedBy>` appended when it's known. If there are no ideas, the block body is `_None_`.
  5. `**✅ Tasks**\n• <task> — <mentionFor(owner)>`, with ` (due: <due>)` appended when there's a due date. If there are no tasks, the block body is `_No tasks were assigned._`.

  Blocks 3 to 5 are left out when there's no summary.
- The transcript `.txt` is attached to the first message only. Embed color: `0x5865F2`.
- **Splitting:**
  - Split at line boundaries into description chunks of 4,096 characters or less. Hard-split any single line longer than that.
  - Continuation embeds have no title.
  - Pack embeds into messages so each message stays at or under 6,000 characters and 10 embeds.
- `buildErrorText` returns `❌ Processing failed for the meeting in #<channel> (<date>, <start>): <what>. Run /retry to try again.`

- [ ] **Step 1: Write the failing tests.**
  - The normal case gives one message with one embed, containing the exact title and the exact description for a fixed fixture.
  - `mentionFor("rahim", {u1: "Rahim Uddin"}) === "<@u1>"`, `mentionFor("Someone", …) === "Someone"`, and `mentionFor(null, …) === "unassigned"`.
  - No summary, plus one note, gives a description with the warning and the header only, and still has the file attached.
  - 60 ideas of 200 characters each:
    - every embed description is 4,096 characters or less
    - every message's total is 6,000 characters or less
    - the joined descriptions contain every idea
    - only the first message has `files`
  - With `updated: true`, the title starts with `🔁 Updated `.
- [ ] **Step 2: Run `npx vitest run tests/report/report-format.test.ts` and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again and confirm they pass**, along with `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(report): build split-safe Discord report embeds`.

---

### Task 6: Gemini and Groq transcribers (wave 1)

Branch: `feat/t06-transcribers`.

**Files:**
- Create: `src/transcription/prompt.ts`, `src/transcription/parse.ts`, `src/transcription/gemini-transcriber.ts`, `src/transcription/groq-transcriber.ts`
- Test: `tests/transcription/parse.test.ts`, `tests/transcription/gemini-transcriber.test.ts`, `tests/transcription/groq-transcriber.test.ts`

**Interfaces:**
- Consumes: `Transcriber`, `AudioInput`, `ProviderError`.
- Produces:
  - `TRANSCRIBE_PROMPT: string`
  - `parseTranscriptionResponse(raw: string, expectedIds: string[]): Map<string, string>`
  - `class GeminiTranscriber implements Transcriber`, created with `new GeminiTranscriber({ apiKey, model, client? })`. `client` is any object with `models.generateContent(req)`, so tests can inject a fake. It defaults to `new GoogleGenAI({ apiKey })`.
  - `class GroqTranscriber implements Transcriber`, created with `new GroqTranscriber({ apiKey, model, fetchFn = fetch, minIntervalMs = 3000, sleep? })`.

**The prompt.** Write it exactly:

```
You are transcribing a Discord meeting. Each audio clip below is one person speaking, labeled with its clip ID and speaker name. For every clip, write exactly what was said.
Rules:
- Write Bangla speech in Bangla script. Keep words that were spoken in English in English (Latin script), exactly as spoken.
- Verbatim: do not translate, summarize, correct grammar, or add commentary.
- If a clip has no intelligible speech (noise, silence, breathing), return an empty string for it. Never guess or invent words.
- Return JSON only: an array with one object per clip, {"clip_id": "<id>", "text": "<transcript>"}, in the same order as the clips.
```

**Gemini request:**
- `contents` is a single user turn. Its parts are the prompt, then, for each input, a text part `Clip <id> — speaker: <speakerName>` followed by an `inlineData` part with `mimeType: 'audio/ogg'` and the data as base64.
- `config`: `temperature: 0`, `responseMimeType: 'application/json'`, and a JSON schema for an array of `{clip_id: string, text: string}`.
- Map SDK errors that carry a `status` to `ProviderError` with the same status.

**Groq requests:**
- One request per input, made sequentially, waiting at least `minIntervalMs` between them.
- Each request is a `POST https://api.groq.com/openai/v1/audio/transcriptions` with `Authorization: Bearer <key>`. The body is `FormData` with these fields:
  - `file`: a `Blob` of type `audio/ogg`, named `<id>.ogg`
  - `model`
  - `language`: `bn`
  - `temperature`: `0`
  - `response_format`: `json`
- Read `.text` from the response and trim it. A non-2xx response throws `ProviderError` with that status.

- [ ] **Step 1: Write the failing tests.**
  - Parsing:
    - A plain JSON array parses.
    - A ```` ```json ```` fenced array parses.
    - An extra unknown id is ignored.
    - A missing expected id maps to `''`.
    - A non-array (`{"a":1}`) or invalid JSON throws a `ProviderError` with `retryable: true`.
  - Gemini, using a fake client that records the request:
    - The parts are in order: prompt, label, audio, label, audio, and so on.
    - The audio part has `inlineData.mimeType === 'audio/ogg'`.
    - The model is passed through.
    - The result map is keyed by clip id.
    - A fake that throws `{ status: 429 }` makes the transcriber reject with a `ProviderError` with status 429.
  - Groq, using a fake `fetchFn` and `sleep`:
    - Two inputs produce two calls, with `language=bn` and `model` in the form.
    - `sleep` is called with roughly 3,000 ms between the calls.
    - A 429 response gives a `ProviderError` with status 429.
    - `" টেস্ট "` is trimmed to `"টেস্ট"`.
- [ ] **Step 2: Run `npx vitest run tests/transcription` and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again and confirm they pass**, along with `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(transcription): add Gemini transcriber with JSON parsing`, then `feat(transcription): add Groq Whisper backup transcriber`.

---

### Task 7: Gemini and Groq summarizers (wave 1)

Branch: `feat/t07-summarizers`.

**Files:**
- Create: `src/summary/prompt.ts`, `src/summary/parse.ts`, `src/summary/gemini-summarizer.ts`, `src/summary/groq-summarizer.ts`
- Test: `tests/summary/parse.test.ts`, `tests/summary/summarizers.test.ts`

**Interfaces:**
- Consumes: `Summarizer`, `MeetingSummary`, `ProviderError`.
- Produces:
  - `buildSummaryPrompt(transcript: string, participants: string[]): string`
  - `parseSummaryResponse(raw: string): MeetingSummary`
  - `class GeminiSummarizer implements Summarizer`, created with `new GeminiSummarizer({ apiKey, model, client? })`
  - `class GroqSummarizer implements Summarizer`, created with `new GroqSummarizer({ apiKey, model, fetchFn = fetch })`

**The prompt.** Write it exactly, with the participants and transcript appended at the end:

```
Below is the transcript of a team meeting held on Discord. It is mostly in Bangla, sometimes mixed with English. Lines look like "[HH:MM:SS] Speaker: text".
Write a meeting report in English for people who were not there. It must be short, clear and contain every key point.
Return JSON only, in this shape:
{"overview": string, "ideas": [{"idea": string, "raisedBy": string|null}], "tasks": [{"task": string, "owner": string|null, "due": string|null}]}
- overview: 3-5 plain sentences: what the meeting was about and what was decided or concluded.
- ideas: every distinct idea, proposal or suggestion discussed, one short sentence each. raisedBy is the speaker's name if clear, otherwise null.
- tasks: only tasks someone actually stated, accepted or was assigned in the meeting. owner is a participant's name only if the transcript makes clear who will do it, otherwise null. due only if a deadline was said, written as said (e.g. "Friday", "next week"), otherwise null. Never invent tasks, owners or deadlines.
- No filler, greetings or generic advice. If there were no ideas or no tasks, return an empty list.
- Do not guess what was said in parts marked [untranscribed audio].

Participants: <comma-separated>

Transcript:
<transcript>
```

**Requests:**
- Gemini: `temperature: 0.2`, `responseMimeType: 'application/json'`, and a schema that matches the shape above.
- Groq: `POST https://api.groq.com/openai/v1/chat/completions` with `{ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }`. Parse `choices[0].message.content`.

- [ ] **Step 1: Write the failing tests.**
  - Parsing:
    - Valid JSON parses.
    - Fenced JSON parses.
    - An `owner` or `due` of `""` becomes `null`.
    - Missing `ideas` or `tasks` default to `[]`.
    - Fields are trimmed.
    - An empty `overview` or invalid JSON throws a `ProviderError` with `retryable: true`.
  - Prompt: it contains every participant name and the transcript verbatim, including Bangla.
  - Fakes for both summarizers: the request carries the model and JSON mode, and the parsed result is returned. A 503 response gives a `ProviderError` with status 503.
- [ ] **Step 2: Run `npx vitest run tests/summary` and confirm the tests fail.**
- [ ] **Step 3: Implement it.** Validate the parsed result with zod.
- [ ] **Step 4: Run the tests again and confirm they pass**, along with `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(summary): add summary prompt and strict parser`, then `feat(summary): add Gemini and Groq summarizers`.

---

### Task 8: Container, hosting and setup docs (wave 2, parallel)

Branch: `docs/t08-deploy`. The spec section "Hosting and updates" is the authority.

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/setup.md`, `docs/deploy.md`

**Contents:**
- `Dockerfile`, multi-stage, based on `node:22-bookworm-slim`. It must be glibc, because `@snazzah/davey` ships glibc prebuilt binaries.
  - Build stage: `npm ci`, then `npm run build`.
  - Runtime stage: `npm ci --omit=dev`, copy `dist/`, set `ENV NODE_ENV=production`, run `USER node`, and set `CMD ["node", "dist/index.js"]`.
  - No `EXPOSE`. The bot serves no HTTP.
- `.dockerignore`: `node_modules`, `dist`, `.env`, `recordings`, `.git`, `.superpowers`, `coverage`, `*.log`.
- `docs/setup.md`, step by step:
  1. Create the Discord application and bot. Copy the token and client ID. No privileged intents.
  2. Get a Gemini API key from Google AI Studio, and check the current free Flash model ID.
  3. Optionally get a Groq API key. Check the model IDs with `curl https://api.groq.com/openai/v1/models`.
  4. Set up a personal test server.
  5. Write a **ready-to-paste message for the server admin**. It contains:
     - the invite URL `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1100800`
     - what the bot does, and that it announces when it's recording
     - the exact permissions and why it needs each one
     - that private channels need the bot's role added
     - that commands can be restricted under Server Settings → Integrations
  6. Get server and channel IDs with Developer Mode, and fill in `REPORT_CHANNELS`.
  7. Run locally with `cp .env.example .env`, `npm ci`, `npm run dev`. This is also fallback 2, running on your own PC: `npm run build && npm start`.
- `docs/deploy.md`:
  - Northflank Sandbox: sign up with GitHub, no card needed.
  - Create a project, then a **combined service** from the GitHub repo `NightmareXIX/CashlessBot`, branch `main`, build type Dockerfile.
  - Remove every port, because there's no HTTP.
  - Add every `.env.example` variable as a runtime secret or environment variable.
  - Use the smallest free instance. Turn on **auto-deploy on push to main**.
  - Watch the logs for `Ready as …`.
  - **UDP check:** in the test server, run `/join`, talk for 30 s, then `/stop`. A report means voice works. If voice never connects, or no clips are recorded, outbound UDP is blocked; move to a fallback.
  - Fallback 1: bot-hosting.net. Upload the repo or `git clone` it, set the start command to `npm ci && npm run build && node dist/index.js`, set env vars in the panel, and renew every 4 days.
  - Fallback 2: your own PC.
  - **Updating:** merge a PR into `main`, and Northflank redeploys. Only permission changes ever need the admin.
  - **Ephemeral disk note:** `/retry` only covers meetings recorded since the last restart.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Verify.**
  - Run `grep -c "1100800" docs/setup.md`. Expected: ≥ 1.
  - Run `grep -E "^FROM node:22-bookworm-slim" -c Dockerfile`. Expected: 2.
  - If `docker` is available, run `docker build -t cashlessbot .`. Expected: success. Otherwise note that it was skipped in the report.
- [ ] **Step 3: Commit** `build(docker): add container image for hosting`, then `docs: add setup and Northflank deploy guides`.

---

### Task 9: Recording and session management (wave 2)

Branch: `feat/t09-recording`.

**Files:**
- Create: `src/recording/recorder.ts`, `src/recording/session-manager.ts`, `src/recording/voice-connection.ts`
- Test: `tests/recording/recorder.test.ts`, `tests/recording/session-manager.test.ts`

**Interfaces:**
- Consumes: `MeetingStore` (T2), `encodeOggOpus` and `FRAME_MS` (T3), `MeetingMeta`.
- Produces:
  - `interface VoiceReceiverLike { speaking: EventEmitter /* emits 'start'(userId) */; subscribe(userId: string, opts: { end: { behavior: EndBehaviorType; duration: number } }): Readable; subscriptions: Map<string, unknown> }`
  - `interface VoiceConnectionLike { receiver: VoiceReceiverLike; onLost(cb: () => void): void; destroy(): void }`
  - `class MeetingRecorder`, created with `new MeetingRecorder(meta: MeetingMeta, receiver: VoiceReceiverLike, deps: { store: MeetingStore; resolveSpeaker(userId: string): Promise<{ name: string; isBot: boolean }>; now?: () => number })`.
    - `start(): void`
    - `stop(): Promise<void>`. Ends the active streams and waits until every pending clip is written.
  - `CLIP_SILENCE_MS = 1000`, `MIN_CLIP_PACKETS = 25`
  - `type StopReason = 'command' | 'empty-channel' | 'max-duration' | 'disconnected'`
  - `class SessionManager`, created with `new SessionManager(deps: { store: MeetingStore; connect(guildId: string, channelId: string): Promise<VoiceConnectionLike>; resolveSpeaker(guildId: string, userId: string): Promise<{ name: string; isBot: boolean }>; onStopped(meetingId: string, reason: StopReason): void; maxDurationMs?: number /* 7_200_000 */ })`. Methods:
    - `start(p: { guildId; voiceChannelId; voiceChannelName }): Promise<{ ok: true; meetingId: string } | { ok: false; reason: 'already-recording'; voiceChannelId: string }>`
    - `stop(guildId: string, reason: StopReason): Promise<string | undefined>`. Returns the meetingId. It's idempotent: concurrent calls stop the session once.
    - `get(guildId): { meetingId: string; voiceChannelId: string } | undefined`
    - `handleHumanCount(guildId: string, channelId: string, humans: number): void`. Calls `stop(guildId, 'empty-channel')` immediately when `humans === 0` and `channelId` is the active channel.
  - `connectToVoice(guild: Guild, channelId: string): Promise<VoiceConnectionLike>`, in `voice-connection.ts`. It:
    - calls `joinVoiceChannel({ selfDeaf: false, selfMute: true, … })` and waits up to 20 s for `VoiceConnectionStatus.Ready`
    - on `Disconnected`, races `Signalling` and `Connecting` for 5 s, and if neither arrives, destroys the connection and fires `onLost`
    - also fires `onLost` on `Destroyed` when that wasn't caused by `destroy()`

    This wrapper is thin and is checked by typecheck only.

**Recorder behavior:**
- On `speaking 'start'`, it ignores the user if `receiver.subscriptions.has(userId)`, if the recorder is stopping, or if `isBot` (cache the bot check per user).
- `startMs = now() - Date.parse(meta.startedAt)`.
- It collects the packets until the stream ends (`AfterSilence`, `CLIP_SILENCE_MS`). If there are at least `MIN_CLIP_PACKETS`, it encodes them and calls `store.writeClip` with `durationMs = packets * FRAME_MS` and the speaker name resolved at that moment.
- Errors on one clip are logged, not thrown.

**SessionManager.start:**
1. Creates the meeting.
2. Connects.
3. Starts the recorder.
4. Registers `onLost`, which calls `stop(…, 'disconnected')`.
5. Sets the max-duration timer, which calls `stop(…, 'max-duration')`.

**SessionManager.stop:** stops the recorder, destroys the connection, clears the timer, saves `endedAt` and `stopReason`, removes the session, and calls `onStopped`.

- [ ] **Step 1: Write the failing tests.** Use a fake receiver: `speaking` is an EventEmitter, and `subscribe` returns a `PassThrough` in object mode that the test pushes Buffers into and then ends. Use a fake store or a real store in a temp dir.
  - 30 packets give 1 clip with `durationMs === 600` and the right `startMs`.
  - 10 packets give no clip.
  - Bot users are ignored.
  - A duplicate `start` while subscribed creates only one subscription.
  - **Nickname:** `resolveSpeaker` returns "Rahim" for the first clip and "Rahim (PM)" for the second. The clips keep their own names, and the participants map holds the latest.
  - A **late joiner**'s clip adds them to the participants.
  - `stop()` waits for an in-flight clip before resolving.
  - Session manager, using fake timers:
    - A second `start` in the same guild gives `already-recording`.
    - `handleHumanCount(g, ch, 0)` stops with `empty-channel` and calls `onStopped` once.
    - A count of 1 doesn't stop it.
    - A count for a different channel is ignored.
    - At 2 h it stops with `max-duration`.
    - **Firing `onLost` stops it with `disconnected`, and the meeting has `endedAt`.**
    - Concurrent `stop` calls give one `onStopped`.
- [ ] **Step 2: Run `npx vitest run tests/recording` and confirm the tests fail.**
- [ ] **Step 3: Implement all three files.**
- [ ] **Step 4: Run `npm run typecheck && npx vitest run tests/recording` and confirm both pass.**
- [ ] **Step 5: Commit** `feat(recording): record per-speaker Opus clips`, then `feat(recording): add session manager with auto-stop`, then `feat(recording): add resilient voice connection wrapper`.

---

### Task 10: Processing pipeline (wave 2)

Branch: `feat/t10-pipeline`.

**Files:**
- Create: `src/transcription/transcribe-batch.ts`, `src/pipeline/process-meeting.ts`
- Test: `tests/transcription/transcribe-batch.test.ts`, `tests/pipeline/process-meeting.test.ts`

**Interfaces:**
- Consumes:
  - `MeetingStore` and `isFinished` (T2)
  - `concatOggOpus` (T3)
  - `planBatches`, `groupTurns`, `buildTranscriptLines`, `renderTranscriptLines`, `renderTranscriptFile`, `transcriptFileName` (T4)
  - `buildReportMessages`, `buildErrorText` (T5)
  - `withRetry` (T1)
  - the `Transcriber`, `Summarizer`, and `ReportPoster` interfaces
- Produces:
  - `transcribeBatch(batch: BatchState, clips: ClipMeta[], deps: { readClip(c: ClipMeta): Promise<Buffer>; primary: Transcriber; fallback?: Transcriber; retry?: typeof withRetry }): Promise<{ segments: TranscriptSegment[]; provider: ProviderName }>`
  - `processMeeting(meetingId: string, deps: { store: MeetingStore; transcribers: { primary: Transcriber; fallback?: Transcriber }; summarizers: { primary: Summarizer; fallback?: Summarizer }; poster: ReportPoster; timezone: string; retry?: typeof withRetry }): Promise<MeetingMeta>`
  - `NOTE_SUMMARY_FAILED = "Summary failed — run /retry to try again."`
  - `NOTE_GAPS = "Some audio could not be transcribed (marked in the transcript). Run /retry to try again."`
  - `NO_SPEECH_TEXT = "No speech was recorded in this meeting."`

**transcribeBatch:**
- The inputs depend on the transcriber:
  - A transcriber with `name === 'groq'` gets **one input per turn**, from `groupTurns`. The turn's audio is `concatOggOpus` of its clips, its `id` is the first clip's id, and the segment covers all of the turn's clip ids.
  - Any other transcriber gets one input per clip.
- Each transcriber call goes through `retry`.
- If the primary still fails and `fallback` is set, the fallback runs. If both fail, the fallback's error is rethrown.
- Each segment's `endMs` is its last clip's `startMs + durationMs`.

**processMeeting:**
1. Load the meeting. If `clips.length === 0`, call `postText(NO_SPEECH_TEXT …)`, set all steps to `done` and `reportComplete = true`, then return. No transcriber calls are made.
2. If `batches` is empty, plan them, using sizes from `store.clipSize`.
3. For each batch that isn't `done`, run `transcribeBatch`. On success, replace the segments for that `batchId`, set `status: 'done'`, and record the provider. On failure, set `status: 'failed'` and record the error. Save after every batch, so a retry resumes from there.
4. If **no** batch is done, set `steps.transcribe = 'failed'`, post `buildErrorText(meta, 'transcription failed', tz)`, and return. Otherwise set `steps.transcribe` to `done` if every batch is done, or `failed` if some aren't.
5. Summarize when `summary` is missing **or** any batch was newly transcribed in this run. Run the primary through retry, then the fallback. Success sets `summary` and `steps.summarize = 'done'`. Failure sets `steps.summarize = 'failed'` and keeps any earlier summary.
6. Build the notes: add `NOTE_SUMMARY_FAILED` if there's no summary, and `NOTE_GAPS` if any batch failed. Then build the messages with `updated` set to whether `reportMessageId` exists.
   - On the first post, post and store `reportMessageId`.
   - When there's an earlier report, post as a reply to `reportMessageId`. Do this only if something changed (a new summary or newly transcribed batches). Otherwise post nothing.
   - Then set `steps.report = 'done'` and `reportComplete` to whether there are no notes.
7. If posting throws, set `steps.report = 'failed'`, save, and rethrow.

- [ ] **Step 1: Write the failing tests.** Use fake transcribers that return `id → "text-<id>"` or throw, a fake summarizer, a fake poster that records calls, a real `MeetingStore` in a temp dir, and `retry` stubbed to run once.
  - transcribeBatch:
    - It uses the primary.
    - When the primary throws, it uses the fallback and returns `provider: 'groq'`.
    - When both fail, it rejects.
    - The Groq path sends one input per turn (A, A, B gives 2 inputs).
  - processMeeting:
    - **Happy path:** one `post` with an embed and the file, every step `done`, and `reportComplete === true`.
    - **No clips:** `postText(NO_SPEECH_TEXT)`, and neither the transcriber nor the summarizer is called.
    - **Summary fails:** the report is posted with `NOTE_SUMMARY_FAILED` and the file, with `steps.summarize === 'failed'`. On **retry** with a working summarizer, it posts a reply (`replyTo === reportMessageId`) with an `🔁 Updated` title, and everything is `done`.
    - **A batch fails on both providers:** the report includes `NOTE_GAPS`, and the transcript file has an `[untranscribed audio` line. On retry with working providers, only that batch is transcribed again, then it's re-summarized and a reply is posted.
    - **Every batch fails:** the error text is posted, there's no `post`, and `steps.transcribe === 'failed'`.
    - **Retry on a finished meeting:** no posts at all.
- [ ] **Step 2: Run `npx vitest run tests/pipeline tests/transcription/transcribe-batch.test.ts` and confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run typecheck && npm test` and confirm both pass.**
- [ ] **Step 5: Commit** `feat(transcription): add per-batch transcription with fallback`, then `feat(pipeline): add resumable meeting processing`.

---

### Task 11: Discord wiring and entrypoint (wave 3)

Branch: `feat/t11-discord`.

**Files:**
- Create: `src/discord/commands.ts`, `src/discord/register-commands.ts`, `src/discord/report-poster.ts`, `src/discord/handlers.ts`, `src/index.ts`, `README.md`
- Test: `tests/discord/handlers.test.ts`, `tests/discord/commands.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `COMMANDS: RESTPostAPIApplicationCommandsJSONBody[]`, with three commands. All are guild-only (`contexts: [InteractionContextType.Guild]`).
    - `join`: "Start recording this voice channel"
    - `stop`: "Stop recording and post the meeting report"
    - `retry`: "Re-process an unfinished meeting". It takes an optional string option `meeting_id`.
  - `registerCommands(token: string, clientId: string): Promise<void>`. Does a `PUT` to `Routes.applicationCommands(clientId)`.
  - `class DiscordReportPoster implements ReportPoster`, created with `new DiscordReportPoster(client: Client, reportChannels: Map<string, string>)`. It sends to the report channel for the guild, attaching files as `AttachmentBuilder`. A reply uses `reply: { messageReference: replyTo, failIfNotExists: false }`.
  - Decision helpers in `handlers.ts`, which return the user-facing text or `null` when the action is allowed. These exact strings are fixed copy:
    - `checkJoin(p: { memberVoiceChannelId: string | null; hasReportChannel: boolean; active?: { voiceChannelId: string } }): string | null`:
      - `"Join a voice channel first, then run /join."`
      - `"This server has no report channel set up yet. Ask the bot owner to add it to REPORT_CHANNELS."`
      - `` `I'm already recording in <#${id}>.` ``
    - `checkStop(active?: object): string | null`, which returns `"I'm not recording right now."`
    - `retryNothingText = "There's no unfinished meeting to retry."`
    - `joinStartedText(vcId)`: `` `🔴 Recording started in <#${vcId}>.` ``
    - `recordingNoticeText(vcId, userId)`: `` `🔴 Recording started in <#${vcId}> by <@${userId}>. Everything said there will be transcribed and summarized.` ``
    - `processingText(reportChannelId)`: `` `⏳ Processing the meeting… the report will be posted in <#${reportChannelId}>.` ``
    - `interruptedText = "⚠️ A recording was cut off by a bot restart. Run /retry to process what was recorded."`

**index.ts startup, in order:**
1. `loadConfig(process.env)` after `import 'dotenv/config'`.
2. Create the store, transcribers, summarizers, poster, and SessionManager. `connect` calls `connectToVoice`. `resolveSpeaker` uses `guild.members.fetch(userId)`, taking `displayName` and `user.bot`. `onStopped` runs `processMeeting` in the background and logs any error.
3. Build the `Client` with the intents `Guilds` and `GuildVoiceStates`.
4. On `ready`:
   - Call `registerCommands`.
   - Call `store.markInterrupted()`, and post `interruptedText` to each affected guild.
   - Run `cleanupOldMeetings` now and every 24 h.
5. On `voiceStateUpdate`: for the guild's active session, count the non-bot members in the active channel, and call `handleHumanCount`.
6. On `interactionCreate`:
   - `/join`: run `checkJoin`, and reply with its text (ephemeral) if it returns one. Otherwise start the session, reply `joinStartedText`, and `postText(recordingNoticeText)`.
   - `/stop`: run `checkStop`, then `deferReply`, `stop(guildId, 'command')`, and `editReply(processingText)`.
   - `/retry`: find the `meeting_id`, or else `findLatestUnfinished`. If there's nothing, reply `retryNothingText`. Otherwise reply `processingText` and run `processMeeting`.
   - Use a single try/catch per interaction that replies with a generic ephemeral error.
7. Handle SIGINT and SIGTERM: stop every active session with reason `command`, so the audio is saved, then call `client.destroy()`.

**README.md:** what the bot does, the commands, a quick start (`cp .env.example .env`, `npm ci`, `npm run dev`), links to `docs/setup.md` and `docs/deploy.md`, and how to run the tests.

- [ ] **Step 1: Write the failing tests.**
  - `checkJoin` and `checkStop` return each exact string in its case, and `null` when the action is allowed.
  - `COMMANDS`: the names are `["join", "stop", "retry"]`, and `retry` has the optional `meeting_id` option.
- [ ] **Step 2: Run `npx vitest run tests/discord` and confirm the tests fail.**
- [ ] **Step 3: Implement** the remaining files.
- [ ] **Step 4: Run `npm run typecheck && npm test && npm run build` and confirm all three pass and `dist/index.js` exists.**
- [ ] **Step 5: Smoke-test startup.** Run `DISCORD_TOKEN= node dist/index.js`. Expected: it exits non-zero with a message naming `DISCORD_TOKEN`.
- [ ] **Step 6: Commit** `feat(discord): add slash commands and report poster`, then `feat: wire bot entrypoint`, then `docs: add README`.

---

### Task 12: End-to-end check and deploy (wave 4, with the user)

Branch: none. Any fixes go on `fix/t12-<slug>` branches using the normal workflow.

- [ ] **Step 1: Configure the test server.** The user follows `docs/setup.md` steps 1–4 and 6 to create a test server and fill in `.env`. Run `npm run dev`. Expected: `Ready as <bot>` is logged, and `/join`, `/stop`, and `/retry` appear in the test server.
- [ ] **Step 2: A two-person meeting.** Two people speak for about 3 minutes in Bangla mixed with English, then run `/stop`. Expected:
  - The recording notice is posted.
  - The report arrives within a few minutes with the correct names.
  - The Bangla is in Bangla script, with the English words kept.
  - The tasks match what was said.
  - The `.txt` is attached.
- [ ] **Step 3: Auto-stop.** Run `/join`, then everyone leaves. Expected: the bot leaves at once and posts a report, or "No speech…".
- [ ] **Step 4: Fallback.** Set `GEMINI_API_KEY=invalid` and repeat a short meeting. Expected: the report is built by Groq. Then restore the key.
- [ ] **Step 5: Restart recovery.** Kill the process mid-recording, then restart. Expected: `interruptedText` is posted, and `/retry` produces a report.
- [ ] **Step 6: Deploy.** Follow `docs/deploy.md` to set up the Oracle VM and the service. Send the admin message from `docs/setup.md` to the real server's admin. After the bot is added, add the real server to `REPORT_CHANNELS` on the VM and restart. Run one real meeting.
