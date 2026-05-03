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

export type StemProgress = {
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
    // Ignore JSON parse errors and keep status text.
  }

  throw new Error(`Sidecar stem separation failed (${response.status}): ${detail}`);
}

export async function separateWithProSidecar(
  file: File,
  options?: {
    onProgress?: (p: StemProgress) => void;
    signal?: AbortSignal;
  },
): Promise<StemPackageResult> {
  const sidecarUrl =
    (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? DEFAULT_SIDECAR_URL;

  const formData = new FormData();
  formData.append("file", file, file.name);

  // POST → sidecar accepts job and immediately returns {jobId, status: "started"}
  const startResp = await fetch(`${sidecarUrl}/separate`, {
    method: "POST",
    body: formData,
    signal: options?.signal,
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
      if (options?.signal?.aborted) {
        clearInterval(timer);
        reject(new Error("Stem separation cancelled"));
        return;
      }

      fetch(`${sidecarUrl}/progress/${jobId}`, { signal: options?.signal })
        .then((r) => r.json())
        .then((data: StemProgress) => {
          lastSuccessfulPoll = Date.now();
          options?.onProgress?.(data);

          if (data.error) {
            clearInterval(timer);
            reject(new Error(`Stem separation error: ${data.error}`));
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
            reject(
              new Error(
                "Sidecar nie odpowiada — sprawdź czy sidecar działa (brak odpowiedzi >20s)",
              ),
            );
          }
        });
    }, POLL_INTERVAL_MS);
  });

  // Fetch final result
  const resultResp = await fetch(`${sidecarUrl}/stem_result/${jobId}`, {
    signal: options?.signal,
  });
  if (!resultResp.ok) {
    await throwDetailedError(resultResp);
  }
  return (await resultResp.json()) as StemPackageResult;
}
