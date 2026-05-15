import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALLOWED_ENGINES,
  isFiniteNumber,
  parseArgs,
  validateAnalysisPayload,
  validateSmokeArgs,
} from "./smoke-sidecar.mjs";

describe("smoke-sidecar helpers", () => {
  it("parses valid CLI args", () => {
    const args = parseArgs(["--base-url", "http://localhost:9999", "--file", "a.wav", "--engine", "essentia"]);
    expect(args.baseUrl).toBe("http://localhost:9999");
    expect(args.file).toBe("a.wav");
    expect(args.engine).toBe("essentia");
  });

  it("fails on missing option value", () => {
    expect(() => parseArgs(["--engine"]))
      .toThrow("Missing value for --engine");
  });

  it("fails on unknown option", () => {
    expect(() => parseArgs(["--nope"]))
      .toThrow("Unknown option");
  });

  it("validates supported engine values", async () => {
    await expect(
      validateSmokeArgs({ baseUrl: "http://127.0.0.1:8765", file: "", engine: "invalid", help: false }),
    ).rejects.toThrow(`--engine must be one of: ${ALLOWED_ENGINES.join(", ")}`);
  });

  it("validates existing file when file arg is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "djextender-smoke-"));
    const tempFile = path.join(tempDir, "sample.wav");
    await fs.writeFile(tempFile, Buffer.from([1, 2, 3]));

    await expect(
      validateSmokeArgs({ baseUrl: "http://127.0.0.1:8765", file: tempFile, engine: "hybrid", help: false }),
    ).resolves.toBeUndefined();
  });

  it("rejects non-existing file path", async () => {
    await expect(
      validateSmokeArgs({ baseUrl: "http://127.0.0.1:8765", file: "C:/definitely-not-existing.wav", engine: "hybrid", help: false }),
    ).rejects.toThrow("--file does not exist");
  });

  it("checks finite number utility", () => {
    expect(isFiniteNumber(1.23)).toBe(true);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
  });

  it("accepts minimal valid analysis payload", () => {
    const payload = {
      bpm: 124,
      musicalKey: "A minor",
      phraseBars: 8,
      downbeatOffsetSeconds: 0,
      timelineMarkers: [],
      gates: [],
    };

    expect(() => validateAnalysisPayload(payload)).not.toThrow();
  });

  it("rejects invalid analysis payload", () => {
    const payload = {
      bpm: Number.POSITIVE_INFINITY,
      musicalKey: "A minor",
      phraseBars: 8,
      downbeatOffsetSeconds: 0,
      timelineMarkers: [],
      gates: [],
    };

    expect(() => validateAnalysisPayload(payload)).toThrow("finite bpm");
  });
});
