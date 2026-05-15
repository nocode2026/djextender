const SIDECAR =
  (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ??
  "http://127.0.0.1:8765";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be a number`);
  }
  return value;
}

function asBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be a boolean`);
  }
  return value;
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be string[]`);
  }
  return value;
}

function parseQAGate(payload: unknown, index: number): QAGate {
  if (!isRecord(payload)) {
    throw new Error(`Invalid sidecar payload: gates[${index}] must be an object`);
  }
  return {
    id: asString(payload.id, `gates[${index}].id`),
    label: asString(payload.label, `gates[${index}].label`),
    passed: asBoolean(payload.passed, `gates[${index}].passed`),
    value: asNumber(payload.value, `gates[${index}].value`),
    threshold: asNumber(payload.threshold, `gates[${index}].threshold`),
    unit: asString(payload.unit, `gates[${index}].unit`),
  };
}

function parseQARenderResult(payload: unknown): QARenderResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: QA result must be an object");
  }
  const gatesRaw = payload.gates;
  if (!Array.isArray(gatesRaw)) {
    throw new Error("Invalid sidecar payload: gates must be an array");
  }

  return {
    wavPath: asString(payload.wavPath, "wavPath"),
    durationSeconds: asNumber(payload.durationSeconds, "durationSeconds"),
    sampleRate: asNumber(payload.sampleRate, "sampleRate"),
    expectedDurationSeconds: asNumber(payload.expectedDurationSeconds, "expectedDurationSeconds"),
    durationDeltaSeconds: asNumber(payload.durationDeltaSeconds, "durationDeltaSeconds"),
    barCount: asNumber(payload.barCount, "barCount"),
    expectedBarCount: asNumber(payload.expectedBarCount, "expectedBarCount"),
    barCountError: asNumber(payload.barCountError, "barCountError"),
    bpmMeasured: asNumber(payload.bpmMeasured, "bpmMeasured"),
    bpmExpected: asNumber(payload.bpmExpected, "bpmExpected"),
    bpmDriftPercent: asNumber(payload.bpmDriftPercent, "bpmDriftPercent"),
    rmsDb: asNumber(payload.rmsDb, "rmsDb"),
    peakDb: asNumber(payload.peakDb, "peakDb"),
    hasClipping: asBoolean(payload.hasClipping, "hasClipping"),
    junctionGlitchScore: asNumber(payload.junctionGlitchScore, "junctionGlitchScore"),
    score: asNumber(payload.score, "score"),
    passed: asBoolean(payload.passed, "passed"),
    gates: gatesRaw.map((gate, index) => parseQAGate(gate, index)),
    warnings: asStringArray(payload.warnings, "warnings"),
  };
}

export interface QAGate {
  id: string;
  label: string;
  passed: boolean;
  value: number;
  threshold: number;
  unit: string;
}

export interface QARenderResult {
  wavPath: string;
  durationSeconds: number;
  sampleRate: number;
  expectedDurationSeconds: number;
  durationDeltaSeconds: number;
  barCount: number;
  expectedBarCount: number;
  barCountError: number;
  bpmMeasured: number;
  bpmExpected: number;
  bpmDriftPercent: number;
  rmsDb: number;
  peakDb: number;
  hasClipping: boolean;
  junctionGlitchScore: number;
  score: number;
  passed: boolean;
  gates: QAGate[];
  warnings: string[];
}

export async function qaRender(params: {
  wavPath: string;
  expectedBpm: number;
  expectedBars: number;
  introBars: number;
  outroBars: number;
}): Promise<QARenderResult> {
  const fd = new FormData();
  fd.append("wav_path", params.wavPath);
  fd.append("expected_bpm", String(params.expectedBpm));
  fd.append("expected_bars", String(params.expectedBars));
  fd.append("intro_bars", String(params.introBars));
  fd.append("outro_bars", String(params.outroBars));

  const res = await fetch(`${SIDECAR}/qa_render`, { method: "POST", body: fd });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`QA render failed (${res.status}): ${text}`);
  }
  return parseQARenderResult(await res.json());
}
