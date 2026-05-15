from __future__ import annotations

import argparse
from pathlib import Path
import requests

BASE_URL = "http://127.0.0.1:8765"


def pick_track(music_root: Path) -> Path:
    candidates: list[Path] = []
    for folder in sorted(music_root.iterdir()):
        if not folder.is_dir() or not folder.name.startswith("80"):
            continue
        for ext in ("*.mp3", "*.wav", "*.flac", "*.m4a", "*.aiff", "*.aif"):
            candidates.extend(sorted(folder.glob(ext)))
    if not candidates:
        raise SystemExit(f"No audio files found in: {music_root}")
    return candidates[0]


def run(track: Path, base_url: str) -> None:
    print(f"TRACK={track}")

    with track.open("rb") as handle:
        response = requests.post(
            f"{base_url}/analyze",
            files={"file": (track.name, handle)},
            data={"analysis_engine": "essentia"},
            timeout=300,
        )

    print(f"HTTP_STATUS={response.status_code}")
    if response.status_code >= 400:
        print(response.text)
        raise SystemExit(1)

    payload = response.json()
    print(f"BPM={payload.get('bpm')}")
    print(f"KEY={payload.get('musicalKey')}")
    print(f"PHRASE_BARS={payload.get('phraseBars')}")
    print(f"OVERALL_SCORE={payload.get('overallScore')}")
    print(f"PRO_READY={payload.get('isProductionReady')}")
    print(f"WARNINGS={len(payload.get('warnings', []))}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run a quick essentia smoke test against the sidecar")
    parser.add_argument("--base-url", default=BASE_URL, help="Sidecar base URL")
    parser.add_argument(
        "--track",
        default="",
        help="Optional absolute path to a specific audio file. If omitted, auto-picks the first file from --music-root/80*",
    )
    parser.add_argument(
        "--music-root",
        default="",
        help="Optional root folder containing EN/80* style subfolders used for auto-pick mode",
    )
    args = parser.parse_args()

    if args.track:
        selected_track = Path(args.track).expanduser().resolve()
        if not selected_track.exists() or not selected_track.is_file():
            raise SystemExit(f"Invalid --track path: {selected_track}")
    else:
        if not args.music_root:
            raise SystemExit("Provide --track or --music-root")
        selected_track = pick_track(Path(args.music_root).expanduser().resolve())

    run(selected_track, args.base_url)
