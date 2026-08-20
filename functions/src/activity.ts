export interface PowerSample {
  entityId: string;
  label: string;
  observedAt: number;
  value: number;
}

export interface PowerSession {
  entityId: string;
  label: string;
  startAt: number;
  endAt: number;
  durationMinutes: number;
  peakPower: number;
  averagePower: number;
  ongoing: boolean;
}

const TV_THRESHOLD_WATTS = 5;
const MINIMUM_TV_SESSION_MINUTES = 5;

export const isMotionActive = (state: string) => ["on", "detected", "true", "1"].includes(state.toLowerCase());

export const isTelevision = (entityId: string, label = "") => /(^|[._ -])(tv|television)([._ -]|$)/i.test(`${entityId} ${label}`);

function localMinutes(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

function isThreeAmArtifact(session: PowerSession, timezone: string) {
  const start = localMinutes(session.startAt, timezone);
  return start >= 2 * 60 + 45 && start <= 3 * 60 + 20 && session.durationMinutes <= 45;
}

export function televisionSessions(samples: PowerSample[], rangeEnd: number, timezone: string): PowerSession[] {
  const grouped = new Map<string, PowerSample[]>();
  for (const sample of samples.filter((value) => isTelevision(value.entityId, value.label))) {
    const group = grouped.get(sample.entityId) ?? [];
    group.push(sample); grouped.set(sample.entityId, group);
  }
  const sessions: PowerSession[] = [];
  for (const group of grouped.values()) {
    group.sort((a, b) => a.observedAt - b.observedAt);
    let start: PowerSample | undefined, values: number[] = [];
    const close = (endAt: number, ongoing: boolean) => {
      if (!start) return;
      const durationMinutes = Math.max(0, (endAt - start.observedAt) / 60_000);
      const session: PowerSession = {
        entityId: start.entityId, label: start.label, startAt: start.observedAt, endAt,
        durationMinutes, peakPower: Math.max(...values),
        averagePower: values.reduce((sum, value) => sum + value, 0) / values.length, ongoing,
      };
      if (durationMinutes >= MINIMUM_TV_SESSION_MINUTES && !isThreeAmArtifact(session, timezone)) sessions.push(session);
      start = undefined; values = [];
    };
    for (const sample of group) {
      if (sample.value >= TV_THRESHOLD_WATTS) {
        if (!start) start = sample;
        values.push(sample.value);
      } else close(sample.observedAt, false);
    }
    if (start) close(rangeEnd, true);
  }
  return sessions.sort((a, b) => a.startAt - b.startAt);
}

export function televisionFeatures(samples: PowerSample[], rangeStart: number, rangeEnd: number, timezone: string) {
  const sessions = televisionSessions(samples, rangeEnd, timezone).filter((session) => session.endAt > rangeStart && session.startAt < rangeEnd);
  const tvMinutes = sessions.reduce((sum, session) => sum + Math.max(0, Math.min(rangeEnd, session.endAt) - Math.max(rangeStart, session.startAt)) / 60_000, 0);
  const tvSessions = sessions.filter((session) => session.startAt >= rangeStart && session.startAt < rangeEnd).length;
  return { tvMinutes, tvSessions };
}
