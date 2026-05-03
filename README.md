# DJextender

Desktop-first MVP for generating a deterministic plan for DJ-safe intro and outro extensions.

## Current State

- Standalone shell built with Tauri + React + TypeScript.
- First desktop screen for manual track intake and extension planning.
- Rust planner that turns BPM, key, phrase size and 32-bar targets into arrangement sections.
- Export notes and warnings for the later audio rendering engine.

## MVP Workflow

1. Load or name a track.
2. Enter BPM, key, duration and phrase size.
3. Choose intro/outro length and energy profile.
4. Build the plan.
5. Review intro stages, outro stages, warnings and suggested export label.

## Tech Stack

- Tauri 2
- React 19
- TypeScript
- Rust command layer for planner logic

## Development

```bash
npm install
npm run tauri dev
```

## Pro Analysis Sidecar (Recommended)

Run sidecar first to enable production-grade analysis path before planner generation.

```bash
cd analysis-sidecar
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8765
```

Sidecar endpoints:

- `POST /analyze` for production analysis (BPM/key/downbeat/markers/gates), defaulting to hybrid `librosa + essentia`
- `POST /separate` for Demucs stem package generation (`drums`, `bass`, `other`, `vocals`)
- `POST /render_extended` for deterministic extended render from source + stems + plan (WAV 44.1 kHz + MP3 320 + AIFF)
- `POST /generate_stable` for Stable Audio API generation

Notes:

- Install `ffmpeg` in system PATH for professional MP3/AIFF conversion.
- FFmpeg build should include `librubberband` for postproduction (time stretch/pitch shift).
- Without FFmpeg, sidecar falls back to WAV copies and emits warnings.
- Hybrid analysis uses Essentia when available; on Windows/PyPI packaging issues it automatically falls back to librosa with warnings.

Render metadata supports postproduction fields in `request`:

- `timeStretchRatio` (default `1.0`, range clamped to `0.5..2.0`)
- `pitchSemitones` (default `0.0`)

Stable Audio environment variables:

- `STABLE_AUDIO_API_KEY` (required)
- `STABLE_AUDIO_API_URL` (optional, default `https://api.stability.ai/v2beta/audio/stable-audio`)

Planner in app is locked until:

- analysis gates pass
- stem package is complete

Deterministic render in app is locked until:

- analysis gates pass
- stem package is complete
- validated extension plan exists

## Pro QA Benchmark (Required Before Release)

Use sidecar benchmark harness on your labeled dataset to validate analysis, stems, and render quality.

1. Prepare dataset folder with:
- `manifest.json` (based on `analysis-sidecar/qa/manifest.example.json`)
- referenced audio files

2. Run benchmark:

```bash
python analysis-sidecar/qa/benchmark_runner.py --dataset <path-to-dataset> --base-url http://127.0.0.1:8765 --with-stems --with-render --report runs/qa/benchmark_report.json
```

3. Review thresholds (recommended):
- BPM MAE <= 1.0
- Key accuracy >= 0.85
- Phrase accuracy >= 0.90
- Analysis pass rate >= 0.90
- Stem pass rate >= 0.95
- Render pass rate >= 0.95

If any threshold fails, keep pipeline blocked and recalibrate gates before release.

The desktop app uses sidecar engine as required path for professional mode.
If sidecar is unavailable, analysis and planning remain blocked.

Optional custom sidecar URL:

```bash
set VITE_ANALYSIS_SIDECAR_URL=http://127.0.0.1:8765
npm run tauri dev
```

For a frontend-only build check:

```bash
npm run build
```

## Next Steps

1. Add real waveform analysis: BPM, key, downbeat, phrase detection.
2. Add local file system import/export flow from Tauri commands.
3. Add stem-aware render engine for deterministic intro/outro creation.
4. Add optional cloud AI continuation mode for more creative transitions.
