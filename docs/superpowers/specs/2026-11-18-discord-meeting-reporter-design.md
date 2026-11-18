# Discord Meeting Reporter Bot — Design

Date: 2026-11-18
Status: approved 2026-11-18

## Intent

A Discord bot for the user's own server. Someone tells it to join a voice channel. It records the meeting, and when told to stop it posts a meeting report in a text channel on the server:

- **Full transcript in Bangla** (Bangla script, with speaker names and timestamps).
- **Summary in English** with three parts: an overall report, the ideas discussed, and a task list.

Reports must be easy to understand, relatively short, well structured, and still contain every key piece of information. Everything must run on free services.

## Usage profile

- One real server. **The user is not its admin**, so a server admin must add the bot. The user also has a personal test server where they are admin, used for development.
- Usually at most **1 hour of meeting per day**.
- People speak Bangla, often mixed with English words (code-switching).
- Privacy is not a concern. Sending audio to a free cloud API that may train on it is acceptable.

## Goals

1. Manual join and stop through slash commands.
2. An accurate Bangla transcript with correct speaker attribution.
3. A short, structured English summary covering overview, ideas, and tasks.
4. Output posted to a configured channel in the server.
5. $0 running cost.

## Non-goals

- Live or real-time transcription during the meeting.
- Auto-joining voice channels.
- Serving many servers, or scaling beyond about 1 hour a day. A couple of servers (the test server and the real one) must work.
- A web dashboard or any storage beyond local files.
- Translating the full transcript into English.

## Anti-goals (failure even if it technically works)

- **Losing a meeting.** If transcription or summarizing fails, the recording must survive on disk and be retryable.
- **Long, vague summaries.** Padding, generic filler, or a summary that's as long as the transcript.
- **Invented content.** Tasks, owners, or deadlines that nobody said. An unknown owner is shown as unassigned, never guessed.
- **Anything that costs money.**

## Constraints

- **Discord voice receive is unofficial.** Discord doesn't document it, so a Discord change could break it. All voice is now end-to-end encrypted (DAVE, required since March 2026). `@discordjs/voice` 0.19.x bundles `@snazzah/davey` for DAVE and is the library to use.
- **Discord message limits:** 2,000 characters per message; 4,096 per embed description; 6,000 per message across all its embeds. A one-hour transcript must go out as a file attachment.
- **Gemini free tier:** the limits aren't published as fixed numbers and change over time. Free access is limited to certain models (Flash-class). The model name must be configurable, not hard-coded.
- **Groq free tier** (backup), roughly: 20 requests a minute, 2,000 requests a day, 7,200 audio-seconds an hour, 28,800 audio-seconds a day, 25 MB per file. Verify on Groq's rate-limits page.
- **Environment:** Node v26 is installed (WSL). ffmpeg is **not** installed, so the design should avoid needing it, or call it out as a setup step.

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **A. Gemini for transcription and summary** | Best free Bangla quality, including Bangla mixed with English. One API. Free-tier limits are unpublished and may tighten. | **Chosen** |
| B. Groq Whisper for transcription, an LLM for the summary | Clear, generous free limits and very fast. Weaker Bangla, and it invents words on short or noisy clips. | **Kept as a backup transcriber**, switchable by config and used automatically on Gemini failure |
| C. Local Whisper on the user's PC | Private and unlimited, but slow without a GPU and no better at Bangla. Privacy isn't needed. | Dropped |

The user chose **A with Groq as the backup**.

## Design

### Stack (decided)

- Node.js with **TypeScript** (my call), discord.js v14, `@discordjs/voice` 0.19.x.
- Google Gen AI SDK (`@google/genai`) for Gemini. Groq's OpenAI-compatible audio transcription endpoint for the backup.
- Develop and test on the user's PC (WSL). **Production runs 24/7 on a free cloud VM** (see Hosting and updates), so anyone in the server can use it while the user is offline.

### Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` | Bot identity. Slash commands are registered **globally** (my call), so one registration works in every server the bot is in, without asking the admin for anything extra. |
| `REPORT_CHANNELS` | Where reports go, for each server, as `guildId:channelId` pairs separated by commas. This is kept in `.env` so the user can change it without admin help. A server with no entry gets a "report channel not configured" reply on `/join`. |
| `TIMEZONE` | Used for the times shown in reports. Default `Asia/Dhaka` (my call). |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Transcription and summary. The model defaults to the current free Flash model. |
| `GROQ_API_KEY` (optional), `GROQ_MODEL` (default `whisper-large-v3`), `GROQ_SUMMARY_MODEL` | Backup transcriber and backup summarizer. |
| `TRANSCRIBER` = `gemini` or `groq` | The primary transcriber. Default `gemini`. |

Bot intents: `Guilds`, `GuildVoiceStates`. No privileged intents.

Bot permissions: View Channel, Connect, Send Messages, Embed Links, Attach Files.

### Getting into a server you don't admin

- Adding a bot needs **Manage Server** permission, so the user sends the server admin an invite link. The link has scopes `bot applications.commands` and exactly these permissions: View Channel, Connect, Send Messages, Embed Links, Attach Files.
- The admin may need to let the bot into the meeting voice channel and the report channel, if those channels are private.
- By default, anyone in the server can use the bot's commands. The admin can restrict them under Server Settings → Integrations.
- The README must include ready-to-send instructions for the admin.
- **Development** happens in the user's own test server. Only the final check needs the real server.

### Commands

- `/join`: joins the voice channel of the person who ran it, starts recording, and posts a visible "🔴 Recording started" notice in the report channel, so people know they're being recorded. If the bot is already recording, it says so and does nothing.
- `/stop`: stops recording, leaves the channel, replies "processing…", then posts the report when it's ready.
- `/retry`: reprocesses the most recent meeting whose processing failed. It can optionally take a meeting ID. This uses the audio saved on disk.

Auto-stop: the bot stops and processes on its own in two cases.
- **Immediately** when the last human leaves the voice channel (decided by the user). Bots don't count as humans.
- When the recording reaches 2 hours. This is a safety cap (my call).

### Recording

- The bot listens for `receiver.speaking` start events for each user and ignores bots.
- For each utterance it subscribes to that user's audio stream, which ends after about 1 second of silence. It writes the utterance as one clip file.
- Each clip stores: the user ID, the speaker's display name at the time, a start offset from the beginning of the meeting, and a duration.
- Clips shorter than about 0.5 s are dropped as noise.
- **Clip format:** must be accepted by both Gemini and Groq without ffmpeg. Ogg/Opus written directly from the Opus packets (for example with `prism-media`'s Ogg muxer) is preferred. WAV, from decoded PCM, is an acceptable fallback.
- **Storage:** on the local disk of the machine running the bot, in the project folder: `recordings/<meetingId>/clips/*` plus `meta.json`. The `recordings/` folder is git-ignored. `meta.json` holds the start and end times, the voice channel, participants (ID → display name), the clip index, and the processing status.
- The audio stays on disk until the report posts successfully. After that it's kept for 7 days and then cleaned up (my call).

### Processing pipeline (after `/stop`)

1. **Transcribe (Gemini):** sort clips by start time and group them into batches of a few minutes of speech each (the exact batch size is the builder's call). Each batch is one Gemini request: the audio clips as separate parts, each labeled with its clip ID and speaker. The prompt asks for strict JSON output: `[{clip_id, text}]`.
   - Text is written in Bangla script. English words that were spoken in English stay in English.
   - Text is verbatim. No translation, cleanup, or summarizing.
   - If a clip has no intelligible speech, its text is empty. Nothing is invented.
2. **Fallback:** if a Gemini batch still fails after retries with backoff on 429 and 5xx errors, and a `GROQ_API_KEY` is set, that batch is transcribed with Groq, using `language=bn`. If Groq is the primary transcriber, the roles are swapped.
   - Don't send one Groq request per clip. An hour can be 500 or more clips, and at about 20 requests a minute that's too slow. Groq may also bill a minimum number of audio-seconds per request.
   - Instead, join each speaker's consecutive clips (one speaker turn) into a single audio file per request. Ogg pages can be concatenated without ffmpeg.
   - The timestamp for a joined turn is the start of its first clip. Coarser timestamps in fallback mode are acceptable (my call).
   - Keep batches small enough that a one-hour meeting is roughly 15 to 20 Gemini requests, including the summary.
3. **Merge:** build transcript lines `[HH:MM:SS] Name: text` in chronological order. Consecutive clips from the same speaker within a few seconds may be joined into one line.
4. **Summarize (Gemini):** send the whole transcript to Gemini in one request. The prompt asks for JSON:
   - `overview`: 3–5 plain sentences on what the meeting was about and what was concluded or decided.
   - `ideas`: a list of short bullets. Each bullet is one idea, and may optionally say who raised it.
   - `tasks`: a list of `{task, owner | null, due | null}`. Only tasks actually stated or agreed on in the meeting. `owner` and `due` are null unless someone said them.
   - The output is in English, concise, with no filler.
   - **Summary fallback (my call):** if Gemini still fails after retries and a `GROQ_API_KEY` is set, use a free Groq-hosted chat model (`GROQ_SUMMARY_MODEL`, configurable) with the same prompt and JSON schema. Both summary providers sit behind a `Summarizer` interface, alongside `Transcriber`. Without this, the Groq backup would rarely help: the likely Gemini failures (daily quota used up, an outage) would block the summary anyway.
5. **Post** to that server's report channel from `REPORT_CHANNELS` (layout below).

### Failures, partial results and retry (my calls)

- **Tracking:** `meta.json` records the state of each step: each transcription batch, the merge, the summary, and the post. `/retry` resumes from the first step that didn't finish. It never redoes work that already succeeded.
- **Transcription works, summary fails:** post the transcript file right away, with a note: "⚠️ Summary failed: run `/retry`." A later successful retry posts the summary as a reply to that message.
- **A batch fails on both providers:** keep it pending and finish everything else. When the transcript is otherwise complete, that span appears in it as `[untranscribed audio HH:MM:SS–HH:MM:SS]`. The summary runs on what was transcribed, and the report says that part of the audio is missing. `/retry` can fill in the missing span and post a corrected transcript.
- **After any failure**, the bot posts a short error in the report channel, saying what failed and to use `/retry`. The audio is never deleted while any step is unfinished.

### Report layout

One message with an embed, plus the transcript file attached:

```
📋 Meeting Report — 18 Nov 2026, 9:00–9:52 PM (52 min)
#general-voice · Participants: Rahim, Karim, Nadia

Overview
<3–5 sentences>

💡 Ideas discussed
• ...
• ...

✅ Tasks
• <task> — @owner (due: Friday)
• <task> — unassigned

📎 transcript-2026-11-18.txt
```

- Owners are shown as Discord mentions when they can be matched to a participant. Otherwise they're shown as plain text.
- If the summary goes over the embed limits, it's split across several embeds or messages. It is never cut off.
- The transcript file is UTF-8 plain text. It starts with a header (date, duration, participants), followed by the transcript lines.

### Hosting and updates

- **Constraint (decided by the user):** no credit or debit card, not a student, and no spare device. That rules out Oracle, Google Cloud, Koyeb, Fly.io and Azure for Students.
- **Host (my call): Northflank free Sandbox.**
  - It needs no card and its services don't sleep.
  - The bot runs as a Docker container, built from the repo's `Dockerfile`.
  - Secrets are set as Northflank environment variables, never in git.
  - **Risk:** it is unverified whether outbound UDP, which Discord voice needs, works there. The first deploy is the test: `/join`, speak, then check that clips are recorded.
- **Fallbacks, in order:**
  1. bot-hosting.net free plan (Pterodactyl panel, manual renewal every 4 days, UDP also unverified).
  2. Running on the user's own PC with `npm start`. It is online only while the PC is on.
- **Disk:** the container disk may be ephemeral. Recordings survive until the next restart or deploy, which is enough because a meeting is processed within minutes. `/retry` only works for meetings recorded since the last restart.
- **Updates:** Northflank builds and redeploys automatically on every push to `main`. Merging a PR is the deploy. The bot **registers its slash commands automatically on startup**, so new or changed commands appear without the admin doing anything.
- **What needs the admin again:** only a change to the bot's server **permissions**, which needs a new invite link or a role edit. Code changes, new commands and model changes never do.

### Testing

- Unit tests cover:
  - transcript merging and ordering
  - report formatting and splitting at Discord's limits
  - parsing of the JSON responses, including malformed responses
  - fallback selection
- The Gemini and Groq calls sit behind a small `Transcriber` interface so they can be faked in tests.
- A manual end-to-end test in the user's server: a short meeting with 2+ people speaking Bangla mixed with English.

## Left to the builder

- Batch size and the number of clips per Gemini request.
- The exact silence threshold and minimum clip length (within the ranges above).
- Retry and backoff numbers.
- Project layout and file names.
- The library used for the Ogg muxing.
