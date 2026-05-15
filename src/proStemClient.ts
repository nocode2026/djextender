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

function asNullableNumber(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }
  return asNumber(value, fieldName);
}

function asStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid sidecar payload: ${fieldName} must be string[]`);
  }
  return value;
}

function parseStartedPayload(payload: unknown): { jobId: string } {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: started response must be an object");
  }
  const jobId = asString(payload.jobId, "jobId").trim();
  const status = asString(payload.status, "status");
  if (!jobId) {
    throw new Error("Invalid sidecar payload: jobId cannot be empty");
  }
  if (status !== "started") {
    throw new Error("Invalid sidecar payload: status must be started");
  }
  return { jobId };
}

async function fetchStemResultWithRetry(
  sidecarUrl: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<StemPackageResult> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 300;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const resultResp = await fetch(`${sidecarUrl}/stem_result/${jobId}`, { signal });

    if (resultResp.status === 202) {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RETRY_DELAY_MS);
        });
        continue;
      }
      throw new Error(`Stem result still pending after ${MAX_ATTEMPTS} attempts`);
    }

    if (resultResp.ok) {
      return parseStemResult(await resultResp.json());
    }

    await throwDetailedError(resultResp);
  }

  throw new Error("Unexpected stem result fetch state");
}

function parseStemProgress(payload: unknown): StemProgress {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: progress response must be an object");
  }
  return {
    step: asNumber(payload.step, "step"),
    total: asNumber(payload.total, "total"),
    label: asString(payload.label, "label"),
    done: asBoolean(payload.done, "done"),
    error: asString(payload.error, "error"),
    last_heartbeat: asNullableNumber(payload.last_heartbeat, "last_heartbeat"),
    started_at: asNullableNumber(payload.started_at, "started_at"),
    elapsed_seconds: asNumber(payload.elapsed_seconds, "elapsed_seconds"),
    eta_seconds: asNullableNumber(payload.eta_seconds, "eta_seconds"),
  };
}

function parseStemResult(payload: unknown): StemPackageResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: stem result must be an object");
  }
  const stemsRaw = payload.stems;
  if (!Array.isArray(stemsRaw)) {
    throw new Error("Invalid sidecar payload: stems must be an array");
  }

  const stems = stemsRaw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid sidecar payload: stems[${index}] must be an object`);
    }
    const stem = asString(item.stem, `stems[${index}].stem`);
    if (!["drums", "bass", "other", "vocals"].includes(stem)) {
      throw new Error(`Invalid sidecar payload: stems[${index}].stem has unsupported value`);
    }

    return {
      stem: stem as "drums" | "bass" | "other" | "vocals",
      path: asString(item.path, `stems[${index}].path`),
      exists: asBoolean(item.exists, `stems[${index}].exists`),
      sizeBytes: asNumber(item.sizeBytes, `stems[${index}].sizeBytes`),
    };
  });

  const stemEngine = asString(payload.stemEngine, "stemEngine");
  if (stemEngine !== "demucs-sidecar") {
    throw new Error("Invalid sidecar payload: stemEngine must be demucs-sidecar");
  }

  return {
    jobId: asString(payload.jobId, "jobId"),
    model: asString(payload.model, "model"),
    outputDirectory: asString(payload.outputDirectory, "outputDirectory"),
    stems,
    isReady: asBoolean(payload.isReady, "isReady"),
    warnings: asStringArray(payload.warnings, "warnings"),
    stemEngine: "demucs-sidecar",
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

  const started = parseStartedPayload(await startResp.json());
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
        .then(async (r) => {
          if (!r.ok) {
            let detail = r.statusText;
            try {
              const body = (await r.json()) as { detail?: string };
              if (body.detail) {
                detail = body.detail;
              }
            } catch {
              // Ignore parse errors and use status text.
            }
            throw new Error(`Progress polling failed (${r.status}): ${detail}`);
          }
          return parseStemProgress(await r.json());
        })
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
        .catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("Progress polling failed")) {
            clearInterval(timer);
            reject(error);
            return;
          }

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
  return fetchStemResultWithRetry(sidecarUrl, jobId, options?.signal);
}
