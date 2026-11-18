# Meeting reporter bot

A Discord bot that records a voice-channel meeting and posts a report when it ends: a short summary, the ideas raised, the tasks agreed (with owners and due dates when they were said), and the full transcript as a text file.

- Each speaker is recorded separately, so the transcript knows who said what.
- Audio is transcribed and summarized with Google Gemini (free tier). Groq is an optional backup.
- When the bot starts recording, it posts a visible notice in the report channel, so everyone knows.
- It stops by itself when the last person leaves the voice channel, or after 2 hours.
- If a step fails, the audio is kept and `/retry` picks up where it stopped. Finished meetings are deleted after 7 days.

## Commands

| Command | What it does |
|---|---|
| `/join` | Joins your voice channel and starts recording. You must be in a voice channel, and the server needs a report channel in `REPORT_CHANNELS`. |
| `/stop` | Stops recording, leaves the channel, and posts the report in the report channel when it is ready. |
| `/retry [meeting_id]` | Re-processes the latest unfinished meeting in this server, or the one you name. Only the steps that failed are redone. |

The commands only work inside a server. They are registered automatically each time the bot starts.

## Quick start

You need Node.js 22 or newer, a Discord bot token and a Gemini API key. [docs/setup.md](docs/setup.md) walks through getting them.

```bash
cp .env.example .env
# fill in .env (see docs/setup.md)
npm ci
npm run dev
```

When the terminal shows `Ready as ...`, join a voice channel in your server, run `/join`, talk, then run `/stop`.

## Guides

- [docs/setup.md](docs/setup.md): create the bot, get the API keys, invite the bot (including a ready-to-send message for a server admin), and fill in `.env`.
- [docs/deploy.md](docs/deploy.md): host the bot 24/7, and the fallbacks.

## Tests

```bash
npm test            # unit tests (vitest), no network or Discord needed
npm run typecheck   # TypeScript check
npm run build       # compile to dist/
```
