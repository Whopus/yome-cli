// Parse a human-friendly one-shot time spec into a wall-clock epoch ms.
//
// Accepted shapes:
//   "in 5 minutes" / "in 1 hour" / "in 30s"
//   "tomorrow 9:00" / "tomorrow 09:00"
//   "today 18:00"
//   "2026-04-30 18:00"
//   "2026-04-30T18:00:00+08:00"
//   "1777340834798"            (raw epoch ms)
//
// Anything else → throws. Returns ms since epoch (UTC).

export function humanToOnceMs(input: string, now: () => number = Date.now): number {
  const s = input.trim();
  if (!s) throw new Error('empty time spec');

  // Raw epoch ms (>= 13 digits).
  if (/^\d{13,}$/.test(s)) {
    return Number.parseInt(s, 10);
  }

  // ISO 8601 / Date-parseable. Try this first for unambiguous inputs
  // like "2026-04-30T18:00:00+08:00".
  const isoTry = Date.parse(s);
  if (!Number.isNaN(isoTry) && /\d{4}-\d{2}-\d{2}/.test(s)) {
    return isoTry;
  }

  const lower = s.toLowerCase();

  // "in N <unit>"
  const inMatch = lower.match(/^in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (inMatch) {
    const n = Number.parseInt(inMatch[1]!, 10);
    const unit = inMatch[2]!;
    const mult =
      unit.startsWith('s') ? 1_000 :
      unit.startsWith('m') ? 60_000 :
      unit.startsWith('h') ? 3_600_000 :
      86_400_000;
    return now() + n * mult;
  }

  // "today HH:MM" / "tomorrow HH:MM"
  const dayMatch = lower.match(/^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/);
  if (dayMatch) {
    const offset = dayMatch[1] === 'tomorrow' ? 1 : 0;
    const hour = Number.parseInt(dayMatch[2]!, 10);
    const minute = Number.parseInt(dayMatch[3]!, 10);
    if (hour > 23 || minute > 59) throw new Error(`invalid time: ${dayMatch[2]}:${dayMatch[3]}`);
    const d = new Date(now());
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  }

  throw new Error(
    `unrecognised once-time: '${input}'. ` +
    `Try 'in 5 minutes', 'tomorrow 9:00', '2026-04-30 18:00', or an ISO 8601 string.`,
  );
}
