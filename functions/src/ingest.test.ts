import assert from "node:assert/strict";
import test from "node:test";
import { makeSignature, validatePayload, verifySignature } from "./ingest";

const entities = [{ entityId: "binary_sensor.hall_motion", kind: "motion" as const, label: "Hall" }];

test("collector signatures cover timestamp, nonce, and exact body", () => {
  const body = Buffer.from('{"version":1}'), timestamp = "1735689600", nonce = "abcdefghijklmnop";
  const signature = makeSignature("secret", timestamp, nonce, body);
  assert.equal(signature, "9a1e44dbca5b69cd76564438271ee4d946d7cd638271e0bb3f00c386eddcdc48");
  assert.deepEqual(verifySignature("secret", { timestamp, nonce, signature }, body, 1_735_689_600_000), { timestamp, nonce });
  assert.throws(() => verifySignature("secret", { timestamp, nonce, signature }, Buffer.from("changed"), 1_735_689_600_000));
});

test("ingest validates the configured entity allowlist", () => {
  const now = Date.parse("2026-08-20T00:00:00Z");
  const payload = validatePayload({
    version: 1, householdId: "household-1", collectorId: "haos-001", sentAt: new Date(now).toISOString(),
    events: [{ id: "a".repeat(64), entityId: "binary_sensor.hall_motion", kind: "motion", state: "on", numericValue: null, observedAt: new Date(now - 1000).toISOString() }],
    health: { version: "0.1.0", queueDepth: 1 },
  }, entities, "household-1", now);
  assert.equal(payload.events[0].friendlyName, "Hall");
  assert.throws(() => validatePayload({ ...payload, events: [{ ...payload.events[0], entityId: "binary_sensor.unknown" }] }, entities, "household-1", now), /allowlist/);
});
