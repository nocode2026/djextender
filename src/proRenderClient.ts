export type RenderExtendedResult = {
  jobId: string;
  outputDirectory: string;
  takes: Array<{
    takeIndex: number;
    label: string;
    outputPath: string;
    wavPath: string;
    mp3Path: string;
    aiffPath: string;
    durationSeconds: number;
    sampleRate: number;
  }>;
  warnings: string[];
  renderEngine: "deterministic-sidecar-v1";
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

  throw new Error(`Sidecar render failed (${response.status}): ${detail}`);
}

export async function renderExtendedWithProSidecar(args: {
  sourceFile: File;
  request: Record<string, unknown>;
  plan: unknown;
  stemPackage: unknown;
}): Promise<RenderExtendedResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const metadata = {
    request: args.request,
    plan: args.plan,
    stemPackage: args.stemPackage,
  };

  const formData = new FormData();
  formData.append("file", args.sourceFile, args.sourceFile.name);
  formData.append("metadata", JSON.stringify(metadata));

  const response = await fetch(`${sidecarUrl}/render_extended`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    await throwDetailedError(response);
  }

  return (await response.json()) as RenderExtendedResult;
}
