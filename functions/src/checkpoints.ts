export const CHECKPOINT_HOURS = [3, 9, 21] as const;
export const CHECKPOINT_PERIOD_HOURS = 6;

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }

function localParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function localDateToUtc(parts: LocalParts, timezone: string) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const actual = localParts(new Date(guess), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = target - represented;
    guess += correction;
    if (!correction) break;
  }
  return new Date(guess);
}

export function checkpointLabel(end: Date, timezone: string) {
  const parts = localParts(end, timezone);
  return `${String(parts.hour).padStart(2, "0")}:00`;
}

export function checkpointStart(end: Date, timezone: string) {
  const local = localParts(end, timezone);
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour - CHECKPOINT_PERIOD_HOURS, 0));
  return localDateToUtc({
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: 0,
  }, timezone);
}

export function checkpointsBetween(first: Date, end: Date, timezone: string) {
  const matches: Date[] = [];
  const cursor = new Date(Math.floor(first.getTime() / 3_600_000) * 3_600_000);
  for (; cursor <= end; cursor.setTime(cursor.getTime() + 3_600_000)) {
    const parts = localParts(cursor, timezone);
    if (parts.minute === 0 && CHECKPOINT_HOURS.includes(parts.hour as typeof CHECKPOINT_HOURS[number])) matches.push(new Date(cursor));
  }
  return matches;
}

export function latestCheckpoint(now: Date, timezone: string) {
  const candidates = checkpointsBetween(new Date(now.getTime() - 36 * 3_600_000), now, timezone);
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`Could not resolve a normality checkpoint in ${timezone}.`);
  return latest;
}
