import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeWithProSidecar } from "./proAnalysisClient";
import { qaRender } from "./proQAClient";
import { renderExtendedWithProSidecar } from "./proRenderClient";
import { separateWithProSidecar } from "./proStemClient";
import { transformAudioWithProSidecar, transformPreviewWithProSidecar } from "./proTransformClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFile(name = "track.wav"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "audio/wav" });
}

const validAnalysisPayload = {
  bpm: 124,
  bpmSecondary: 62,
  bpmConfidence: 0.9,
  musicalKey: "A minor",
  camelotKey: "8A",
  keyConfidence: 0.8,
  phraseBars: 8,
  phraseConfidence: 0.75,
  beatIntervalSeconds: 0.48,
  beatCount: 320,
  downbeatOffsetSeconds: 0,
  downbeatConfidence: 0.91,
  structureSections: [{ startSeconds: 0, endSeconds: 15.2, bars: 8, energy: "low" }],
  beatTimestampsSeconds: [0, 0.48, 0.96],
  downbeatTimestampsSeconds: [0, 1.92],
  phraseBoundarySeconds: [0, 15.2],
  timelineMarkers: [
    {
      type: "beat",
      seconds: 0,
      beatIndex: 0,
      barIndex: 0,
      beatInBar: 1,
      phraseIndex: 0,
    },
  ],
  overallScore: 0.88,
  isProductionReady: true,
  gates: [{ id: "bpm", label: "BPM", value: 0.9, threshold: 0.8, passed: true }],
  durationSeconds: 180,
  sampleRate: 44100,
  warnings: [],
  analyzerEngine: "pro-sidecar",
} as const;

const validStemProgress = {
  step: 4,
  total: 4,
  label: "done",
  done: true,
  error: "",
  last_heartbeat: 1,
  started_at: 1,
  elapsed_seconds: 1,
  eta_seconds: 0,
};

const validStemResult = {
  jobId: "stem123",
  model: "htdemucs",
  outputDirectory: "C:/tmp/stems",
  stems: [
    { stem: "drums", path: "C:/tmp/stems/drums.wav", exists: true, sizeBytes: 1200 },
    { stem: "bass", path: "C:/tmp/stems/bass.wav", exists: true, sizeBytes: 1100 },
    { stem: "other", path: "C:/tmp/stems/other.wav", exists: true, sizeBytes: 1300 },
    { stem: "vocals", path: "C:/tmp/stems/vocals.wav", exists: true, sizeBytes: 900 },
  ],
  isReady: true,
  warnings: [],
  stemEngine: "demucs-sidecar",
};

const validRenderProgress = {
  step: 1,
  total: 1,
  label: "done",
  done: true,
  error: "",
  last_heartbeat: 1,
  started_at: 1,
  elapsed_seconds: 1,
  eta_seconds: 0,
};

const validRenderResult = {
  jobId: "render123",
  outputDirectory: "C:/tmp/render",
  takes: [
    {
      takeIndex: 1,
      label: "Take 1",
      outputPath: "C:/tmp/render/take_1.wav",
      wavPath: "C:/tmp/render/take_1.wav",
      mp3Path: "C:/tmp/render/take_1.mp3",
      aiffPath: "C:/tmp/render/take_1.aiff",
      durationSeconds: 200,
      sampleRate: 44100,
    },
  ],
  warnings: [],
  renderEngine: "deterministic-sidecar-v1",
};

const validTransformPreview = {
  jobId: "trprev123",
  outputDirectory: "C:/tmp/transform",
  previewPath: "C:/tmp/transform/preview.wav",
  durationSeconds: 30,
  sampleRate: 44100,
  warnings: [],
  transformEngine: "rubberband-cli-v1",
};

const validTransformAudio = {
  jobId: "traud123",
  outputDirectory: "C:/tmp/transform",
  wavPath: "C:/tmp/transform/full.wav",
  mp3Path: "C:/tmp/transform/full.mp3",
  aiffPath: "C:/tmp/transform/full.aiff",
  durationSeconds: 210,
  sampleRate: 44100,
  warnings: [],
  transformEngine: "rubberband-cli-v1",
};

const validQaResult = {
  wavPath: "C:/tmp/render/take_1.wav",
  durationSeconds: 200,
  sampleRate: 44100,
  expectedDurationSeconds: 200,
  durationDeltaSeconds: 0,
  barCount: 100,
  expectedBarCount: 100,
  barCountError: 0,
  bpmMeasured: 124,
  bpmExpected: 124,
  bpmDriftPercent: 0,
  rmsDb: -10,
  peakDb: -1,
  hasClipping: false,
  junctionGlitchScore: 0.01,
  score: 0.98,
  passed: true,
  gates: [{ id: "rms", label: "RMS", passed: true, value: -10, threshold: -8, unit: "dB" }],
  warnings: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sidecar contract validators", () => {
  it("accepts valid analysis payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(200, validAnalysisPayload));

    const result = await analyzeWithProSidecar(makeFile());

    expect(result.bpm).toBe(124);
    expect(result.analyzerEngine).toBe("pro-sidecar");
  });

  it("rejects invalid analysis phraseBars", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { ...validAnalysisPayload, phraseBars: 3 }),
    );

    await expect(analyzeWithProSidecar(makeFile())).rejects.toThrow("phraseBars");
  });

  it("rejects non-finite analysis numeric value", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { ...validAnalysisPayload, bpm: Number.POSITIVE_INFINITY }),
    );

    await expect(analyzeWithProSidecar(makeFile())).rejects.toThrow("bpm");
  });

  it("rejects stem start payload without started status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { jobId: "stem123", status: "queued" }),
    );

    await expect(separateWithProSidecar(makeFile())).rejects.toThrow("status must be started");
  });

  it("accepts stem result contract", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { jobId: "stem123", status: "started" }))
      .mockResolvedValueOnce(jsonResponse(200, validStemProgress))
      .mockResolvedValueOnce(jsonResponse(200, validStemResult));

    const resultPromise = separateWithProSidecar(makeFile());
    await vi.advanceTimersByTimeAsync(2500);
    const result = await resultPromise;

    expect(result.stemEngine).toBe("demucs-sidecar");
    expect(result.stems).toHaveLength(4);
  });

  it("retries stem final result when endpoint briefly returns pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { jobId: "stem123", status: "started" }))
      .mockResolvedValueOnce(jsonResponse(200, validStemProgress))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }))
      .mockResolvedValueOnce(jsonResponse(200, validStemResult));

    const resultPromise = separateWithProSidecar(makeFile());
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result.jobId).toBe("stem123");
    expect(result.stemEngine).toBe("demucs-sidecar");
  });

  it("fails stem result fetch after max pending attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { jobId: "stem123", status: "started" }))
      .mockResolvedValueOnce(jsonResponse(200, validStemProgress))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "stem123" }));

    const resultPromise = separateWithProSidecar(makeFile());
    const assertion = expect(resultPromise).rejects.toThrow("still pending");

    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(300 * 4);

    await assertion;
  });

  it("retries render final result when endpoint briefly returns pending", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { jobId: "render123", status: "started" }))
      .mockResolvedValueOnce(jsonResponse(200, validRenderProgress))
      .mockResolvedValueOnce(jsonResponse(202, { status: "pending", jobId: "render123" }))
      .mockResolvedValueOnce(jsonResponse(200, validRenderResult));

    const resultPromise = renderExtendedWithProSidecar({
      sourceFile: makeFile(),
      request: {},
      plan: {},
      stemPackage: {},
    });

    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result.renderEngine).toBe("deterministic-sidecar-v1");
    expect(result.takes[0].takeIndex).toBe(1);
  });

  it("accepts valid transform preview and audio payloads", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, validTransformPreview))
      .mockResolvedValueOnce(jsonResponse(200, validTransformAudio));

    const preview = await transformPreviewWithProSidecar({
      sourceFile: makeFile(),
      sourceBpm: 124,
      targetBpm: 126,
      pitchSemitones: 1,
    });

    const full = await transformAudioWithProSidecar({
      sourceFile: makeFile(),
      sourceBpm: 124,
      targetBpm: 126,
      pitchSemitones: 1,
    });

    expect(preview.transformEngine).toBe("rubberband-cli-v1");
    expect(full.transformEngine).toBe("rubberband-cli-v1");
  });

  it("rejects invalid transform engine payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { ...validTransformPreview, transformEngine: "wrong" }),
    );

    await expect(
      transformPreviewWithProSidecar({
        sourceFile: makeFile(),
        sourceBpm: 124,
        targetBpm: 126,
        pitchSemitones: 1,
      }),
    ).rejects.toThrow("transformEngine");
  });

  it("accepts valid QA payload and rejects malformed gate", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, validQaResult));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ...validQaResult,
        gates: [{ id: "rms", label: "RMS", passed: true, value: -10, threshold: -8 }],
      }),
    );

    const ok = await qaRender({
      wavPath: "C:/tmp/render/take_1.wav",
      expectedBpm: 124,
      expectedBars: 100,
      introBars: 32,
      outroBars: 32,
    });
    expect(ok.passed).toBe(true);

    await expect(
      qaRender({
        wavPath: "C:/tmp/render/take_1.wav",
        expectedBpm: 124,
        expectedBars: 100,
        introBars: 32,
        outroBars: 32,
      }),
    ).rejects.toThrow("gates[0].unit");
  });

  it("rejects non-finite QA numeric value", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { ...validQaResult, bpmMeasured: Number.POSITIVE_INFINITY }),
    );

    await expect(
      qaRender({
        wavPath: "C:/tmp/render/take_1.wav",
        expectedBpm: 124,
        expectedBars: 100,
        introBars: 32,
        outroBars: 32,
      }),
    ).rejects.toThrow("bpmMeasured");
  });
});
