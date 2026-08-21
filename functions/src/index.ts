import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import express, { NextFunction, Request, Response } from "express";
import { App, getApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { isMotionActive, isTelevision, PowerSample, televisionFeatures, televisionSessions } from "./activity";
import { checkpointLabel, checkpointStart, checkpointsBetween, latestCheckpoint } from "./checkpoints";
import { dueScheduleSlots, sanitizeEmailPreferences } from "./email";
import { validatePayload, verifySignature } from "./ingest";
import { analyse } from "./normality";
import { conversationHistoryCard, conversationTypes } from "./soter";
import { Config, EmailPreferences, EntityConfig, Features, SensorEvent, SensorKind, SoterEvent, SoterEventType, SoterHistoryCard } from "./types";

initializeApp();

const TARGET_PROJECT = "soter-updater-59ead";
const HOUSEHOLD = "household-mpcck67b-epr7fs";
const SOURCE_PROJECT = "doorassistant-bc50a";
const SOTER_DEVICE = "e4ca4cf8b0e37b91";
const REGION = "australia-southeast1";
const RUNTIME_SA = `ha-sensors-runtime@${TARGET_PROJECT}.iam.gserviceaccount.com`;
const INGEST_SECRET = "ha-sensors-ingest-secret";
const WEBHOOK_SECRET = "ha-sensors-alert-webhook";
const SMTP_URL_SECRET = "ha-sensors-smtp-url";
const EMAIL_FROM_SECRET = "ha-sensors-email-from";
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

let mailerPromise: Promise<{ transport: nodemailer.Transporter; from: string }> | undefined;
function mailer() {
  if (!mailerPromise) mailerPromise = Promise.all([secret(SMTP_URL_SECRET), secret(EMAIL_FROM_SECRET)])
    .then(([smtpUrl, from]) => ({ transport: nodemailer.createTransport(smtpUrl), from }))
    .catch((error) => { mailerPromise = undefined; throw error; });
  return mailerPromise;
}

const emailPreferencesRef = (uid: string) => root().collection("email_subscriptions").doc(uid);
const defaultEmailPreferences = (email: string, config: Config): EmailPreferences => ({ email, thresholdEnabled: false, threshold: config.alertThreshold, scheduleTimes: [] });

async function loadEmailPreferences(uid: string, email: string, config: Config) {
  const snapshot = await emailPreferencesRef(uid).get();
  return snapshot.exists
    ? sanitizeEmailPreferences(snapshot.data() ?? {}, email, defaultEmailPreferences(email, config))
    : defaultEmailPreferences(email, config);
}

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const localEmailTime = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date);
function emailBody(title: string, introduction: string, rows: Array<[string, string]>) {
  const rowHtml = rows.map(([label, value]) => `<tr><th style="padding:7px 12px 7px 0;text-align:left;color:#60716c;font-weight:600">${escapeHtml(label)}</th><td style="padding:7px 0;color:#203b3f">${escapeHtml(value)}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#263b3e"><div style="padding:24px;border:1px solid #dce5df;border-radius:18px"><div style="color:#167a68;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">Soter Activity</div><h1 style="margin:8px 0 12px;font-size:26px">${escapeHtml(title)}</h1><p style="line-height:1.55;color:#51605c">${escapeHtml(introduction)}</p><table style="border-collapse:collapse;font-size:14px">${rowHtml}</table><p style="margin:22px 0 0"><a href="https://soter-normality.web.app" style="color:#167a68;font-weight:700">Open the activity dashboard</a></p></div><p style="color:#89948f;font-size:11px;text-align:center">Decision support only; not an emergency or medical monitoring service.</p></div>`;
}

async function sendEmailOnce(uid: string, deliveryKey: string, message: { to: string; subject: string; html: string }, strict = false) {
  const ref = root().collection("email_deliveries").doc(hash(`${uid}|${deliveryKey}`));
  const reserved = await getFirestore().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref), data = snapshot.data();
    const lastAttemptAt = data?.lastAttemptAt instanceof Timestamp ? data.lastAttemptAt.toMillis() : 0;
    if (data?.status === "sent" || (data?.status === "sending" && lastAttemptAt > 0 && Date.now() - lastAttemptAt < 10 * 60_000) || Number(data?.attempts ?? 0) >= 3) return false;
    transaction.set(ref, { uid, deliveryKey, to: message.to, status: "sending", attempts: FieldValue.increment(1), lastAttemptAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 90 * 86_400_000) }, { merge: true });
    return true;
  });
  if (!reserved) return "duplicate" as const;
  try {
    const sender = await mailer();
    const info = await sender.transport.sendMail({ from: sender.from, ...message });
    await ref.set({ status: "sent", sentAt: Timestamp.now(), messageId: info.messageId ?? null, lastError: FieldValue.delete() }, { merge: true });
    return "sent" as const;
  } catch (error) {
    mailerPromise = undefined;
    const messageText = error instanceof Error ? error.message : String(error);
    await ref.set({ status: "failed", failedAt: Timestamp.now(), lastError: messageText.slice(0, 500) }, { merge: true });
    logger.error("Activity email delivery failed", { uid, deliveryKey, error: messageText });
    if (strict) throw error;
    return "failed" as const;
  }
}

async function emailSubscriptions() {
  const snapshot = await root().collection("email_subscriptions").get();
  return snapshot.docs.flatMap((document) => {
    const data = document.data() as Partial<EmailPreferences>;
    return typeof data.email === "string" ? [{ uid: document.id, preferences: data as EmailPreferences }] : [];
  });
}

async function sendThresholdEmails(config: Config, end: Date, result: ReturnType<typeof analyse>) {
  if (result.normalityIndex === null) return 0;
  const subscriptions = await emailSubscriptions();
  const recipients = subscriptions.filter(({ preferences }) => preferences.thresholdEnabled && result.normalityIndex! < Number(preferences.threshold));
  await Promise.all(recipients.map(({ uid, preferences }) => sendEmailOnce(uid, `threshold-${windowId(end)}`, {
    to: preferences.email,
    subject: `Soter activity alert — normality ${result.normalityIndex}`,
    html: emailBody("Activity is outside your email threshold", result.reasons[0] ?? "The latest activity checkpoint differs from the learned household routine.", [
      ["Normality", String(result.normalityIndex)], ["Your email threshold", String(preferences.threshold)], ["Checkpoint", localEmailTime(end, config.timezone)],
    ]),
  })));
  return recipients.length;
}

async function sendScheduledEmails(config: Config, now: Date) {
  const subscriptions = await emailSubscriptions();
  const due = subscriptions.flatMap(({ uid, preferences }) => dueScheduleSlots(preferences.scheduleTimes ?? [], now, config.timezone).map((slot) => ({ uid, preferences, slot })));
  if (!due.length) return 0;
  const windows = await root().collection("windows").orderBy("endAt", "desc").limit(10).get();
  const latest = windows.docs.map((document) => document.data()).find((window) => typeof window.checkpoint === "string");
  await Promise.all(due.map(({ uid, preferences, slot }) => {
    const normality = typeof latest?.normalityIndex === "number" ? String(latest.normalityIndex) : "Still learning";
    const status = String(latest?.status ?? "learning");
    const reason = Array.isArray(latest?.reasons) ? String(latest.reasons[0] ?? "No explanation available.") : "No explanation available.";
    return sendEmailOnce(uid, `scheduled-${slot.id}`, {
      to: preferences.email,
      subject: `Soter activity update — ${slot.time}`,
      html: emailBody("Your scheduled activity update", reason, [
        ["Normality", normality], ["Status", status], ["Summary time", `${slot.localDate} ${slot.time} (${config.timezone})`],
      ]),
    });
  }));
  return due.length;
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

async function fetchConversationCards(config: Config, sourceIds: string[]): Promise<Map<string, SoterHistoryCard>> {
  const database = sourceDb(config.soterProjectId), cards = new Map<string, SoterHistoryCard>();
  const ids = [...new Set(sourceIds)];
  for (let index = 0; index < ids.length; index += 200) {
    const references = ids.slice(index, index + 200).map((id) => database.collection("devices").doc(config.soterDeviceId).collection("conversations").doc(id));
    if (!references.length) continue;
    const snapshots = await database.getAll(...references);
    snapshots.forEach((snapshot) => { if (snapshot.exists) cards.set(snapshot.id, conversationHistoryCard(snapshot.data() ?? {})); });
  }
  return cards;
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
  powerMax: 0, tvMinutes: 0, tvSessions: 0, doorOpenings: 0, soterInteractions: 0,
  recognizedResidents: 0, arrivals: 0, departures: 0, visitorArrivals: 0,
});
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const powerSamples = (sensors: SensorEvent[]): PowerSample[] => sensors.flatMap((event) => event.kind === "power" && event.numericValue !== null ? [{
  entityId: event.entityId, label: event.friendlyName ?? event.entityId,
  observedAt: event.observedAt.toMillis(), value: event.numericValue,
}] : []);

function aggregate(sensors: SensorEvent[], soter: SoterEvent[], start: Date, end: Date, timezone: string): Features {
  const result = empty(), active = new Set<string>(), currents: number[] = [], powers: number[] = [];
  const startMillis = start.getTime(), endMillis = end.getTime();
  for (const event of sensors.filter((value) => value.observedAt.toMillis() >= startMillis && value.observedAt.toMillis() < endMillis)) {
    if (event.kind === "motion" && isMotionActive(event.state)) { result.motionEvents++; active.add(event.entityId); }
    if (event.kind === "current" && (event.numericValue ?? 0) > 0) currents.push(event.numericValue!);
    if (event.kind === "power" && (event.numericValue ?? 0) > 0 && !isTelevision(event.entityId, event.friendlyName ?? "")) powers.push(event.numericValue!);
  }
  result.activeMotionSensors = active.size;
  result.currentMean = mean(currents); result.currentMax = currents.length ? Math.max(...currents) : 0;
  result.powerMean = mean(powers); result.powerMax = powers.length ? Math.max(...powers) : 0;
  Object.assign(result, televisionFeatures(powerSamples(sensors), startMillis, endMillis, timezone));
  for (const event of soter) {
    if (event.type === "door_opened") result.doorOpenings++;
    if (event.type === "interaction") result.soterInteractions++;
    if (event.type === "resident_recognized") result.recognizedResidents++;
    if (event.type === "arrival") result.arrivals++;
    if (event.type === "departure") result.departures++;
    if (event.type === "visitor_arrival") result.visitorArrivals++;
  }
  return result;
}

const windowId = (date: Date) => date.toISOString().replace(/[:.]/g, "-");

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

async function analyseStoredCheckpoint(config: Config, end: Date, sendAlert: boolean) {
  const start = checkpointStart(end, config.timezone), from = Timestamp.fromDate(start), to = Timestamp.fromDate(end);
  const sensorFrom = Timestamp.fromMillis(start.getTime() - 24 * 3_600_000);
  const checkpoint = checkpointLabel(end, config.timezone);
  const [sensorSnap, soterSnap, historySnap] = await Promise.all([
    root().collection("sensor_events").where("observedAt", ">=", sensorFrom).where("observedAt", "<", to).get(),
    root().collection("soter_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("windows").where("endAt", ">=", Timestamp.fromMillis(end.getTime() - config.baselineDays * 86_400_000)).where("endAt", "<", to).get(),
  ]);
  const features = aggregate(sensorSnap.docs.map((d) => d.data() as SensorEvent), soterSnap.docs.map((d) => d.data() as SoterEvent), start, end, config.timezone);
  const history = historySnap.docs.map((document) => document.data()).filter((record) => typeof record.checkpoint === "string");
  const baseline = history.filter((record) => record.checkpoint === checkpoint).map((record) => record.features as Features);
  const result = analyse(features, baseline, config.minimumBaselineWindows, config.alertThreshold);
  let consecutive = 0;
  if (result.status === "unusual") {
    const previous = history.sort((a, b) => (b.endAt as Timestamp).toMillis() - (a.endAt as Timestamp).toMillis()).slice(0, Math.max(0, config.consecutiveWindows - 1));
    consecutive = 1 + previous.filter((record) => ["unusual", "alert"].includes(record.status)).length;
    if (consecutive >= config.consecutiveWindows) result.status = "alert";
  }
  const id = `checkpoint-${windowId(end)}`;
  await root().collection("windows").doc(id).set({ startAt: from, endAt: to, checkpoint, periodHours: 6, features, ...result, consecutiveUnusualWindows: consecutive, analysedAt: Timestamp.now() }, { merge: true });
  if (sendAlert) await sendThresholdEmails(config, end, result);
  if (sendAlert && result.status === "alert") await createAlert(config, id, end, result, features);
  return { id, startAt: start.toISOString(), endAt: end.toISOString(), checkpoint, features, ...result };
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
  const classificationUpgrade = (config.soterClassificationVersion ?? 0) < 2;
  const featureUpgrade = (config.analysisFeatureVersion ?? 0) < 2;
  const start = classificationUpgrade ? new Date(now.getTime() - 48 * 3_600_000) : cursor ? new Date(Math.max(fallback.getTime(), cursor.getTime() - 10 * 60_000)) : fallback;
  const counts = await collectSoterRange(config, start, now);
  const checkpoint = latestCheckpoint(now, config.timezone);
  const alreadyAnalysed = (config.lastAnalysedCheckpointAt?.toMillis() ?? 0) >= checkpoint.getTime();
  const analysis = force || featureUpgrade || !alreadyAnalysed ? await analyseStoredCheckpoint(config, checkpoint, true) : null;
  await root().set({
    lastCollectedAt: Timestamp.fromDate(now), lastCollectionStatus: "ok", lastCollectionCounts: counts,
    lastCollectionError: FieldValue.delete(), soterClassificationVersion: 2, analysisFeatureVersion: 2,
    ...(analysis ? { lastAnalysedCheckpointAt: Timestamp.fromDate(checkpoint) } : {}),
  }, { merge: true });
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
  const eventFirst = new Date(first.getTime() - 24 * 3_600_000), from = Timestamp.fromDate(eventFirst), to = Timestamp.fromDate(end);
  const [sensorSnap, soterSnap, olderSnap] = await Promise.all([
    root().collection("sensor_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("soter_events").where("observedAt", ">=", from).where("observedAt", "<", to).get(),
    root().collection("windows").where("endAt", ">=", Timestamp.fromMillis(first.getTime() - config.baselineDays * 86_400_000)).where("endAt", "<", Timestamp.fromDate(first)).get(),
  ]);
  const sensors = sensorSnap.docs.map((document) => document.data() as SensorEvent);
  const soter = soterSnap.docs.map((document) => document.data() as SoterEvent);
  const history = olderSnap.docs.map((document) => document.data() as FirebaseFirestore.DocumentData).filter((record) => typeof record.checkpoint === "string");
  const pending: Array<{ id: string; data: FirebaseFirestore.DocumentData }> = [];
  const previous = [...history].sort((a, b) => (a.endAt as Timestamp).toMillis() - (b.endAt as Timestamp).toMillis()).at(-1);
  let priorStatus = String(previous?.status ?? "normal"), consecutive = ["unusual", "alert"].includes(priorStatus) ? Number(previous?.consecutiveUnusualWindows ?? 1) : 0;
  const checkpoints = checkpointsBetween(first, end, config.timezone);
  for (const checkpointEnd of checkpoints) {
    const start = checkpointStart(checkpointEnd, config.timezone), startMillis = start.getTime(), endMillis = checkpointEnd.getTime();
    const features = aggregate(
      sensors,
      soter.filter((event) => event.observedAt.toMillis() >= startMillis && event.observedAt.toMillis() < endMillis),
      start, checkpointEnd, config.timezone,
    );
    const checkpoint = checkpointLabel(checkpointEnd, config.timezone), cutoff = endMillis - config.baselineDays * 86_400_000;
    const baseline = history.filter((record) => {
      const at = (record.endAt as Timestamp).toMillis();
      return at >= cutoff && at < endMillis && record.checkpoint === checkpoint;
    }).map((record) => record.features as Features);
    const result = analyse(features, baseline, config.minimumBaselineWindows, config.alertThreshold);
    if (result.status === "unusual") {
      consecutive = ["unusual", "alert"].includes(priorStatus) ? consecutive + 1 : 1;
      if (consecutive >= config.consecutiveWindows) result.status = "alert";
    } else consecutive = 0;
    priorStatus = result.status;
    const data = { startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(checkpointEnd), checkpoint, periodHours: 6, features, ...result, consecutiveUnusualWindows: consecutive, analysedAt: Timestamp.now() };
    history.push(data); pending.push({ id: `checkpoint-${windowId(checkpointEnd)}`, data });
  }
  for (let i = 0; i < pending.length; i += 450) {
    const batch = getFirestore().batch();
    for (const item of pending.slice(i, i + 450)) batch.set(root().collection("windows").doc(item.id), item.data, { merge: true });
    await batch.commit();
  }
  const latest = checkpoints.at(-1);
  if (latest) await root().set({ lastAnalysedCheckpointAt: Timestamp.fromDate(latest), soterClassificationVersion: 2, analysisFeatureVersion: 2 }, { merge: true });
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

api.get("/api/overview", async (req: AuthedRequest, res) => {
  const hours = Math.min(2160, Math.max(1, Number(req.query.hours) || 48)), since = Timestamp.fromMillis(Date.now() - hours * 3_600_000);
  const config = await loadConfig();
  const [windows, alerts, health, emailPreferences] = await Promise.all([
    root().collection("windows").where("endAt", ">=", since).orderBy("endAt").get(),
    root().collection("alerts").where("observedAt", ">=", since).orderBy("observedAt", "desc").limit(50).get(), root().get(),
    loadEmailPreferences(req.user!.uid, req.user!.email, config),
  ]);
  res.json({
    config: iso(config as unknown as FirebaseFirestore.DocumentData), health: iso(health.data() ?? {}),
    windows: windows.docs.filter((document) => typeof document.data().checkpoint === "string").map((document) => ({ id: document.id, ...iso(document.data()) })),
    alerts: alerts.docs.map((document) => ({ id: document.id, ...iso(document.data()) })),
    emailPreferences: iso(emailPreferences as unknown as FirebaseFirestore.DocumentData),
  });
});
api.get("/api/events", async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 48)), now = Date.now();
  const sinceMillis = now - hours * 3_600_000, since = Timestamp.fromMillis(sinceMillis), sensorSince = Timestamp.fromMillis(sinceMillis - 24 * 3_600_000), limit = 5000;
  const [config, sensors, soter] = await Promise.all([
    loadConfig(),
    root().collection("sensor_events").where("observedAt", ">=", sensorSince).orderBy("observedAt", "desc").limit(limit).get(),
    root().collection("soter_events").where("observedAt", ">=", since).orderBy("observedAt", "desc").limit(limit).get(),
  ]);
  const soterLabels: Partial<Record<SoterEventType, string>> = {
    departure: "Occupant leaving", arrival: "Occupant returning", visitor_arrival: "Visitor arriving",
    door_opened: "Door opening", door_left_open: "Door left open",
  };
  const sensorRecords = sensors.docs.map((document) => ({ id: document.id, event: document.data() as SensorEvent }));
  const sensorEvents = sensorRecords.flatMap(({ id, event }) => {
    const observedAt = event.observedAt.toMillis(), tv = isTelevision(event.entityId, event.friendlyName ?? "");
    const meaningful = observedAt >= sinceMillis && (
      (event.kind === "motion" && isMotionActive(event.state)) ||
      (event.kind !== "motion" && !tv && (event.numericValue ?? 0) > 0)
    );
    if (!meaningful) return [];
    return [{
      id, source: "home_assistant", category: event.kind === "motion" ? "movement" : "energy", type: event.kind,
      observedAt: event.observedAt.toDate().toISOString(), label: event.friendlyName ?? event.entityId, entityId: event.entityId,
      state: event.state, value: event.numericValue, unit: event.unit ?? null,
    }];
  });
  const tvEvents = televisionSessions(powerSamples(sensorRecords.map((record) => record.event)), now, config.timezone)
    .filter((session) => session.endAt > sinceMillis && session.startAt < now)
    .map((session) => ({
      id: hash(`${session.entityId}|${session.startAt}|${session.endAt}`), source: "home_assistant", category: "energy", type: "tv_session",
      observedAt: new Date(Math.max(sinceMillis, session.startAt)).toISOString(), startAt: new Date(session.startAt).toISOString(), endAt: new Date(session.endAt).toISOString(),
      label: session.label, entityId: session.entityId, state: session.ongoing ? "on" : "complete", value: session.averagePower,
      unit: "W", durationMinutes: session.durationMinutes, peakPower: session.peakPower, ongoing: session.ongoing,
    }));
  const conversationEventTypes = new Set<SoterEventType>(["interaction", "resident_recognized", "arrival", "departure", "visitor_arrival"]);
  const soterRecords = soter.docs.map((document) => ({ id: document.id, event: document.data() as SoterEvent }));
  let cards = new Map<string, SoterHistoryCard>();
  try { cards = await fetchConversationCards(config, soterRecords.filter(({ event }) => conversationEventTypes.has(event.type)).map(({ event }) => event.sourceId)); }
  catch (error) { logger.warn("Soter history cards unavailable; returning event fallbacks.", error); }
  const soterEvents = soterRecords.flatMap(({ id, event }) => {
    const label = soterLabels[event.type];
    return label ? [{
      id, source: "soter", category: "door", type: event.type,
      observedAt: event.observedAt.toDate().toISOString(), label, state: null, value: null, unit: null,
      history: cards.get(event.sourceId),
    }] : [];
  });
  const events = [...sensorEvents, ...tvEvents, ...soterEvents].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  res.json({ hours, timezone: config.timezone, since: since.toDate().toISOString(), truncated: sensors.size === limit || soter.size === limit, events });
});
api.put("/api/config", async (req: AuthedRequest, res) => {
  try { const config = sanitize(req.body, await loadConfig()); config.updatedBy = req.user?.email; await root().set(config, { merge: true }); res.json({ config }); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
api.put("/api/email-preferences", async (req: AuthedRequest, res) => {
  try {
    const config = await loadConfig(), existing = await loadEmailPreferences(req.user!.uid, req.user!.email, config);
    const preferences = sanitizeEmailPreferences(req.body, req.user!.email, existing);
    await emailPreferencesRef(req.user!.uid).set({ ...preferences, updatedAt: Timestamp.now() }, { merge: true });
    res.json({ emailPreferences: preferences });
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
api.post("/api/email-preferences/test", async (req: AuthedRequest, res) => {
  try {
    const config = await loadConfig(), preferences = await loadEmailPreferences(req.user!.uid, req.user!.email, config);
    const result = await sendEmailOnce(req.user!.uid, `test-${Date.now()}`, {
      to: preferences.email,
      subject: "Soter activity email test",
      html: emailBody("Email alerts are connected", "This test confirms that Soter Activity can send notifications to your verified login email.", [["Recipient", preferences.email], ["Timezone", config.timezone]]),
    }, true);
    res.json({ result });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : "Test email could not be sent." }); }
});
api.post("/api/collect", async (_req, res) => { try { res.json(await collectAndAnalyse(true)); } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : String(e) }); } });
api.post("/api/backfill", async (req, res) => { try { res.json(await backfill(Math.min(42, Math.max(1, Number(req.body?.days) || 14)))); } catch (e) { res.status(502).json({ error: e instanceof Error ? e.message : String(e) }); } });
api.post("/api/alerts/:id/acknowledge", async (req: AuthedRequest, res) => { await root().collection("alerts").doc(String(req.params.id)).set({ status: "acknowledged", acknowledgedAt: Timestamp.now(), acknowledgedBy: req.user?.email }, { merge: true }); res.json({ ok: true }); });
api.use((_req, res) => res.status(404).json({ error: "Not found." }));

export const haSensorsApi = onRequest({ region: REGION, serviceAccount: RUNTIME_SA, memory: "512MiB", timeoutSeconds: 540, maxInstances: 5 }, api);
export const collectHaSensors = onSchedule({ region: REGION, serviceAccount: RUNTIME_SA, schedule: "every 5 minutes", timeZone: "Europe/London", memory: "512MiB", timeoutSeconds: 240, retryCount: 1 }, async () => {
  try {
    const result = await collectAndAnalyse(), config = await loadConfig();
    const [expiredNonces, scheduledEmails] = await Promise.all([cleanupExpiredNonces(), sendScheduledEmails(config, new Date())]);
    logger.info("Collection complete", { ...result, expiredNonces, scheduledEmails });
  }
  catch (error) {
    logger.error("Collection failed", error);
    await root().set({ lastCollectionStatus: "error", lastCollectionError: error instanceof Error ? error.message : String(error), lastCollectionAttemptAt: Timestamp.now() }, { merge: true });
    throw error;
  }
});
