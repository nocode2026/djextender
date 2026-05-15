import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_ENGINES = ["hybrid", "librosa", "essentia"];

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:8765",
    file: "",
    engine: "hybrid",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--base-url") {
      args.baseUrl = readOptionValue(argv, i, "--base-url");
      i += 1;
      continue;
    }
    if (arg === "--file") {
      args.file = readOptionValue(argv, i, "--file");
      i += 1;
      continue;
    }
    if (arg === "--engine") {
      args.engine = readOptionValue(argv, i, "--engine");
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return args;
}

export function printHelp() {
  console.log("DJextender sidecar smoke script");
  console.log("");
  console.log("Usage:");
  console.log("  npm run smoke:sidecar -- [--base-url URL] [--file PATH] [--engine hybrid|librosa|essentia]");
  console.log("");
  console.log("Examples:");
  console.log("  npm run smoke:sidecar");
  console.log("  npm run smoke:sidecar -- --file C:/music/test.wav --engine essentia");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateAnalysisPayload(payload) {
  assert(payload && typeof payload === "object", "analyze payload must be an object");
  assert(isFiniteNumber(payload.bpm), "analyze payload missing finite bpm");
  assert(typeof payload.musicalKey === "string" && payload.musicalKey.length > 0, "analyze payload missing musicalKey");
  assert([4, 8, 16].includes(payload.phraseBars), "analyze payload phraseBars must be one of 4, 8, 16");
  assert(isFiniteNumber(payload.downbeatOffsetSeconds), "analyze payload missing downbeatOffsetSeconds");
  assert(Array.isArray(payload.timelineMarkers), "analyze payload missing timelineMarkers[]");
  assert(Array.isArray(payload.gates), "analyze payload missing gates[]");
}

export async function validateSmokeArgs(args) {
  assert(typeof args.baseUrl === "string" && args.baseUrl.length > 0, "--base-url cannot be empty");
  assert(ALLOWED_ENGINES.includes(args.engine), `--engine must be one of: ${ALLOWED_ENGINES.join(", ")}`);
  if (args.file) {
    const absolutePath = path.resolve(args.file);
    try {
      const stats = await fs.stat(absolutePath);
      assert(stats.isFile(), `--file is not a regular file: ${absolutePath}`);
    } catch {
      throw new Error(`--file does not exist: ${absolutePath}`);
    }
  }
}

export async function checkHealth(baseUrl) {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`health failed (${res.status}): ${body}`);
  }

  const payload = await res.json();
  assert(payload.status === "ok", "health payload status must be ok");
  console.log(`[ok] health ${baseUrl}/health`);
}

export async function runAnalyze(baseUrl, filePath, engine) {
  const absolutePath = path.resolve(filePath);
  const bytes = await fs.readFile(absolutePath);
  const blob = new Blob([bytes]);

  const formData = new FormData();
  formData.append("file", blob, path.basename(absolutePath));
  formData.append("analysis_engine", engine);

  const res = await fetch(`${baseUrl}/analyze`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`analyze failed (${res.status}): ${body}`);
  }

  const payload = await res.json();
  validateAnalysisPayload(payload);
  console.log(`[ok] analyze ${absolutePath}`);
  console.log(`[ok] bpm=${payload.bpm}, key=${payload.musicalKey}, phraseBars=${payload.phraseBars}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  await validateSmokeArgs(args);

  await checkHealth(args.baseUrl);

  if (args.file) {
    await runAnalyze(args.baseUrl, args.file, args.engine);
  } else {
    console.log("[info] no --file provided, analyze smoke skipped");
  }

  console.log("[done] sidecar smoke passed");
}

const isDirectRun = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fail] ${message}`);
    process.exit(1);
  });
}
