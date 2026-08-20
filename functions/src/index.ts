import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import express, { NextFunction, Request, Response } from "express";
import { App, getApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createHash } from "node:crypto";
import { validatePayload, verifySignature } from "./ingest";
import { analyse } from "./normality";
import { Config, EntityConfig, Features, SensorEvent, SensorKind, SoterEvent, SoterEventType } from "./types";

initializeApp();

const TARGET_PROJECT = "soter-updater-59ead";
const HOUSEHOLD = "household-mpcck67b-epr7fs";
const SOURCE_PROJECT = "doorassistant-bc50a";
const SOTER_DEVICE = "e4ca4cf8b0e37b91";
const REGION = "australia-southeast1";
const RUNTIME_SA = `ha-sensors-runtime@${TARGET_PROJECT}.iam.gserviceaccount.com`;
const INGEST_SECRET = "ha-sensors-ingest-secret";
const WEBHOOK_SECRET = "ha-sensors-alert-webhook";
const root = () => getFirestore().collection("normality_households").doc(HOUSEHOLD);
const secrets = new SecretManagerServiceClient();
const admins = new Set((process.env.ADMIN_EMAILS ?? "intermentisai@gmail.com,fraser@intermentis.com,benoit.auvray@gmail.com").split(",").map((v) => v.trim().toLowerCase()));

const defaults: Config = {
  enabled: false, householdId: HOUSEHOLD, soterProjectId: SOURCE_PROJECT, soterDeviceId: SOTER_DEVICE,
  timezone: "Europe/London", entities: [], windowMinutes: 15,
  baselineDays: 42, minimumBaselineWindows: 24, alertThreshold: 30,
  consecutiveWindows: 2, webhookEnabled: false,
};

async function loadConfig(): Promise<Config> {
  const snap = await root().get();
  return { ...defaults, ...(snap.exists ? snap.data() : {}) } as Config;
}

async function secret(id: string) {
  const [version] = await secrets.accessSecretVersion({ name: `projects/${TARGET_PROJECT}/secrets/${id}/versions/latest` });
  const value = version.payload?.data?.toString().trim();
  if (!value) throw new Error(`Secret ${id} is missing or empty.`);
  return value;
}

interface IdentifiedSensor extends SensorEvent { id: string }
interface IdentifiedSoter extends SoterEvent { id: string }

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const expiry = (date: Date) => Timestamp.fromMillis(date.getTime() + 90 * 86_400_000);

function sourceDb(projectId: string): Firestore {
  let app: App;
  try { app = getApp(`soter-source-${projectId}`); }
  catch { app = initializeApp({ projectId }, `soter-source-${projectId}`); }
  return getFirestore(app);
}

function conversationTypes(data: FirebaseFirestore.DocumentData): SoterEventType[] {
  const text = [data.visitorType, data.interactionType, data.interactionSubtype, data.interactionTitle,
    data.notificationSummary, data.notificationDescription, data.triggerSource, data.startedBy]
    .filter((value) => typeof value === "string").join(" ").toLowerCase();
  const types: SoterEventType[] = ["interaction"];
  if (data.recognizedPersonIsResident === true || (Array.isArray(data.recognizedResidentIds) && data.recognizedResidentIds.length)) types.push("resident_recognized");
  if (/\b(arriv|returned? home|came home|coming home|entry)\b/.test(text)) types.push("arrival");
  if (/\b(depart|leav|left home|going out|exit)\b/.test(text)) types.push("departure");
  return types;
}

async function fetchSoter(config: Config, start: Date, end: Date): Promise<IdentifiedSoter[]> {
  const device = sourceDb(config.soterProjectId).collection("devices").doc(config.soterDeviceId);
  const from = Timestamp.fromDate(start), to = Timestamp.fromDate(end);
  const [doors, conversations] = await Promise.all([
    device.collection("door_events").where("capturedAt", ">=", from).where("capturedAt", "<", to).get(),
    device.collection("conversations").where("startedAt", ">=", from).where("startedAt", "<", to).get(),
  ]);
  const events: IdentifiedSoter[] = [];
  for (const doc of doors.docs) {
    const data = doc.data();
    const raw = String(data.eventType ?? data.doorState ?? "").toLowerCase();
    const type: SoterEventType = raw.includes("left_open") ? "door_left_open" : raw.includes("open") ? "door_opened" : "door_closed";
    events.push({ id: hash(`${doc.id}|${type}`), source: "soter", type, observedAt: data.capturedAt, deviceId: config.soterDeviceId, sourceId: doc.id });
  }
  for (const doc of conversations.docs) {
    const data = doc.data();
    for (const type of conversationTypes(data)) events.push({
      id: hash(`${doc.id}|${type}`), source: "soter", type, observedAt: data.startedAt,
      deviceId: config.soterDeviceId, sourceId: doc.id,
    });
  }
  return events;
}

async function storeEvents(sensors: IdentifiedSensor[], soter: IdentifiedSoter[]) {
  const writes = [
    ...sensors.map(({ id, ...data }) => ({ ref: root().collection("sensor_events").doc(id), data: { ...data, expiresAt: expiry(data.observedAt.toDate()) } })),
    ...soter.map(({ id, ...data }) => ({ ref: root().collection("soter_events").doc(id), data: { ...data, expiresAt: expiry(data.observedAt.toDate()) } })),
  ];
  for (let i = 0; i < writes.length; i += 450) {
    const batch = getFirestore().batch();
    for (const write of writes.slice(i, i + 450)) batch.set(write.ref, write.data, { merge: true });
    await batch.commit();
  }
}

const empty = (): Features => ({
  motionEvents: 0, activeMotionSensors: 0, currentMean: 0, currentMax: 0, powerMean: 0,
  powerMax: 0, doorOpenings: 0, soterInteractions: 0, recognizedResidents: 0, arrivals: 0, departures: 0,
});
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function aggregate(sensors: SensorEvent[], soter: SoterEvent[]): Features {
  const result = empty(), active = new Set<string>(), currents: number[] = [], powers: number[] = [];
  for (const event of sensors) {
    if (event.kind === "motion" && ["on", "detected", "true", "1"].includes(event.state.toLowerCase())) { result.motionEvents++; active.add(event.entityId); }
    if (event.kind === "current" && event.numericValue !== null) currents.push(event.numericValue);
    if (event.kind === "power" && event.numericValue !== null) powers.push(event.numericValue);
  }
  result.activeMotionSensors = active.size;
  result.currentMean = mean(currents); result.currentMax = currents.length ? Math.max(...currents) : 0;
  result.powerMean = mean(powers); result.powerMax = powers.length ? Math.max(...powers) : 0;
  for (const event of soter) {
    if (event.type === "door_opened") result.doorOpenings++;
    if (event.type === "interaction") result.soterInteractions++;
    if (event.type === "resident_recognized") result.recognizedResidents++;
    if (event.type === "arrival") result.arrivals++;
    if (event.type === "departure") result.departures++;
  }
  return result;
}

const floorWindow = (date: Date, minutes: number) => new Date(Math.floor(date.getTime() / (minutes * 60_000)) * minutes * 60_000);
const windowId = (date: Date) => date.toISOString().replace(/[:.]/g, "-");

function localSlot(date: Date, config: Config) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const val = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return { dayType: ["Sat", "Sun"].includes(val("weekday")) ? "weekend" : "weekday", slot: Math.floor((Number(val("hour")) * 60 + Number(val("minute"))) / config.windowMinutes) };
}

async function createAlert(config: Config, id: string, start: Date, result: ReturnType<typeof analyse>, features: Features) {
  const ref = root().collection("alerts").doc(id);
  if ((await ref.get()).exists) return;
  const payload = { status: "open", observedAt: Timestamp.fromDate(start), createdAt: Timestamp.now(), normalityIndex: result.normalityIndex, anomalyScore: result.anomalyScore, reasons: result.reasons, features };
  await ref.set(payload);
  if (!config.webhookEnabled) return;
  try {
    const response = await fetch(await secret(WEBHOOK_SECRET), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ householdId: HOUSEHOLD, ...payload, observedAt: start.toISOString() }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
    await ref.update({ webhookSentAt: Timestamp.now() });
  } catch (error) {
    logger.error("Alert webhook failed", error);
    await ref.update({ webhookError: error instanceof Error ? error.message : String(error) });
  }
}

async function analyseStoredWindow(config: Config, start: Date, sendAlert: boolean) {
  const end = new Date(start.getTime() + config.windowMinutes * 60_000), from = Timestamp.fromDate(start), to = Timestamp.fromDate(end);
  const [sensorSnap, soterSnap, historySnap] = await Promise.all([
    root().collection("sensor_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("soter_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("windows").where("startAt", ">=", Timestamp.fromMillis(start.getTime() - config.baselineDays * 86_400_000)).where("startAt", "<", from).get(),
  ]);
  const features = aggregate(sensorSnap.docs.map((d) => d.data() as SensorEvent), soterSnap.docs.map((d) => d.data() as SoterEvent));
  const local = localSlot(start, config);
  const baseline = historySnap.docs.map((d) => d.data()).filter((d) => d.dayType === local.dayType && Math.abs(Number(d.slot) - local.slot) <= 1).map((d) => d.features as Features);
  const result = analyse(features, baseline, config.minimumBaselineWindows, config.alertThreshold);
  let consecutive = 0;
  if (result.status === "unusual") {
    const previous = await root().collection("windows").orderBy("startAt", "desc").limit(Math.max(0, config.consecutiveWindows - 1)).get();
    consecutive = 1 + previous.docs.filter((d) => ["unusual", "alert"].includes(d.data().status)).length;
    if (consecutive >= config.consecutiveWindows) result.status = "alert";
  }
  const id = windowId(start);
  await root().collection("windows").doc(id).set({ startAt: from, endAt: to, ...local, features, ...result, consecutiveUnusualWindows: consecutive, analysedAt: Timestamp.now() }, { merge: true });
  if (sendAlert && result.status === "alert") await createAlert(config, id, start, result, features);
  return { id, features, ...result };
}

async function collectSoterRange(config: Config, start: Date, end: Date) {
  const soter = await fetchSoter(config, start, end);
  await storeEvents([], soter);
  return { soterEvents: soter.length };
}

async function collectAndAnalyse(force = false) {
  const config = await loadConfig();
  if (!config.enabled && !force) return { skipped: true, reason: "Analysis is disabled." };
  const now = new Date(), fallback = new Date(now.getTime() - 30 * 60_000);
  const cursor = config.lastCollectedAt?.toDate();
  const start = cursor ? new Date(Math.max(fallback.getTime(), cursor.getTime() - 10 * 60_000)) : fallback;
  const counts = await collectSoterRange(config, start, now);
  const completedStart = floorWindow(new Date(now.getTime() - config.windowMinutes * 60_000), config.windowMinutes);
  const analysis = await analyseStoredWindow(config, completedStart, true);
  await root().set({ lastCollectedAt: Timestamp.fromDate(now), lastCollectionStatus: "ok", lastCollectionCounts: counts, lastCollectionError: FieldValue.delete() }, { merge: true });
  return { skipped: false, counts, analysis };
}

async function backfill(days: number) {
  const config = await loadConfig(), end = new Date(), first = new Date(end.getTime() - days * 86_400_000);
  let soterEvents = 0;
  for (let cursor = first; cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const counts = await collectSoterRange(config, cursor, new Date(Math.min(end.getTime(), cursor.getTime() + 86_400_000)));
    soterEvents += counts.soterEvents;
  }
  await rebuildRange(config, first, end);
  await root().set({ lastCollectedAt: Timestamp.fromDate(end), lastCollectionStatus: "ok" }, { merge: true });
  return { days, soterEvents };
}

async function cleanupExpiredNonces() {
  const snapshot = await root().collection("ingest_nonces").where("expiresAt", "<", Timestamp.now()).limit(400).get();
  if (snapshot.empty) return 0;
  const batch = getFirestore().batch();
  snapshot.docs.forEach((document) => batch.delete(document.ref));
  await batch.commit();
  return snapshot.size;
}

async function rebuildRange(config: Config, first: Date, end: Date) {
  const from = Timestamp.fromDate(first), to = Timestamp.fromDate(end);
  const [sensorSnap, soterSnap, olderSnap] = await Promise.all([
    root().collection("sensor_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("soter_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("windows").where("startAt", ">=", Timestamp.fromMillis(first.getTime() - config.baselineDays * 86_400_000)).where("startAt", "<", from).get(),
  ]);
  const sensorBuckets = new Map<number, SensorEvent[]>(), soterBuckets = new Map<number, SoterEvent[]>();
  for (const doc of sensorSnap.docs) {
    const event = doc.data() as SensorEvent, key = floorWindow(event.observedAt.toDate(), config.windowMinutes).getTime();
    sensorBuckets.set(key, [...(sensorBuckets.get(key) ?? []), event]);
  }
  for (const doc of soterSnap.docs) {
    const event = doc.data() as SoterEvent, key = floorWindow(event.observedAt.toDate(), config.windowMinutes).getTime();
    soterBuckets.set(key, [...(soterBuckets.get(key) ?? []), event]);
  }
  const history = olderSnap.docs.map((doc) => doc.data() as FirebaseFirestore.DocumentData);
  const pending: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = [];
  let priorStatus = "normal", consecutive = 0;
  for (let cursor = floorWindow(first, config.windowMinutes); cursor < end; cursor = new Date(cursor.getTime() + config.windowMinutes * 60_000)) {
    const features = aggregate(sensorBuckets.get(cursor.getTime()) ?? [], soterBuckets.get(cursor.getTime()) ?? []);
    const local = localSlot(cursor, config), cutoff = cursor.getTime() - config.baselineDays * 86_400_000;
    const baseline = history.filter((record) => {
      const at = (record.startAt as Timestamp).toMillis();
      return at >= cutoff && at < cursor.getTime() && record.dayType === local.dayType && Math.abs(Number(record.slot) - local.slot) <= 1;
    }).map((record) => record.features as Features);
    const result = analyse(features, baseline, config.minimumBaselineWindows, config.alertThreshold);
    if (result.status === "unusual") {
      consecutive = ["unusual", "alert"].includes(priorStatus) ? consecutive + 1 : 1;
      if (consecutive >= config.consecutiveWindows) result.status = "alert";
    } else consecutive = 0;
    priorStatus = result.status;
    const data = { startAt: Timestamp.fromDate(cursor), endAt: Timestamp.fromMillis(cursor.getTime() + config.windowMinutes * 60_000), ...local, features, ...result, consecutiveUnusualWindows: consecutive, analysedAt: Timestamp.now() };
    history.push(data); pending.push({ id: windowId(cursor), data });
  }
  for (let i = 0; i < pending.length; i += 450) {
    const batch = getFirestore().batch();
    for (const item of pending.slice(i, i + 450)) batch.set(root().collection("windows").doc(item.id), item.data, { merge: true });
    await batch.commit();
  }
}

function sanitize(input: unknown, existing: Config): Config {
  if (!input || typeof input !== "object") throw new Error("Configuration must be an object.");
  const body = input as Record<string, unknown>, valid = new Set<SensorKind>(["motion", "current", "power"]);
  const entities = (Array.isArray(body.entities) ? body.entities : existing.entities).map((raw) => {
    const item = raw as Record<string, unknown>, entityId = String(item.entityId ?? "").trim(), kind = String(item.kind ?? "") as SensorKind;
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) throw new Error(`Invalid entity ID: ${entityId}`);
    if (!valid.has(kind)) throw new Error(`Invalid sensor kind for ${entityId}`);
    return { entityId, kind, label: String(item.label ?? "").trim() || undefined } as EntityConfig;
  });
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = body[key] === undefined ? fallback : Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    return value;
  };
  return {
    ...existing, enabled: body.enabled === undefined ? existing.enabled : Boolean(body.enabled),
    webhookEnabled: body.webhookEnabled === undefined ? existing.webhookEnabled : Boolean(body.webhookEnabled),
    timezone: String(body.timezone ?? existing.timezone).trim() || "Europe/London", entities,
    windowMinutes: integer("windowMinutes", existing.windowMinutes, 5, 60), baselineDays: integer("baselineDays", existing.baselineDays, 7, 180),
    minimumBaselineWindows: integer("minimumBaselineWindows", existing.minimumBaselineWindows, 7, 200), alertThreshold: integer("alertThreshold", existing.alertThreshold, 1, 99),
    consecutiveWindows: integer("consecutiveWindows", existing.consecutiveWindows, 1, 8), updatedAt: Timestamp.now(),
  };
}

const jsonValue = (value: unknown): unknown => {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonValue(nested)]));
  return value;
};
const iso = (data: FirebaseFirestore.DocumentData) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, jsonValue(value)]));
interface AuthedRequest extends Request { user?: { email: string; uid: string }; rawBody?: Buffer }
const api = express();
api.disable("x-powered-by");
api.use(express.json({ limit: "256kb", verify: (request, _response, body) => { (request as AuthedRequest).rawBody = Buffer.from(body); } }));

api.post("/api/ingest", async (req: AuthedRequest, res) => {
  const rawBody = req.rawBody ?? Buffer.alloc(0), now = Date.now();
  let signed: { timestamp: string; nonce: string };
  let ingestSecret: string;
  try { ingestSecret = await secret(INGEST_SECRET); }
  catch (error) { logger.error("Collector secret is unavailable", error); res.status(503).json({ error: "Collector ingestion is not configured." }); return; }
  try {
    signed = verifySignature(ingestSecret, {
      timestamp: req.header("X-Soter-Timestamp"), nonce: req.header("X-Soter-Nonce"), signature: req.header("X-Soter-Signature"),
    }, rawBody, now);
  } catch (error) {
    logger.warn("Rejected collector authentication", { error: error instanceof Error ? error.message : String(error) });
    res.status(401).json({ error: "Collector authentication failed." }); return;
  }
  let payload: ReturnType<typeof validatePayload>;
  try {
    const config = await loadConfig();
    payload = validatePayload(req.body, config.entities, HOUSEHOLD, now);
  } catch (error) {
    logger.warn("Rejected collector payload", { error: error instanceof Error ? error.message : String(error) });
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid collector payload." }); return;
  }
  try {
    const nonceRef = root().collection("ingest_nonces").doc(hash(`${payload.collectorId}|${signed.nonce}`));
    const sensors: IdentifiedSensor[] = payload.events.map((event) => ({
      id: event.id, source: "home_assistant", entityId: event.entityId, kind: event.kind, state: event.state,
      numericValue: event.numericValue, observedAt: Timestamp.fromDate(new Date(event.observedAt)), unit: event.unit,
      friendlyName: event.friendlyName,
    }));
    await storeEvents(sensors, []);
    const latestEvent = sensors.reduce<Date | undefined>((latest, event) => {
      const observed = event.observedAt.toDate(); return !latest || observed > latest ? observed : latest;
    }, undefined);
    const collector: FirebaseFirestore.DocumentData = {
      id: payload.collectorId, version: payload.health?.version ?? null, queueDepth: payload.health?.queueDepth ?? null,
      sentAt: Timestamp.fromDate(new Date(payload.sentAt)), lastSeenAt: Timestamp.now(), status: "ok",
    };
    if (latestEvent) collector.lastEventAt = Timestamp.fromDate(latestEvent);
    if (payload.health?.lastBackfillAt) collector.lastBackfillAt = Timestamp.fromDate(new Date(payload.health.lastBackfillAt));
    await root().set({
      sourceMode: "home_assistant_push", collector,
      lastSensorIngestAt: Timestamp.now(), ...(latestEvent ? { lastSensorEventAt: Timestamp.fromDate(latestEvent) } : {}),
    }, { merge: true });
    try {
      await nonceRef.create({ collectorId: payload.collectorId, signedAt: Timestamp.fromMillis(Number(signed.timestamp) * 1000), createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(now + 10 * 60_000) });
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 6 || code === "already-exists") { res.status(409).json({ error: "This signed request has already been accepted." }); return; }
      throw error;
    }
    res.status(202).json({ accepted: sensors.length, duplicateSafe: true, receivedAt: new Date(now).toISOString() });
  } catch (error) {
    logger.error("Collector ingest failed", error);
    res.status(500).json({ error: "The collector batch could not be stored; it is safe to retry." });
  }
});

api.use(async (req: AuthedRequest, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const token = req.header("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) { res.status(401).json({ error: "Sign in is required." }); return; }
  try {
    const decoded = await getAuth().verifyIdToken(token), email = decoded.email?.toLowerCase();
    if (!email || !decoded.email_verified || !admins.has(email)) { res.status(403).json({ error: "This verified account is not authorised." }); return; }
    req.user = { email, uid: decoded.uid }; next();
  } catch { res.status(401).json({ error: "The session is invalid or expired." }); }
});

api.get("/api/overview", async (req, res) => {
  const hours = Math.min(2160, Math.max(1, Number(req.query.hours) || 168)), since = Timestamp.fromMillis(Date.now() - hours * 3_600_000);
  const [config, windows, alerts, health] = await Promise.all([
    loadConfig(), root().collection("windows").where("startAt", ">=", since).orderBy("startAt").get(),
    root().collection("alerts").where("observedAt", ">=", since).orderBy("observedAt", "desc").limit(50).get(), root().get(),
  ]);
  res.json({ config: { ...config, lastCollectedAt: config.lastCollectedAt?.toDate().toISOString() ?? null }, health: iso(health.data() ?? {}), windows: windows.docs.map((d) => ({ id: d.id, ...iso(d.data()) })), alerts: alerts.docs.map((d) => ({ id: d.id, ...iso(d.data()) })) });
});
api.put("/api/config", async (req: AuthedRequest, res) => {
  try { const config = sanitize(req.body, await loadConfig()); config.updatedBy = req.user?.email; await root().set(config, { merge: true }); res.json({ config }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
api.post("/api/collect", async (_req, res) => { try { res.json(await collectAndAnalyse(true)); } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : String(e) }); } });
api.post("/api/backfill", async (req, res) => { try { res.json(await backfill(Math.min(42, Math.max(1, Number(req.body?.days) || 14)))); } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : String(e) }); } });
api.post("/api/alerts/:id/acknowledge", async (req: AuthedRequest, res) => { await root().collection("alerts").doc(String(req.params.id)).set({ status: "acknowledged", acknowledgedAt: Timestamp.now(), acknowledgedBy: req.user?.email }, { merge: true }); res.json({ ok: true }); });
api.use((_req, res) => res.status(404).json({ error: "Not found." }));

export const haSensorsApi = onRequest({ region: REGION, serviceAccount: RUNTIME_SA, memory: "512MiB", timeoutSeconds: 540, maxInstances: 5 }, api);
export const collectHaSensors = onSchedule({ region: REGION, serviceAccount: RUNTIME_SA, schedule: "every 5 minutes", timeZone: "Europe/London", memory: "512MiB", timeoutSeconds: 240, retryCount: 1 }, async () => {
  try {
    const result = await collectAndAnalyse(), expiredNonces = await cleanupExpiredNonces();
    logger.info("Collection complete", { ...result, expiredNonces });
  }
  catch (error) {
    logger.error("Collection failed", error);
    await root().set({ lastCollectionStatus: "error", lastCollectionError: error instanceof Error ? error.message : String(error), lastCollectionAttemptAt: Timestamp.now() }, { merge: true });
    throw error;
  }
});
