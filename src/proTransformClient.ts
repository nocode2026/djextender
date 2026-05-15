export type TransformPreviewResult = {
  jobId: string;
  outputDirectory: string;
  previewPath: string;
  durationSeconds: number;
  sampleRate: number;
  warnings: string[];
  transformEngine: "rubberband-cli-v1";
};

export type TransformAudioResult = {
  jobId: string;
  outputDirectory: string;
  wavPath: string;
  mp3Path: string;
  aiffPath: string;
  durationSeconds: number;
  sampleRate: number;
  warnings: string[];
  transformEngine: "rubberband-cli-v1";
};

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

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be string[]`);
  }
  return value;
}

function parseTransformPreviewResult(payload: unknown): TransformPreviewResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: transform preview result must be an object");
  }
  const transformEngine = asString(payload.transformEngine, "transformEngine");
  if (transformEngine !== "rubberband-cli-v1") {
    throw new Error("Invalid sidecar payload: transformEngine must be rubberband-cli-v1");
  }
  return {
    jobId: asString(payload.jobId, "jobId"),
    outputDirectory: asString(payload.outputDirectory, "outputDirectory"),
    previewPath: asString(payload.previewPath, "previewPath"),
    durationSeconds: asNumber(payload.durationSeconds, "durationSeconds"),
    sampleRate: asNumber(payload.sampleRate, "sampleRate"),
    warnings: asStringArray(payload.warnings, "warnings"),
    transformEngine: "rubberband-cli-v1",
  };
}

function parseTransformAudioResult(payload: unknown): TransformAudioResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: transform audio result must be an object");
  }
  const transformEngine = asString(payload.transformEngine, "transformEngine");
  if (transformEngine !== "rubberband-cli-v1") {
    throw new Error("Invalid sidecar payload: transformEngine must be rubberband-cli-v1");
  }
  return {
    jobId: asString(payload.jobId, "jobId"),
    outputDirectory: asString(payload.outputDirectory, "outputDirectory"),
    wavPath: asString(payload.wavPath, "wavPath"),
    mp3Path: asString(payload.mp3Path, "mp3Path"),
    aiffPath: asString(payload.aiffPath, "aiffPath"),
    durationSeconds: asNumber(payload.durationSeconds, "durationSeconds"),
    sampleRate: asNumber(payload.sampleRate, "sampleRate"),
    warnings: asStringArray(payload.warnings, "warnings"),
    transformEngine: "rubberband-cli-v1",
  };
}

async function throwDetailedError(response: Response): Promise<never> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) {
      detail = body.detail;
    }
  } catch {
    // Ignore JSON parse errors and fallback to status text.
  }

  throw new Error(`Sidecar transform failed (${response.status}): ${detail}`);
}

export async function transformPreviewWithProSidecar(args: {
  sourceFile: File;
  sourceBpm: number;
  targetBpm: number;
  pitchSemitones: number;
  previewSeconds?: number;
}): Promise<TransformPreviewResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const formData = new FormData();
  formData.append("file", args.sourceFile, args.sourceFile.name);
  formData.append("source_bpm", String(args.sourceBpm));
  formData.append("target_bpm", String(args.targetBpm));
  formData.append("pitch_semitones", String(args.pitchSemitones));
  formData.append("preview_seconds", String(args.previewSeconds ?? 30));

  const response = await fetch(`${sidecarUrl}/transform_preview`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    await throwDetailedError(response);
  }

  return parseTransformPreviewResult(await response.json());
}

export async function transformAudioWithProSidecar(args: {
  sourceFile: File;
  sourceBpm: number;
  targetBpm: number;
  pitchSemitones: number;
}): Promise<TransformAudioResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const formData = new FormData();
  formData.append("file", args.sourceFile, args.sourceFile.name);
  formData.append("source_bpm", String(args.sourceBpm));
  formData.append("target_bpm", String(args.targetBpm));
  formData.append("pitch_semitones", String(args.pitchSemitones));

  const response = await fetch(`${sidecarUrl}/transform_audio`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    await throwDetailedError(response);
  }

  return parseTransformAudioResult(await response.json());
}
