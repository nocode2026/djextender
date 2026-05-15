from __future__ import annotations

import argparse
import json
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests


@dataclass
class TrackResult:
    file_name: str
    bpm_error: float
    key_match: bool
    phrase_match: bool
    downbeat_error: float | None
    analysis_pass: bool
    stems_pass: bool | None
    render_pass: bool | None
    qa_pass: bool | None
    qa_score: float | None
    qa_rms_db: float | None
    qa_bpm_drift_pct: float | None
    qa_junction_score: float | None
    notes: list[str]


def post_file(url: str, file_path: Path) -> dict[str, Any]:
    with file_path.open("rb") as handle:
        response = requests.post(url, files={"file": (file_path.name, handle)}, timeout=1800)
    response.raise_for_status()
    return response.json()


def post_render(url: str, file_path: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    with file_path.open("rb") as handle:
        response = requests.post(
            url,
            files={"file": (file_path.name, handle)},
            data={"metadata": json.dumps(metadata)},
            timeout=1800,
        )
    response.raise_for_status()
    return response.json()


def post_qa_render(
    url: str,
    wav_path: str,
    expected_bpm: float,
    expected_bars: int,
    intro_bars: int,
    outro_bars: int,
) -> dict[str, Any]:
    data = {
        "wav_path": wav_path,
        "expected_bpm": str(expected_bpm),
        "expected_bars": str(expected_bars),
        "intro_bars": str(intro_bars),
        "outro_bars": str(outro_bars),
    }
    response = requests.post(url, data=data, timeout=300)
    response.raise_for_status()
    return response.json()


def run_track(
    base_url: str,
    audio_file: Path,
    expected: dict[str, Any],
    run_stems: bool,
    run_render: bool,
    render_request: dict[str, Any] | None,
) -> TrackResult:
    notes: list[str] = []

    analysis = post_file(f"{base_url}/analyze", audio_file)
    bpm_error = abs(float(analysis["bpm"]) - float(expected["bpm"]))
    key_match = str(analysis["musicalKey"]).lower() == str(expected["key"]).lower()
    if expected.get("allowKeyMismatch"):
        key_match = True
    phrase_match = int(analysis["phraseBars"]) == int(expected["phraseBars"])

    downbeat_error = None
    if "downbeatOffsetSeconds" in expected:
        downbeat_error = abs(
            float(analysis["downbeatOffsetSeconds"]) - float(expected["downbeatOffsetSeconds"])
        )

    analysis_pass = bool(analysis.get("isProductionReady", False))
    if bpm_error > 1.0:
        notes.append(f"BPM error high: {bpm_error:.2f}")
    if not key_match:
        notes.append("Key mismatch")
    if not phrase_match:
        notes.append("Phrase mismatch")
    if downbeat_error is not None and downbeat_error > 0.08:
        notes.append(f"Downbeat error high: {downbeat_error:.3f}s")

    stems_pass: bool | None = None
    render_pass: bool | None = None
    qa_pass: bool | None = None
    qa_score: float | None = None
    qa_rms_db: float | None = None
    qa_bpm_drift_pct: float | None = None
    qa_junction_score: float | None = None
    stem_package: dict[str, Any] | None = None

    if run_stems or run_render:
        stem_package = post_file(f"{base_url}/separate", audio_file)
        stems_pass = bool(stem_package.get("isReady", False))
        if not stems_pass:
            notes.append("Stem package incomplete")

    if run_render:
        if stem_package is None:
            raise RuntimeError("Render requires stem package")

        request_payload = {
            "title": audio_file.stem,
            "bpm": float(analysis["bpm"]),
            "musicalKey": analysis["musicalKey"],
            "durationSeconds": float(analysis["durationSeconds"]),
            "detectedPhraseBars": int(analysis["phraseBars"]),
            "introBars": int((render_request or {}).get("introBars", 32)),
            "outroBars": int((render_request or {}).get("outroBars", 32)),
            "genre": "benchmark",
            "energyProfile": "peak",
            "preserveVocals": False,
            "operationMode": (render_request or {}).get("operationMode", "intro_outro"),
            "stylePreset": "modern_deep_house_edit",
            "vocalHandling": "no_vocals",
            "takeCount": int((render_request or {}).get("takeCount", 3)),
            "analysisOverallScore": float(analysis["overallScore"]),
            "analysisProductionReady": bool(analysis["isProductionReady"]),
            "downbeatOffsetSeconds": float(analysis["downbeatOffsetSeconds"]),
            "downbeatConfidence": float(analysis["downbeatConfidence"]),
            "markerCount": int(len(analysis["timelineMarkers"])),
            "stemPackageReady": bool(stem_package["isReady"]),
            "stemEngine": stem_package["stemEngine"],
            "stemPackageId": stem_package["jobId"],
        }

        plan_payload = {
            "quantizedIntroBars": int(request_payload["introBars"]),
            "quantizedOutroBars": int(request_payload["outroBars"]),
            "takes": [
                {
                    "takeIndex": index + 1,
                    "label": f"Take {index + 1}",
                    "variationFocus": "benchmark",
                    "renderNotes": ["qa"],
                    "exportLabel": f"benchmark_take_{index + 1}.wav",
                }
                for index in range(int(request_payload["takeCount"]))
            ],
        }

        metadata = {
            "request": request_payload,
            "plan": plan_payload,
            "stemPackage": stem_package,
        }

        render = post_render(f"{base_url}/render_extended", audio_file, metadata)
        rendered_files = [Path(take["outputPath"]) for take in render.get("takes", [])]
        render_pass = all(path.exists() and path.stat().st_size > 0 for path in rendered_files)
        if not render_pass:
            notes.append("Rendered takes missing or empty")

        # --- QA render on first take ---
        if rendered_files:
            rr = render_request or {}
            intro_bars = int(rr.get("introBars", 32))
            outro_bars = int(rr.get("outroBars", 32))
            op_mode = rr.get("operationMode", "intro_outro")
            beat_interval = 60.0 / max(float(analysis["bpm"]), 1.0)
            source_bars = round(float(analysis["durationSeconds"]) / (beat_interval * 4))
            expected_bars_qa = (
                (intro_bars if op_mode != "outro" else 0)
                + source_bars
                + (outro_bars if op_mode != "intro" else 0)
            )
            try:
                qa = post_qa_render(
                    f"{base_url}/qa_render",
                    wav_path=str(rendered_files[0]),
                    expected_bpm=float(analysis["bpm"]),
                    expected_bars=expected_bars_qa,
                    intro_bars=intro_bars if op_mode != "outro" else 0,
                    outro_bars=outro_bars if op_mode != "intro" else 0,
                )
                qa_pass = bool(qa.get("passed", False))
                qa_score = float(qa.get("score", 0.0))
                qa_rms_db = float(qa.get("rmsDb", 0.0))
                qa_bpm_drift_pct = float(qa.get("bpmDriftPercent", 0.0))
                qa_junction_score = float(qa.get("junctionGlitchScore", 0.0))
                if not qa_pass:
                    notes.append(f"QA FAIL score={qa_score:.2f}")
            except Exception as exc:
                notes.append(f"QA render error: {exc}")

    return TrackResult(
        file_name=audio_file.name,
        bpm_error=bpm_error,
        key_match=key_match,
        phrase_match=phrase_match,
        downbeat_error=downbeat_error,
        analysis_pass=analysis_pass,
        stems_pass=stems_pass,
        render_pass=render_pass,
        qa_pass=qa_pass,
        qa_score=qa_score,
        qa_rms_db=qa_rms_db,
        qa_bpm_drift_pct=qa_bpm_drift_pct,
        qa_junction_score=qa_junction_score,
        notes=notes,
    )


def summarize(results: list[TrackResult]) -> dict[str, Any]:
    bpm_errors = [result.bpm_error for result in results]
    key_matches = [result.key_match for result in results]
    phrase_matches = [result.phrase_match for result in results]
    downbeat_values = [result.downbeat_error for result in results if result.downbeat_error is not None]

    summary: dict[str, Any] = {
        "tracks": len(results),
        "bpmMAE": statistics.mean(bpm_errors) if bpm_errors else None,
        "keyAccuracy": sum(1 for value in key_matches if value) / len(key_matches) if key_matches else None,
        "phraseAccuracy": sum(1 for value in phrase_matches if value) / len(phrase_matches) if phrase_matches else None,
        "analysisPassRate": sum(1 for result in results if result.analysis_pass) / len(results) if results else None,
    }

    if downbeat_values:
        summary["downbeatMAE"] = statistics.mean(downbeat_values)

    if any(result.stems_pass is not None for result in results):
        stem_values = [bool(result.stems_pass) for result in results if result.stems_pass is not None]
        summary["stemsPassRate"] = sum(1 for value in stem_values if value) / len(stem_values)

    if any(result.render_pass is not None for result in results):
        render_values = [bool(result.render_pass) for result in results if result.render_pass is not None]
        summary["renderPassRate"] = sum(1 for value in render_values if value) / len(render_values)

    qa_scores = [result.qa_score for result in results if result.qa_score is not None]
    if qa_scores:
        summary["qaScoreMean"] = statistics.mean(qa_scores)
        summary["qaPassRate"] = sum(1 for r in results if r.qa_pass) / len(results)

    qa_rms = [result.qa_rms_db for result in results if result.qa_rms_db is not None]
    if qa_rms:
        summary["qaRmsMean"] = statistics.mean(qa_rms)

    qa_drift = [result.qa_bpm_drift_pct for result in results if result.qa_bpm_drift_pct is not None]
    if qa_drift:
        summary["qaBpmDriftMean"] = statistics.mean(qa_drift)

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Run DJ Extend sidecar benchmark and regression checks")
    parser.add_argument("--dataset", required=True, help="Path to dataset folder containing manifest.json")
    parser.add_argument("--base-url", default="http://127.0.0.1:8765", help="Sidecar base URL")
    parser.add_argument("--with-stems", action="store_true", help="Run Demucs stem separation checks")
    parser.add_argument("--with-render", action="store_true", help="Run deterministic render checks")
    parser.add_argument("--report", default="", help="Optional path to save JSON report")
    args = parser.parse_args()

    dataset_dir = Path(args.dataset).resolve()
    manifest_path = dataset_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"Missing manifest file: {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tracks = manifest.get("tracks", [])
    if not tracks:
        raise SystemExit("Manifest has no tracks")

    results: list[TrackResult] = []
    for track in tracks:
        file_path = dataset_dir / track["file"]
        if not file_path.exists():
            raise SystemExit(f"Missing track file: {file_path}")

        result = run_track(
            base_url=args.base_url,
            audio_file=file_path,
            expected=track["expected"],
            run_stems=args.with_stems or args.with_render,
            run_render=args.with_render,
            render_request=track.get("renderRequest"),
        )
        results.append(result)

    summary = summarize(results)

    report = {
        "summary": summary,
        "tracks": [
            {
                "file": result.file_name,
                "bpmError": result.bpm_error,
                "keyMatch": result.key_match,
                "phraseMatch": result.phrase_match,
                "downbeatError": result.downbeat_error,
                "analysisPass": result.analysis_pass,
                "stemsPass": result.stems_pass,
                "renderPass": result.render_pass,
                "qaPass": result.qa_pass,
                "qaScore": result.qa_score,
                "qaRmsDb": result.qa_rms_db,
                "qaBpmDriftPct": result.qa_bpm_drift_pct,
                "qaJunctionScore": result.qa_junction_score,
                "notes": result.notes,
            }
            for result in results
        ],
    }

    print(json.dumps(report, indent=2))

    if args.report:
        report_path = Path(args.report).resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
