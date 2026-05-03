import type { AudioAnalysisResult } from "./audioAnalyzer";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8765";

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

  const payload = (await response.json()) as AudioAnalysisResult;
  return payload;
}
