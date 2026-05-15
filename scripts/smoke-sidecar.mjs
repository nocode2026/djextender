#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
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
      args.baseUrl = argv[i + 1] ?? args.baseUrl;
      i += 1;
      continue;
    }
    if (arg === "--file") {
      args.file = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--engine") {
      args.engine = argv[i + 1] ?? args.engine;
      i += 1;
      continue;
    }
  }

  return args;
}

function printHelp() {
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateAnalysisPayload(payload) {
  assert(payload && typeof payload === "object", "analyze payload must be an object");
  assert(isFiniteNumber(payload.bpm), "analyze payload missing finite bpm");
  assert(typeof payload.musicalKey === "string" && payload.musicalKey.length > 0, "analyze payload missing musicalKey");
  assert([4, 8, 16].includes(payload.phraseBars), "analyze payload phraseBars must be one of 4, 8, 16");
  assert(isFiniteNumber(payload.downbeatOffsetSeconds), "analyze payload missing downbeatOffsetSeconds");
  assert(Array.isArray(payload.timelineMarkers), "analyze payload missing timelineMarkers[]");
  assert(Array.isArray(payload.gates), "analyze payload missing gates[]");
}

async function checkHealth(baseUrl) {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`health failed (${res.status}): ${body}`);
  }

  const payload = await res.json();
  assert(payload.status === "ok", "health payload status must be ok");
  console.log(`[ok] health ${baseUrl}/health`);
}

async function runAnalyze(baseUrl, filePath, engine) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  await checkHealth(args.baseUrl);

  if (args.file) {
    await runAnalyze(args.baseUrl, args.file, args.engine);
  } else {
    console.log("[info] no --file provided, analyze smoke skipped");
  }

  console.log("[done] sidecar smoke passed");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fail] ${message}`);
  process.exit(1);
});
