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

function assertAnalysisPayload(payload: unknown): AudioAnalysisResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: analysis response must be an object");
  }

  // Validate critical fields consumed across the UI flow.
  asNumber(payload.bpm, "bpm");
  asString(payload.musicalKey, "musicalKey");
  asNumber(payload.phraseBars, "phraseBars");
  asNumber(payload.durationSeconds, "durationSeconds");
  asNumber(payload.downbeatOffsetSeconds, "downbeatOffsetSeconds");
  asNumber(payload.downbeatConfidence, "downbeatConfidence");
  asNumber(payload.overallScore, "overallScore");
  asBoolean(payload.isProductionReady, "isProductionReady");
  asObjectArray(payload.timelineMarkers, "timelineMarkers");
  asObjectArray(payload.gates, "gates");
  asNumberArray(payload.beatTimestampsSeconds, "beatTimestampsSeconds");
  asNumberArray(payload.downbeatTimestampsSeconds, "downbeatTimestampsSeconds");
  asNumberArray(payload.phraseBoundarySeconds, "phraseBoundarySeconds");
  asStringArray(payload.warnings, "warnings");

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
