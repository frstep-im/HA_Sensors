import assert from "node:assert/strict";
import test from "node:test";
import { isMotionActive, isTelevision, televisionFeatures, televisionSessions } from "./activity";

const at = (value: string) => new Date(value).getTime();
const sample = (value: number, observedAt: string) => ({ entityId: "sensor.tv_power", label: "TV", value, observedAt: at(observedAt) });

test("only movement activation states are significant", () => {
  assert.equal(isMotionActive("on"), true);
  assert.equal(isMotionActive("off"), false);
  assert.equal(isMotionActive("cleared"), false);
});

test("television entities are identified by entity or label", () => {
  assert.equal(isTelevision("sensor.tv_power"), true);
  assert.equal(isTelevision("sensor.plug_power", "Television"), true);
  assert.equal(isTelevision("sensor.sonoff_s60zbtpg_power", "Kettle"), false);
});

test("TV power is represented as a session with duration", () => {
  const sessions = televisionSessions([
    sample(0, "2026-08-20T18:00:00Z"), sample(64, "2026-08-20T18:05:00Z"),
    sample(71, "2026-08-20T18:40:00Z"), sample(0, "2026-08-20T19:35:00Z"),
  ], at("2026-08-20T20:00:00Z"), "Europe/London");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].durationMinutes, 90);
  assert.equal(sessions[0].peakPower, 71);
});

test("short 3am TV spikes are ignored", () => {
  const sessions = televisionSessions([
    sample(45, "2026-08-21T02:00:00Z"), sample(0, "2026-08-21T02:08:00Z"),
  ], at("2026-08-21T03:00:00Z"), "Europe/London");
  assert.deepEqual(sessions, []);
});

test("TV minutes are clipped to the analysis period", () => {
  const features = televisionFeatures([
    sample(60, "2026-08-20T17:30:00Z"), sample(0, "2026-08-20T19:30:00Z"),
  ], at("2026-08-20T18:00:00Z"), at("2026-08-20T19:00:00Z"), "Europe/London");
  assert.equal(features.tvMinutes, 60);
  assert.equal(features.tvSessions, 0);
});
