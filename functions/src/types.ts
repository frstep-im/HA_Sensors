export type SensorKind = "motion" | "current" | "power";
export type Status = "learning" | "normal" | "unusual" | "alert";

export interface EntityConfig { entityId: string; kind: SensorKind; label?: string }

export interface Config {
  enabled: boolean;
  householdId: string;
  soterProjectId: string;
  soterDeviceId: string;
  timezone: string;
  entities: EntityConfig[];
  windowMinutes: number;
  baselineDays: number;
  minimumBaselineWindows: number;
  alertThreshold: number;
  consecutiveWindows: number;
  webhookEnabled: boolean;
  lastCollectedAt?: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
  updatedBy?: string;
}

export interface CollectorHealth {
  id: string;
  version?: string;
  queueDepth?: number;
  sentAt: FirebaseFirestore.Timestamp;
  lastSeenAt: FirebaseFirestore.Timestamp;
  lastEventAt?: FirebaseFirestore.Timestamp;
  lastBackfillAt?: FirebaseFirestore.Timestamp;
}

export interface SensorEvent {
  source: "home_assistant";
  entityId: string;
  kind: SensorKind;
  state: string;
  numericValue: number | null;
  observedAt: FirebaseFirestore.Timestamp;
  unit?: string | null;
  friendlyName?: string | null;
}

export type SoterEventType = "door_opened" | "door_closed" | "door_left_open" | "interaction" | "resident_recognized" | "arrival" | "departure";
export interface SoterEvent {
  source: "soter";
  type: SoterEventType;
  observedAt: FirebaseFirestore.Timestamp;
  deviceId: string;
  sourceId: string;
}

export interface Features {
  motionEvents: number;
  activeMotionSensors: number;
  currentMean: number;
  currentMax: number;
  powerMean: number;
  powerMax: number;
  doorOpenings: number;
  soterInteractions: number;
  recognizedResidents: number;
  arrivals: number;
  departures: number;
}

export interface Metric { median: number; mad: number; z: number }
export interface Analysis {
  normalityIndex: number | null;
  anomalyScore: number | null;
  status: Status;
  baselineSamples: number;
  reasons: string[];
  metrics: Record<string, Metric>;
}
