import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EntityConfig, SensorKind } from "./types";

export interface IngestEventInput {
  id: string;
  entityId: string;
  kind: SensorKind;
  state: string;
  numericValue: number | null;
  observedAt: string;
  unit?: string | null;
  friendlyName?: string | null;
}

export interface IngestPayload {
  version: 1;
  householdId: string;
  collectorId: string;
  sentAt: string;
  events: IngestEventInput[];
  health?: {
    version?: string;
    queueDepth?: number;
    lastBackfillAt?: string | null;
  };
}

export interface SignatureHeaders {
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

export function bodyDigest(body: Buffer | string) {
  return createHash("sha256").update(body).digest("hex");
}

export function makeSignature(secret: string, timestamp: string, nonce: string, body: Buffer | string) {
  return createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${bodyDigest(body)}`).digest("hex");
}

export function verifySignature(secret: string, headers: SignatureHeaders, body: Buffer, now = Date.now()) {
  const { timestamp, nonce, signature } = headers;
  if (!timestamp || !/^\d{10}$/.test(timestamp)) throw new Error("Missing or invalid collector timestamp.");
  if (!nonce || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("Missing or invalid collector nonce.");
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) throw new Error("Missing or invalid collector signature.");
  if (Math.abs(now - Number(timestamp) * 1000) > 5 * 60_000) throw new Error("Collector timestamp is outside the five-minute acceptance window.");
  const expected = Buffer.from(makeSignature(secret, timestamp, nonce, body), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Collector signature does not match.");
  return { timestamp, nonce };
}

const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || !value.length || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  return value;
};

const optionalText = (value: unknown, name: string, max: number) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return value;
};

const timestamp = (value: unknown, name: string, now: number, oldest: number) => {
  const raw = text(value, name, 40), date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an ISO timestamp.`);
  if (date.getTime() < oldest || date.getTime() > now + 10 * 60_000) throw new Error(`${name} is outside the accepted retention window.`);
  return date;
};

export function validatePayload(input: unknown, entities: EntityConfig[], householdId: string, now = Date.now()): IngestPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The request body must be an object.");
  const body = input as Record<string, unknown>;
  if (body.version !== 1) throw new Error("Unsupported ingest protocol version.");
  if (body.householdId !== householdId) throw new Error("The household ID is not accepted by this endpoint.");
  const collectorId = text(body.collectorId, "collectorId", 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(collectorId)) throw new Error("collectorId contains unsupported characters.");
  const sentAt = timestamp(body.sentAt, "sentAt", now, now - 24 * 60 * 60_000).toISOString();
  if (!Array.isArray(body.events) || body.events.length > 500) throw new Error("events must be an array containing at most 500 items.");
  const allowed = new Map(entities.map((entity) => [entity.entityId, entity]));
  if (!allowed.size) throw new Error("No Home Assistant entities are enabled in the household configuration.");
  const oldest = now - 90 * 86_400_000;
  const events = body.events.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`events[${index}] must be an object.`);
    const item = raw as Record<string, unknown>, entityId = text(item.entityId, `events[${index}].entityId`, 180);
    const configured = allowed.get(entityId);
    if (!configured) throw new Error(`${entityId} is not in the configured entity allowlist.`);
    if (item.kind !== configured.kind) throw new Error(`${entityId} has the wrong sensor kind.`);
    const state = text(item.state, `events[${index}].state`, 128);
    const observedAt = timestamp(item.observedAt, `events[${index}].observedAt`, now, oldest).toISOString();
    const id = text(item.id, `events[${index}].id`, 64);
    if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error(`events[${index}].id must be a SHA-256 hexadecimal ID.`);
    const numericValue = item.numericValue === null || item.numericValue === undefined ? null : Number(item.numericValue);
    if (numericValue !== null && !Number.isFinite(numericValue)) throw new Error(`events[${index}].numericValue must be finite or null.`);
    return {
      id: id.toLowerCase(), entityId, kind: configured.kind, state, numericValue, observedAt,
      unit: optionalText(item.unit, `events[${index}].unit`, 40),
      friendlyName: configured.label ?? optionalText(item.friendlyName, `events[${index}].friendlyName`, 120),
    } as IngestEventInput;
  });
  const healthRaw = body.health;
  let health: IngestPayload["health"];
  if (healthRaw !== undefined) {
    if (!healthRaw || typeof healthRaw !== "object" || Array.isArray(healthRaw)) throw new Error("health must be an object.");
    const item = healthRaw as Record<string, unknown>;
    const queueDepth = item.queueDepth === undefined ? undefined : Number(item.queueDepth);
    if (queueDepth !== undefined && (!Number.isInteger(queueDepth) || queueDepth < 0 || queueDepth > 1_000_000)) throw new Error("health.queueDepth is invalid.");
    health = {
      version: optionalText(item.version, "health.version", 40) ?? undefined,
      queueDepth,
      lastBackfillAt: item.lastBackfillAt ? timestamp(item.lastBackfillAt, "health.lastBackfillAt", now, oldest).toISOString() : null,
    };
  }
  return { version: 1, householdId, collectorId, sentAt, events, health };
}
