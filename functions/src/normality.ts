import { Analysis, Features, Metric } from "./types";

export const FEATURE_KEYS: (keyof Features)[] = [
  "motionEvents", "activeMotionSensors", "currentMean", "currentMax", "powerMean", "powerMax",
  "doorOpenings", "soterInteractions", "recognizedResidents", "arrivals", "departures",
];
const WEIGHTS: Record<keyof Features, number> = {
  motionEvents: 1.4, activeMotionSensors: .8, currentMean: 1, currentMax: .6,
  powerMean: 1, powerMax: .6, doorOpenings: .8, soterInteractions: .6,
  recognizedResidents: .5, arrivals: .5, departures: .5,
};

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function robustMetric(value: number, samples: number[]): Metric {
  const center = median(samples);
  const mad = median(samples.map((sample) => Math.abs(sample - center)));
  const scale = Math.max(1.4826 * mad, .5, Math.sqrt(Math.abs(center) + 1) * .5);
  return { median: center, mad, z: Math.min(6, Math.abs(value - center) / scale) };
}

export function analyse(current: Features, baseline: Features[], minimum: number, threshold: number): Analysis {
  if (baseline.length < minimum) return {
    normalityIndex: null, anomalyScore: null, status: "learning", baselineSamples: baseline.length,
    reasons: [`Learning the household routine (${baseline.length}/${minimum} comparable windows).`], metrics: {},
  };
  const metrics: Record<string, Metric> = {};
  let weighted = 0, total = 0;
  for (const key of FEATURE_KEYS) {
    const metric = robustMetric(current[key], baseline.map((sample) => sample[key]));
    metrics[key] = metric;
    weighted += WEIGHTS[key] * metric.z * metric.z;
    total += WEIGHTS[key];
  }
  const distance = Math.sqrt(weighted / total);
  const normalityIndex = Math.round(100 * Math.exp(-.5 * distance * distance));
  const reasons = FEATURE_KEYS.map((key) => ({ key, value: current[key], ...metrics[key] }))
    .filter((item) => item.z >= 2).sort((a, b) => b.z - a.z).slice(0, 3)
    .map((item) => `${human(item.key)} was ${format(item.value)} (usual ${format(item.median)}).`);
  return {
    normalityIndex, anomalyScore: 100 - normalityIndex,
    status: normalityIndex < threshold ? "unusual" : "normal", baselineSamples: baseline.length,
    reasons: reasons.length ? reasons : ["Activity is within the learned range for this time."], metrics,
  };
}

const human = (key: string) => key.replace(/([A-Z])/g, " $1").toLowerCase();
const format = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

