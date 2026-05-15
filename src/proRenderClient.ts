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

async function fetchRenderResultWithRetry(
  sidecarUrl: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<RenderExtendedResult> {
  const MAX_ATTEMPTS = 5;
  const RETRY_DELAY_MS = 300;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const resultResp = await fetch(`${sidecarUrl}/render_result/${jobId}`, { signal });

    if (resultResp.ok) {
      return parseRenderResult(await resultResp.json());
    }

    if (resultResp.status === 202 && attempt < MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RETRY_DELAY_MS);
      });
      continue;
    }

    await throwDetailedError(resultResp);
  }

  throw new Error("Unexpected render result fetch state");
}

function parseRenderProgress(payload: unknown): RenderProgress {
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

function parseRenderResult(payload: unknown): RenderExtendedResult {
  if (!isRecord(payload)) {
    throw new Error("Invalid sidecar payload: render result must be an object");
  }
  const takesRaw = payload.takes;
  if (!Array.isArray(takesRaw)) {
    throw new Error("Invalid sidecar payload: takes must be an array");
  }

  const takes = takesRaw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid sidecar payload: takes[${index}] must be an object`);
    }
    return {
      takeIndex: asNumber(item.takeIndex, `takes[${index}].takeIndex`),
      label: asString(item.label, `takes[${index}].label`),
      outputPath: asString(item.outputPath, `takes[${index}].outputPath`),
      wavPath: asString(item.wavPath, `takes[${index}].wavPath`),
      mp3Path: asString(item.mp3Path, `takes[${index}].mp3Path`),
      aiffPath: asString(item.aiffPath, `takes[${index}].aiffPath`),
      durationSeconds: asNumber(item.durationSeconds, `takes[${index}].durationSeconds`),
      sampleRate: asNumber(item.sampleRate, `takes[${index}].sampleRate`),
    };
  });

  const renderEngine = asString(payload.renderEngine, "renderEngine");
  if (renderEngine !== "deterministic-sidecar-v1") {
    throw new Error("Invalid sidecar payload: renderEngine must be deterministic-sidecar-v1");
  }

  return {
    jobId: asString(payload.jobId, "jobId"),
    outputDirectory: asString(payload.outputDirectory, "outputDirectory"),
    takes,
    warnings: asStringArray(payload.warnings, "warnings"),
    renderEngine: "deterministic-sidecar-v1",
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

  const started = parseStartedPayload(await startResp.json());
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
          return parseRenderProgress(await r.json());
        })
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
        .catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("Progress polling failed")) {
            clearInterval(timer);
            reject(error);
            return;
          }

          // Network error — check silence timeout
          if (Date.now() - lastSuccessfulPoll > MAX_SILENCE_MS) {
            clearInterval(timer);
            reject(new Error("Sidecar nie odpowiada — sprawdź czy sidecar działa (brak odpowiedzi >20s)"));
          }
        });
    }, POLL_INTERVAL_MS);
  });

  // Fetch final result
  return fetchRenderResultWithRetry(sidecarUrl, jobId, args.signal);
}
