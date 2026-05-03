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

export type RenderProgress = {
  step: number;
  total: number;
  label: string;
  done: boolean;
  error: string;
  last_heartbeat: number | null;
  started_at: number | null;
  elapsed_seconds: number;
  eta_seconds: number | null;
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
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
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

  // POST → sidecar accepts job and immediately returns {jobId, status: "started"}
  const startResp = await fetch(`${sidecarUrl}/render_extended`, {
    method: "POST",
    body: formData,
    signal: args.signal,
  });

  if (!startResp.ok) {
    await throwDetailedError(startResp);
  }

  const started = (await startResp.json()) as { jobId: string; status: string };
  const { jobId } = started;

  // Poll progress until done or error
  const POLL_INTERVAL_MS = 2500;
  const MAX_SILENCE_MS = 20_000; // if sidecar doesn't respond for 20s → error
  let lastSuccessfulPoll = Date.now();

  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (args.signal?.aborted) {
        clearInterval(timer);
        reject(new Error("Render cancelled"));
        return;
      }

      fetch(`${sidecarUrl}/progress/${jobId}`, { signal: args.signal })
        .then((r) => r.json())
        .then((data: RenderProgress) => {
          lastSuccessfulPoll = Date.now();
          args.onProgress?.(data);

          if (data.error) {
            clearInterval(timer);
            reject(new Error(`Render error: ${data.error}`));
            return;
          }
          if (data.done) {
            clearInterval(timer);
            resolve();
          }
        })
        .catch(() => {
          // Network error — check silence timeout
          if (Date.now() - lastSuccessfulPoll > MAX_SILENCE_MS) {
            clearInterval(timer);
            reject(new Error("Sidecar nie odpowiada — sprawdź czy sidecar działa (brak odpowiedzi >20s)"));
          }
        });
    }, POLL_INTERVAL_MS);
  });

  // Fetch final result
  const resultResp = await fetch(`${sidecarUrl}/render_result/${jobId}`, {
    signal: args.signal,
  });
  if (!resultResp.ok) {
    await throwDetailedError(resultResp);
  }
  return (await resultResp.json()) as RenderExtendedResult;
}
