# Hosting the bot 24/7

The bot runs as a Docker container built from the `Dockerfile` in this repo. The host is **Northflank's free Sandbox**: no card is needed and the service does not sleep. Finish [setup.md](setup.md) first so you have your tokens and keys.

## Deploy on Northflank

1. Go to <https://northflank.com> and sign up **with GitHub**. Choose the free **Sandbox** plan. No card is asked.
2. Create a **project** (any name, any region).
3. In the project, create a **combined service** (builds from Git and runs it):
   - Repository: `NightmareXIX/CashlessBot`. Connect your GitHub account if asked.
   - Branch: `main`.
   - Build type: **Dockerfile** (path `/Dockerfile`, context `/`).
4. **Remove every port.** The bot serves no HTTP, so it has nothing to expose. Delete any port Northflank pre-fills.
5. Add **every variable from `.env.example`** as a runtime secret or environment variable (use **Secrets** for tokens and keys): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `REPORT_CHANNELS`, `TIMEZONE`, `RECORDINGS_DIR`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_SUMMARY_MODEL`, `TRANSCRIBER`. Never put them in git. Set `RECORDINGS_DIR` to `./recordings`.
6. Pick the **smallest free instance**.
7. Turn on **auto-deploy on push to `main`** (the CI/CD setting on the service).
8. Create the service. Open its **Logs** and wait for `Ready as ...`.

## UDP check (do this on the first deploy)

Discord voice needs outbound UDP, and it is not confirmed that Northflank allows it.

1. In your test server, join a voice channel and run `/join`.
2. Talk for about 30 seconds.
3. Run `/stop`.

If a report appears, voice works and you are done. If the bot never connects to voice, or the report says no clips were recorded, outbound UDP is blocked. Move to a fallback below.

## Fallback 1: bot-hosting.net

1. Sign up at <https://bot-hosting.net> and create a free server (Node.js).
2. Upload the repo, or open the console and run `git clone https://github.com/NightmareXIX/CashlessBot.git`.
3. Set the start command to:

   ```
   npm ci && npm run build && node dist/index.js
   ```

4. Set the environment variables from `.env.example` in the panel.
5. **Renew it every 4 days** or it is switched off. UDP is also unverified here, so run the UDP check above.

## Fallback 2: your own PC

Follow step 7 of [setup.md](setup.md): `npm run build && npm start`. The bot is online only while the PC is on.

## Updating

Merge a pull request into `main`. Northflank builds and redeploys by itself. The bot registers its slash commands on startup, so new or changed commands appear without any extra step. Code changes, new commands and model changes never need the server admin. Only a change to the bot's **permissions** does: that needs a new invite link or a role edit by the admin.

## Recordings are temporary

The container disk is ephemeral: recordings are lost on restart or redeploy. A meeting is processed within minutes, so this is normally fine, but `/retry` only works for meetings recorded since the last restart. Avoid merging to `main` while a meeting is being processed.
