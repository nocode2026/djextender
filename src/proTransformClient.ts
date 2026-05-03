export type TransformPreviewResult = {
  jobId: string;
  outputDirectory: string;
  previewPath: string;
  durationSeconds: number;
  sampleRate: number;
  warnings: string[];
  transformEngine: "rubberband-ffmpeg-v1";
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
  transformEngine: "rubberband-ffmpeg-v1";
};

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";

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

  return (await response.json()) as TransformPreviewResult;
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

  return (await response.json()) as TransformAudioResult;
}
