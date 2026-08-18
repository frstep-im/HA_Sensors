import assert from "node:assert/strict";
import test from "node:test";
import { analyse, median, robustMetric } from "./normality";
import { Features } from "./types";

const sample = (motionEvents: number): Features => ({
  motionEvents, activeMotionSensors: motionEvents ? 1 : 0, currentMean: 1.2, currentMax: 2,
  powerMean: 0, powerMax: 0, doorOpenings: 0, soterInteractions: 0,
  recognizedResidents: 0, arrivals: 0, departures: 0,
});

test("median handles odd and even arrays", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});
test("robust metric resists one historical outlier", () => assert.ok(robustMetric(3, [2, 2, 3, 2, 40, 2, 3]).z < 2));
test("learning mode blocks premature scores", () => assert.equal(analyse(sample(1), [sample(1)], 7, 30).status, "learning"));
test("large departure is unusual", () => {
  const result = analyse(sample(50), Array.from({ length: 30 }, (_, i) => sample(i % 3 + 5)), 24, 30);
  assert.equal(result.status, "unusual");
  assert.ok((result.normalityIndex ?? 100) < 30);
});

