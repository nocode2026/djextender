const SIDECAR =
  (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ??
  "http://127.0.0.1:8765";

export interface QAGate {
  id: string;
  label: string;
  passed: boolean;
  value: number;
  threshold: number;
  unit: string;
}

export interface QARenderResult {
  wavPath: string;
  durationSeconds: number;
  sampleRate: number;
  expectedDurationSeconds: number;
  durationDeltaSeconds: number;
  barCount: number;
  expectedBarCount: number;
  barCountError: number;
  bpmMeasured: number;
  bpmExpected: number;
  bpmDriftPercent: number;
  rmsDb: number;
  peakDb: number;
  hasClipping: boolean;
  junctionGlitchScore: number;
  score: number;
  passed: boolean;
  gates: QAGate[];
  warnings: string[];
}

export async function qaRender(params: {
  wavPath: string;
  expectedBpm: number;
  expectedBars: number;
  introBars: number;
  outroBars: number;
}): Promise<QARenderResult> {
  const fd = new FormData();
  fd.append("wav_path", params.wavPath);
  fd.append("expected_bpm", String(params.expectedBpm));
  fd.append("expected_bars", String(params.expectedBars));
  fd.append("intro_bars", String(params.introBars));
  fd.append("outro_bars", String(params.outroBars));

  const res = await fetch(`${SIDECAR}/qa_render`, { method: "POST", body: fd });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`QA render failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<QARenderResult>;
}
