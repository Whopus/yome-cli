// Human-friendly cron parser.
//
// Accepts a small set of natural-ish phrases and converts them into a
// standard 5-field crontab string (compatible with node-cron):
//
//   "9:00"            → "0 9 * * *"     (every day at 9am)
//   "9:00 daily"      → "0 9 * * *"
//   "18:00"           → "0 18 * * *"
//   "every 5 minutes" → "* /5 * * * *"  (note: 5-field cron — minute slot)
//   "every minute"    → "* * * * *"
//   "every hour"      → "0 * * * *"
//   "hourly"          → "0 * * * *"
//   "daily 9:00"      → "0 9 * * *"
//   "weekly mon 9:00" → "0 9 * * 1"
//
// Anything we don't recognise → throws. The caller (cli.ts) catches and
// suggests the user pass a real crontab via --at instead.

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export function humanToCron(input: string): string {
  const s = input.trim().toLowerCase();
  if (!s) throw new Error('empty schedule');

  if (s === 'every minute' || s === 'minutely') return '* * * * *';
  if (s === 'every hour' || s === 'hourly') return '0 * * * *';
  if (s === 'daily' || s === 'every day') return '0 9 * * *';

  // every N minutes / hours
  const everyN = s.match(/^every\s+(\d+)\s+(minute|minutes|min|hour|hours)$/);
  if (everyN) {
    const n = Number.parseInt(everyN[1]!, 10);
    const unit = everyN[2]!;
    if (n < 1 || n > 59) throw new Error(`interval out of range: ${n}`);
    if (unit.startsWith('hour')) return `0 */${n} * * *`;
    return `*/${n} * * * *`;
  }

  // HH:MM with optional 'daily' / weekday
  // Examples: "9:00", "9:00 daily", "9:00 mon", "weekly mon 9:00"
  const timeRe = /(\d{1,2}):(\d{2})/;
  const time = s.match(timeRe);
  if (time) {
    const hour = Number.parseInt(time[1]!, 10);
    const minute = Number.parseInt(time[2]!, 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`invalid time: ${time[0]}`);
    }
    // Look for an explicit weekday token
    const tokens = s.split(/\s+/).filter(Boolean);
    let dow = '*';
    for (const t of tokens) {
      if (t in DAY_NAMES) { dow = String(DAY_NAMES[t]); break; }
    }
    return `${minute} ${hour} * * ${dow}`;
  }

  throw new Error(
    `unrecognised schedule: '${input}'. ` +
    `Try '9:00', 'every 5 minutes', 'every hour', 'mon 9:00', or pass a crontab via --at "0 9 * * *".`,
  );
}
