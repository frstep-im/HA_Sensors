import assert from "node:assert/strict";
import test from "node:test";
import { dueScheduleSlots, sanitizeEmailPreferences } from "./email";

test("multiple daily email times can become due independently", () => {
  const morning = dueScheduleSlots(["09:00", "21:00"], new Date("2026-08-21T08:04:00Z"), "Europe/London");
  const evening = dueScheduleSlots(["09:00", "21:00"], new Date("2026-08-21T20:06:00Z"), "Europe/London");
  assert.deepEqual(morning.map((slot) => slot.time), ["09:00"]);
  assert.deepEqual(evening.map((slot) => slot.time), ["21:00"]);
  assert.notEqual(morning[0].id, evening[0].id);
});

test("repeated autumn local time produces one delivery slot", () => {
  const slots = dueScheduleSlots(["01:30"], new Date("2026-10-25T01:34:00Z"), "Europe/London", 70);
  assert.deepEqual(slots.map((slot) => slot.id), ["2026-10-25-0130"]);
});

test("email preferences normalise and validate daily times", () => {
  assert.deepEqual(sanitizeEmailPreferences({ thresholdEnabled: true, threshold: 35, scheduleTimes: ["21:00", "09:00", "21:00"] }, "USER@Example.com"), {
    email: "user@example.com", thresholdEnabled: true, threshold: 35, scheduleTimes: ["09:00", "21:00"],
  });
  assert.throws(() => sanitizeEmailPreferences({ scheduleTimes: ["9am"] }, "user@example.com"), /HH:MM/);
});
