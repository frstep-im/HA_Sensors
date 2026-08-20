import assert from "node:assert/strict";
import test from "node:test";
import { checkpointLabel, checkpointStart, checkpointsBetween, latestCheckpoint } from "./checkpoints";

test("latest checkpoint follows Home Assistant local time", () => {
  const checkpoint = latestCheckpoint(new Date("2026-08-20T10:15:00Z"), "Europe/London");
  assert.equal(checkpoint.toISOString(), "2026-08-20T08:00:00.000Z");
  assert.equal(checkpointLabel(checkpoint, "Europe/London"), "09:00");
});

test("checkpoint window is the previous six local hours across daylight saving", () => {
  const end = new Date("2026-03-29T02:00:00Z"); // 03:00 BST, after the spring transition.
  assert.equal(checkpointLabel(end, "Europe/London"), "03:00");
  assert.equal(checkpointStart(end, "Europe/London").toISOString(), "2026-03-28T21:00:00.000Z"); // 21:00 GMT: five elapsed hours.
});

test("only 03:00, 09:00 and 21:00 local are returned", () => {
  const checkpoints = checkpointsBetween(new Date("2026-08-19T00:00:00Z"), new Date("2026-08-20T23:00:00Z"), "Europe/London");
  assert.deepEqual(checkpoints.map((date) => checkpointLabel(date, "Europe/London")), ["03:00", "09:00", "21:00", "03:00", "09:00", "21:00"]);
});
