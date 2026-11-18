const INSTRUCTIONS = `Below is the transcript of a team meeting held on Discord. It is mostly in Bangla, sometimes mixed with English. Lines look like "[HH:MM:SS] Speaker: text".
Write a meeting report in English for people who were not there. It must be short, clear and contain every key point.
Return JSON only, in this shape:
{"overview": string, "ideas": [{"idea": string, "raisedBy": string|null}], "tasks": [{"task": string, "owner": string|null, "due": string|null}]}
- overview: 3-5 plain sentences: what the meeting was about and what was decided or concluded.
- ideas: every distinct idea, proposal or suggestion discussed, one short sentence each. raisedBy is the speaker's name if clear, otherwise null.
- tasks: only tasks someone actually stated, accepted or was assigned in the meeting. owner is a participant's name only if the transcript makes clear who will do it, otherwise null. due only if a deadline was said, written as said (e.g. "Friday", "next week"), otherwise null. Never invent tasks, owners or deadlines.
- No filler, greetings or generic advice. If there were no ideas or no tasks, return an empty list.
- Do not guess what was said in parts marked [untranscribed audio].`;

export function buildSummaryPrompt(transcript: string, participants: string[]): string {
  return `${INSTRUCTIONS}\n\nParticipants: ${participants.join(', ')}\n\nTranscript:\n${transcript}`;
}
