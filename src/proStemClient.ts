export type StemPackageResult = {
  jobId: string;
  model: string;
  outputDirectory: string;
  stems: Array<{
    stem: "drums" | "bass" | "other" | "vocals";
    path: string;
    exists: boolean;
    sizeBytes: number;
  }>;
  isReady: boolean;
  warnings: string[];
  stemEngine: "demucs-sidecar";
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
    // Ignore JSON parse errors and keep status text.
  }

  throw new Error(`Sidecar stem separation failed (${response.status}): ${detail}`);
}

export async function separateWithProSidecar(file: File): Promise<StemPackageResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const formData = new FormData();
  formData.append("file", file, file.name);

  const response = await fetch(`${sidecarUrl}/separate`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    await throwDetailedError(response);
  }

  return (await response.json()) as StemPackageResult;
}
