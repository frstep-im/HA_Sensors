import { EmailPreferences } from "./types";

export interface ScheduleSlot { id: string; time: string; localDate: string }

function localMinute(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  const time = `${value("hour")}:${value("minute")}`;
  return { localDate, time };
}

export function dueScheduleSlots(times: string[], now: Date, timezone: string, lookbackMinutes = 14): ScheduleSlot[] {
  const wanted = new Set(times), slots = new Map<string, ScheduleSlot>();
  for (let minutesAgo = 0; minutesAgo <= lookbackMinutes; minutesAgo++) {
    const local = localMinute(new Date(now.getTime() - minutesAgo * 60_000), timezone);
    if (!wanted.has(local.time)) continue;
    const id = `${local.localDate}-${local.time.replace(":", "")}`;
    slots.set(id, { id, time: local.time, localDate: local.localDate });
  }
  return [...slots.values()];
}

export function sanitizeEmailPreferences(input: unknown, email: string, existing?: Partial<EmailPreferences>): EmailPreferences {
  if (!input || typeof input !== "object") throw new Error("Email preferences must be an object.");
  const body = input as Record<string, unknown>;
  const threshold = body.threshold === undefined ? Number(existing?.threshold ?? 30) : Number(body.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 99) throw new Error("Email threshold must be between 1 and 99.");
  const rawTimes = Array.isArray(body.scheduleTimes) ? body.scheduleTimes : existing?.scheduleTimes ?? [];
  const scheduleTimes = [...new Set(rawTimes.map((value) => String(value).trim()).filter(Boolean))].sort();
  if (scheduleTimes.length > 12) throw new Error("A maximum of 12 daily email times is supported.");
  if (scheduleTimes.some((value) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Error("Daily email times must use 24-hour HH:MM format.");
  return {
    email: email.trim().toLowerCase(),
    thresholdEnabled: body.thresholdEnabled === undefined ? Boolean(existing?.thresholdEnabled) : Boolean(body.thresholdEnabled),
    threshold,
    scheduleTimes,
  };
}
