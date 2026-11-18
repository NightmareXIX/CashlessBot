# Setup guide

Follow these steps once. You do not need to be admin of the real server, and you do not need a credit card.

## 1. Create the Discord application and bot

1. Open <https://discord.com/developers/applications> and click **New Application**. Name it and accept the terms.
2. On **General Information**, copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. Open the **Bot** tab. Click **Reset Token**, then copy the token. This is `DISCORD_TOKEN`. Keep it secret: never paste it in chat or commit it.
4. On the same tab, leave all three **Privileged Gateway Intents** switched **off**. The bot does not need them.

## 2. Get a Gemini API key

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** and copy it. This is `GEMINI_API_KEY`. The free tier is enough.
3. Check the current free Flash model ID at <https://ai.google.dev/gemini-api/docs/models>. The default in `.env.example` is `gemini-flash-latest`. Only change `GEMINI_MODEL` if that alias stops working.

## 3. (Optional) Get a Groq API key

Groq is the backup if Gemini fails. Skip this step if you only want Gemini.

1. Open <https://console.groq.com/keys>, sign up, and click **Create API Key**. This is `GROQ_API_KEY`.
2. List the models you can use:

   ```bash
   curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer YOUR_GROQ_KEY"
   ```

   Paste your own key in place of `YOUR_GROQ_KEY`. On Windows PowerShell, type `curl.exe` instead of `curl`.

3. Check that `GROQ_MODEL` (transcription, default `whisper-large-v3`) and `GROQ_SUMMARY_MODEL` (summary, default `openai/gpt-oss-120b`) appear in the list. Change them in `.env` if not.

## 4. Set up a personal test server

1. In Discord, click **+** (Add a Server), then **Create My Own**. You are the admin of this server.
2. Make one text channel for reports and one voice channel for meetings.
3. Add the bot with this link (put your Application ID in place of `<CLIENT_ID>`):

   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1100800
   ```

All development happens here. You only need the real server for the final check.

## 5. Ask the real server's admin to add the bot

Adding a bot needs the **Manage Server** permission. If you do not have it, copy the message below, replace `<CLIENT_ID>` with your Application ID, and send it to the admin.

> **Message for the server admin (copy and paste)**
>
> Hi! I would like to add a small meeting-reporter bot to our server. After a meeting it posts a transcript and a summary in a text channel.
>
> **What it does.** When someone runs `/join`, the bot joins their voice channel and records the audio. It posts a visible "Recording started" notice in the report channel as soon as it begins, so everyone knows. `/stop` ends the recording and posts the report. It also stops by itself when the last person leaves, or after 2 hours. The audio is sent to Google Gemini (and optionally Groq) to be transcribed and summarised, and is deleted from the bot's disk after 7 days.
>
> **Invite link (needs Manage Server):**
> https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1100800
>
> **Permissions it asks for, and why:**
> - View Channel: to see the voice channel and the report channel.
> - Connect: to join the voice channel and record.
> - Send Messages: to post the recording notice, the report and errors.
> - Embed Links: to post the report in a readable format.
> - Attach Files: to attach the full transcript as a text file.
>
> It does not ask for Administrator, and it does not read message content.
>
> **Private channels.** If the meeting voice channel or the report channel is private, the bot cannot see it by default. Please add the bot's role to that channel (Edit Channel, Permissions, add the bot's role) with View Channel, plus Connect on the voice channel and Send Messages on the report channel.
>
> **Who can use it.** By default anyone in the server can run the commands. You can restrict this under **Server Settings, Integrations**, then pick the bot and choose which roles or channels may use each command.
>
> Please also send me the ID of the text channel where reports should go (right-click the channel with Developer Mode on, then **Copy Channel ID**).

## 6. Find the server and channel IDs

1. In Discord open **User Settings, Advanced** and turn on **Developer Mode**.
2. Right-click the server icon, then **Copy Server ID**. This is the guild ID.
3. Right-click the report text channel, then **Copy Channel ID**.
4. Put them in `REPORT_CHANNELS` as `guildId:channelId`. For more than one server, separate pairs with commas:

   ```
   REPORT_CHANNELS=111111111111111111:222222222222222222,333333333333333333:444444444444444444
   ```

A server with no entry gets a "report channel not configured" reply on `/join`.

## 7. Run it locally

You need Node.js 22 or newer.

```bash
cp .env.example .env
# edit .env and fill in the values from the steps above
npm ci
npm run dev
```

Wait for `Ready as ...` in the terminal. Then in your test server join the voice channel and run `/join`, speak, and run `/stop`.

`npm run dev` restarts when you edit files. To run the plain built bot instead:

```bash
npm run build && npm start
```

This is also **fallback 2** for hosting: run the bot on your own PC. It is only online while the PC is on. See [deploy.md](deploy.md) for 24/7 hosting.

## Variables in `.env`

| Variable | Needed | What it is |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token (step 1) |
| `DISCORD_CLIENT_ID` | yes | Application ID (step 1) |
| `REPORT_CHANNELS` | yes | `guildId:channelId` pairs, comma separated (step 6) |
| `TIMEZONE` | no | Time zone for reports, default `Asia/Dhaka` |
| `RECORDINGS_DIR` | no | Where audio is stored, default `./recordings` |
| `GEMINI_API_KEY` | yes | Gemini key (step 2) |
| `GEMINI_MODEL` | no | Gemini model, default `gemini-flash-latest` |
| `GROQ_API_KEY` | no | Enables the Groq backup (step 3) |
| `GROQ_MODEL` | no | Groq transcription model, default `whisper-large-v3` |
| `GROQ_SUMMARY_MODEL` | no | Groq summary model, default `openai/gpt-oss-120b` |
| `TRANSCRIBER` | no | `gemini` (default) or `groq` (needs `GROQ_API_KEY`) |
