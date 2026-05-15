import type { AudioAnalysisResult } from "./audioAnalyzer";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";

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
  if (typeof value !== "number" || !Number.isFinite(value)) {
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

function asNumberArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || Number.isNaN(item))) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be number[]`);
  }
  return value;
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be string[]`);
  }
  return value;
}

function asObjectArray(value: unknown, fieldName: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be object[]`);
  }
  return value;
}

function parseStructureSections(value: unknown): void {
  const sections = asObjectArray(value, "structureSections");
  sections.forEach((section, index) => {
    asNumber(section.startSeconds, `structureSections[${index}].startSeconds`);
    asNumber(section.endSeconds, `structureSections[${index}].endSeconds`);
    asNumber(section.bars, `structureSections[${index}].bars`);
    const energy = asString(section.energy, `structureSections[${index}].energy`);
    if (!["low", "mid", "high"].includes(energy)) {
      throw new Error(`Invalid sidecar payload: structureSections[${index}].energy has unsupported value`);
    }
  });
}

function parseTimelineMarkers(value: unknown): void {
  const markers = asObjectArray(value, "timelineMarkers");
  markers.forEach((marker, index) => {
    const type = asString(marker.type, `timelineMarkers[${index}].type`);
    if (!["beat", "downbeat", "phrase_start"].includes(type)) {
      throw new Error(`Invalid sidecar payload: timelineMarkers[${index}].type has unsupported value`);
    }
    asNumber(marker.seconds, `timelineMarkers[${index}].seconds`);
    asNumber(marker.beatIndex, `timelineMarkers[${index}].beatIndex`);
    asNumber(marker.barIndex, `timelineMarkers[${index}].barIndex`);
    asNumber(marker.beatInBar, `timelineMarkers[${index}].beatInBar`);
    asNumber(marker.phraseIndex, `timelineMarkers[${index}].phraseIndex`);
  });
}

function parseAnalysisGates(value: unknown): void {
  const gates = asObjectArray(value, "gates");
  gates.forEach((gate, index) => {
    asString(gate.id, `gates[${index}].id`);
    asString(gate.label, `gates[${index}].label`);
    asNumber(gate.value, `gates[${index}].value`);
    asNumber(gate.threshold, `gates[${index}].threshold`);
    asBoolean(gate.passed, `gates[${index}].passed`);
  });
}

function assertAnalysisPayload(payload: unknown): AudioAnalysisResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: analysis response must be an object");
  }

  // Validate critical fields consumed across the UI flow.
  asNumber(payload.bpm, "bpm");
  asNumber(payload.bpmSecondary, "bpmSecondary");
  asNumber(payload.bpmConfidence, "bpmConfidence");
  asString(payload.musicalKey, "musicalKey");
  asString(payload.camelotKey, "camelotKey");
  asNumber(payload.keyConfidence, "keyConfidence");
  const phraseBars = asNumber(payload.phraseBars, "phraseBars");
  if (![4, 8, 16].includes(phraseBars)) {
    throw new Error("Invalid sidecar payload: phraseBars must be one of 4, 8, 16");
  }
  asNumber(payload.phraseConfidence, "phraseConfidence");
  asNumber(payload.beatIntervalSeconds, "beatIntervalSeconds");
  asNumber(payload.beatCount, "beatCount");
  asNumber(payload.durationSeconds, "durationSeconds");
  asNumber(payload.sampleRate, "sampleRate");
  asNumber(payload.downbeatOffsetSeconds, "downbeatOffsetSeconds");
  asNumber(payload.downbeatConfidence, "downbeatConfidence");
  asNumber(payload.overallScore, "overallScore");
  asBoolean(payload.isProductionReady, "isProductionReady");
  parseStructureSections(payload.structureSections);
  parseTimelineMarkers(payload.timelineMarkers);
  parseAnalysisGates(payload.gates);
  asNumberArray(payload.beatTimestampsSeconds, "beatTimestampsSeconds");
  asNumberArray(payload.downbeatTimestampsSeconds, "downbeatTimestampsSeconds");
  asNumberArray(payload.phraseBoundarySeconds, "phraseBoundarySeconds");
  asStringArray(payload.warnings, "warnings");

  const analyzerEngine = asString(payload.analyzerEngine, "analyzerEngine");
  if (analyzerEngine !== "pro-sidecar") {
    throw new Error("Invalid sidecar payload: analyzerEngine must be pro-sidecar");
  }

  return payload as AudioAnalysisResult;
}

async function throwDetailedError(response: Response): Promise<never> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) {
      detail = body.detail;
    }
  } catch {
    // Ignore JSON parse failures and fallback to status text.
  }

  throw new Error(`Sidecar analysis failed (${response.status}): ${detail}`);
}

export async function analyzeWithProSidecar(
  file: File,
  options?: { analysisEngine?: "librosa" | "essentia" | "hybrid" },
): Promise<AudioAnalysisResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const formData = new FormData();
  formData.append("file", file, file.name);
  formData.append("analysis_engine", options?.analysisEngine ?? "librosa");

  const response = await fetch(`${sidecarUrl}/analyze`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    await throwDetailedError(response);
  }

  return assertAnalysisPayload(await response.json());
}
