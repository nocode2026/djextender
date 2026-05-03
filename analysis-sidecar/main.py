from __future__ import annotations

import io
import json
import logging
import os
import sys
import base64
import importlib
import mimetypes
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Literal
from uuid import uuid4

import librosa
import numpy as np
import requests
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from scipy.signal import butter, sosfilt

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def _load_local_env() -> None:
    """Load key=value pairs from local .env files if present."""
    env_candidates = [
        Path(__file__).resolve().parent / ".env",
        Path.cwd() / ".env",
    ]
    for env_path in env_candidates:
        if not env_path.exists() or not env_path.is_file():
            continue
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ.setdefault(key, value)


_load_local_env()

# --- Stable Audio local model (lazy-loaded, singleton) ---
_stable_audio_pipe = None
_stable_audio_lock = threading.Lock()


def _get_stable_audio_pipe():
    """Lazy-load stabilityai/stable-audio-open-1.0 via diffusers.

    Requires: pip install diffusers torch torchaudio soundfile einops
    Optionally set HUGGINGFACE_TOKEN env var to authenticate (required
    to accept the model license on first download).
    """
    global _stable_audio_pipe  # noqa: PLW0603
    with _stable_audio_lock:
        if _stable_audio_pipe is None:
            try:
                import torch
                from diffusers import StableAudioPipeline

                device = "cuda" if torch.cuda.is_available() else "cpu"
                dtype = torch.float16 if device == "cuda" else torch.float32
                hf_token = os.getenv("HUGGINGFACE_TOKEN", "").strip() or None
                logger.info("Loading stabilityai/stable-audio-open-1.0 on %s (%s)…", device, dtype)
                pipe = StableAudioPipeline.from_pretrained(
                    "stabilityai/stable-audio-open-1.0",
                    torch_dtype=dtype,
                    token=hf_token,
                )
                pipe = pipe.to(device)
                _stable_audio_pipe = pipe
                logger.info("stable-audio-open-1.0 ready")
            except Exception as exc:
                raise RuntimeError(f"Failed to load stable-audio-open-1.0: {exc}") from exc
    return _stable_audio_pipe


# --- Progress tracking (per-job) ---
import asyncio
import time
import threading
from collections import defaultdict

_job_progress: dict[str, dict] = {}  # job_id -> progress entry
_job_results: dict[str, dict] = {}   # job_id -> serialized RenderExtendedResult (when done)

def _set_progress(job_id: str, step: int, total: int, label: str, done: bool = False, error: str = "") -> None:
    now = time.time()
    existing = _job_progress.get(job_id, {})
    _job_progress[job_id] = {
        "step": step,
        "total": total,
        "label": label,
        "done": done,
        "error": error,
        "last_heartbeat": now,
        "started_at": existing.get("started_at", now),
    }



class StructureSection(BaseModel):
    startSeconds: float
    endSeconds: float
    bars: int
    energy: Literal["low", "mid", "high"]


class AnalysisGate(BaseModel):
    id: str
    label: str
    value: float
    threshold: float
    passed: bool


class TimelineMarker(BaseModel):
    type: Literal["beat", "downbeat", "phrase_start"]
    seconds: float
    beatIndex: int
    barIndex: int
    beatInBar: int
    phraseIndex: int


class ProAnalysisResult(BaseModel):
    bpm: int
    bpmSecondary: int
    bpmConfidence: float
    musicalKey: str
    camelotKey: str
    keyConfidence: float
    phraseBars: int
    phraseConfidence: float
    beatIntervalSeconds: float
    beatCount: int
    downbeatOffsetSeconds: float
    downbeatConfidence: float
    structureSections: list[StructureSection]
    beatTimestampsSeconds: list[float]
    downbeatTimestampsSeconds: list[float]
    phraseBoundarySeconds: list[float]
    timelineMarkers: list[TimelineMarker]
    overallScore: float
    isProductionReady: bool
    gates: list[AnalysisGate]
    durationSeconds: float
    sampleRate: int
    warnings: list[str]
    analyzerEngine: Literal["pro-sidecar"]


class StemFile(BaseModel):
    stem: Literal["drums", "bass", "other", "vocals"]
    path: str
    exists: bool
    sizeBytes: int


class StemSeparationResult(BaseModel):
    jobId: str
    model: str
    outputDirectory: str
    stems: list[StemFile]
    isReady: bool
    warnings: list[str]
    stemEngine: Literal["demucs-sidecar"]


class RenderedTake(BaseModel):
    takeIndex: int
    label: str
    outputPath: str
    wavPath: str
    mp3Path: str
    aiffPath: str
    durationSeconds: float
    sampleRate: int


class RenderExtendedResult(BaseModel):
    jobId: str
    outputDirectory: str
    takes: list[RenderedTake]
    warnings: list[str]
    renderEngine: Literal["deterministic-sidecar-v1"]


class RenderStartResult(BaseModel):
    jobId: str
    status: Literal["started"]


class TransformPreviewResult(BaseModel):
    jobId: str
    outputDirectory: str
    previewPath: str
    durationSeconds: float
    sampleRate: int
    warnings: list[str]
    transformEngine: Literal["rubberband-cli-v1"]


class TransformAudioResult(BaseModel):
    jobId: str
    outputDirectory: str
    wavPath: str
    mp3Path: str
    aiffPath: str
    durationSeconds: float
    sampleRate: int
    warnings: list[str]
    transformEngine: Literal["rubberband-cli-v1"]


class StableAudioGenerateResult(BaseModel):
    jobId: str
    outputPath: str
    sampleRate: int
    durationSeconds: float
    prompt: str
    warnings: list[str]
    generationEngine: Literal["stable-audio-api"]


class QAGate(BaseModel):
    id: str
    label: str
    passed: bool
    value: float
    threshold: float
    unit: str


class QARenderResult(BaseModel):
    wavPath: str
    durationSeconds: float
    sampleRate: int
    expectedDurationSeconds: float
    durationDeltaSeconds: float
    barCount: float
    expectedBarCount: int
    barCountError: float
    bpmMeasured: float
    bpmExpected: float
    bpmDriftPercent: float
    rmsDb: float
    peakDb: float
    hasClipping: bool
    junctionGlitchScore: float
    score: float
    passed: bool
    gates: list[QAGate]
    warnings: list[str]


app = FastAPI(title="DJ Extend Pro Analysis Sidecar", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["tauri://localhost", "http://127.0.0.1:8765", "http://localhost:1420"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/progress/{job_id}")
async def get_progress(job_id: str):
    """Zwraca aktualny stan postępu dla danego job_id jako JSON.
    Frontend polluje co 2-3 sekundy. Endpoint jest lekki i non-blocking."""
    data = _job_progress.get(job_id)
    if data is None:
        return {"step": 0, "total": 0, "label": "Waiting...", "done": False, "error": "",
                "last_heartbeat": None, "started_at": None, "elapsed_seconds": 0, "eta_seconds": None}
    now = time.time()
    started_at = data.get("started_at") or now
    elapsed = now - started_at
    step = data.get("step", 0)
    total = data.get("total", 1)
    eta = None
    if step > 0 and total > 0 and elapsed > 0:
        rate = step / elapsed
        remaining = total - step
        if rate > 0:
            eta = remaining / rate
    return {
        **data,
        "elapsed_seconds": round(elapsed, 1),
        "eta_seconds": round(eta, 0) if eta is not None else None,
    }


@app.get("/render_result/{job_id}")
async def get_render_result(job_id: str):
    """Zwraca wynik render job gdy done=True, lub 202 gdy jeszcze trwa."""
    progress = _job_progress.get(job_id)
    if progress is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    if progress.get("error"):
        raise HTTPException(status_code=500, detail=progress["error"])
    if not progress.get("done"):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=202, content={"status": "pending", "jobId": job_id})
    result = _job_results.get(job_id)
    if result is None:
        raise HTTPException(status_code=500, detail="Job done but result not stored")
    return result




NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]
CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]


def _normalize(values: np.ndarray) -> np.ndarray:
    if values.size == 0:
        return values
    max_abs = np.max(np.abs(values))
    if max_abs <= 1e-8:
        return values
    return values / max_abs


def _energy_label(value: float) -> Literal["low", "mid", "high"]:
    if value < 0.33:
        return "low"
    if value < 0.66:
        return "mid"
    return "high"


# Kruse-Harte profiles — dokładniejsze od Krumhansl-Schmuckler dla muzyki pop/dance
_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Alternatywne profile do triangulacji (Temperley 2007 pitch-class profile)
_MAJOR_PROFILE2 = np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
_MINOR_PROFILE2 = np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])


def _score_key(chroma_vec: np.ndarray, profile_maj: np.ndarray, profile_min: np.ndarray) -> tuple[str, float]:
    """Dopasuj chroma do 24 tonacji, zwroc najlepsza i confidence."""
    best_label = "C major"
    best_score = -1.0
    second_score = -1.0

    for i in range(12):
        maj = float(np.dot(chroma_vec, np.roll(profile_maj, i)))
        minn = float(np.dot(chroma_vec, np.roll(profile_min, i)))
        for label, score in ((f"{NOTE_NAMES[i]} major", maj), (f"{NOTE_NAMES[i]} minor", minn)):
            if score > best_score:
                second_score = best_score
                best_score = score
                best_label = label
            elif score > second_score:
                second_score = score

    conf = max(0.0, min(1.0, 0.5 + (best_score - second_score) * 0.5))
    return best_label, conf


def _key_from_chroma(chroma_mean: np.ndarray) -> tuple[str, float]:
    """Backward-compatible wrapper."""
    return _score_key(chroma_mean, _MAJOR_PROFILE, _MINOR_PROFILE)


def _key_vote_multi_window(
    mono: np.ndarray, sr: int, window_sec: float = 8.0, hop_sec: float = 4.0
) -> tuple[str, float]:
    """
    Robust key detection przez multi-window voting.
    Dzieli utwor na okna (8s, hop 4s), oblicza CQT chroma w kazdym,
    wazy waga RMS, zbiera glosy na 24 tonacje z dwoch profili.
    Zwraca winner i composite confidence.
    """
    hop_length = 512
    chroma_full = librosa.feature.chroma_cqt(y=mono, sr=sr, hop_length=hop_length, bins_per_octave=36)
    rms_full = librosa.feature.rms(y=mono, frame_length=2048, hop_length=hop_length)[0]

    win_frames = int(window_sec * sr / hop_length)
    hop_frames = int(hop_sec * sr / hop_length)
    n_frames = chroma_full.shape[1]

    votes: dict[str, float] = {}

    for start in range(0, max(1, n_frames - win_frames + 1), hop_frames):
        end = min(start + win_frames, n_frames)
        if end - start < 8:
            continue
        window_chroma = chroma_full[:, start:end]
        window_rms = rms_full[start:end]
        rms_weight = float(np.mean(window_rms)) + 1e-8
        # Srednia chroma wazona RMS per frame
        weights = window_rms / (window_rms.sum() + 1e-8)
        w_chroma = np.dot(window_chroma, weights)
        w_chroma = _normalize(w_chroma)

        # Glos z obu profili
        for prof_maj, prof_min, scale in (
            (_MAJOR_PROFILE, _MINOR_PROFILE, 1.0),
            (_MAJOR_PROFILE2, _MINOR_PROFILE2, 0.6),
        ):
            label, conf = _score_key(w_chroma, prof_maj, prof_min)
            votes[label] = votes.get(label, 0.0) + rms_weight * conf * scale

    if not votes:
        chroma_mean = _normalize(np.mean(chroma_full, axis=1))
        return _key_from_chroma(chroma_mean)

    # Posortuj glosy — winner i runner-up do confidence
    sorted_votes = sorted(votes.items(), key=lambda x: x[1], reverse=True)
    winner_key = sorted_votes[0][0]
    winner_score = sorted_votes[0][1]
    runner_score = sorted_votes[1][1] if len(sorted_votes) > 1 else 0.0
    total = sum(v for _, v in sorted_votes)

    # Confidence: kombinacja separacji + udzialu procentowego w glosowaniu
    margin = (winner_score - runner_score) / (winner_score + 1e-8)
    share = winner_score / (total + 1e-8)
    confidence = float(np.clip(0.4 * margin + 0.6 * share, 0.0, 1.0))

    return winner_key, confidence


def _detect_downbeat_phase_refined(
    mono: np.ndarray,
    sr: int,
    beat_frames: np.ndarray,
    beat_times: list[float],
) -> tuple[int, float]:
    """
    Ulepszone wykrywanie fazy downbeat (bar-1).

    Etap 1 — energy vote: per faza 0-3 sumuj energie low-freq onset w miejscach beatow.
    Etap 2 — spectral bass vote: per faza sumuj energie sub-bass (<200 Hz) w okolicach beatow.
    Etap 3 — wazona kombinacja obu wynikow.
    Etap 4 — confidence z separacja najlepszej fazy od sredniej pozostalych.
    Zwraca (best_phase_index, confidence).
    """
    if len(beat_frames) < 4:
        return 0, 0.5

    hop_length = 512

    # Onset strength envelope (percussion)
    _, percussive = librosa.effects.hpss(mono)
    onset_env = librosa.onset.onset_strength(y=percussive, sr=sr, hop_length=hop_length)

    # Sub-bass envelope (< ~200 Hz) — silny marker downbeat w muzyce dance
    n_fft = 2048
    stft = np.abs(librosa.stft(mono, n_fft=n_fft, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    bass_bins = np.where(freqs <= 200.0)[0]
    bass_env = np.mean(stft[bass_bins, :], axis=0) if bass_bins.size > 0 else np.zeros(stft.shape[1])

    def _sum_energy_per_phase(env: np.ndarray, radius: int = 2) -> list[float]:
        phase_energy = [0.0, 0.0, 0.0, 0.0]
        phase_count = [0, 0, 0, 0]
        for i, frame in enumerate(beat_frames):
            p = i % 4
            lo = max(0, int(frame) - radius)
            hi = min(env.size, int(frame) + radius + 1)
            phase_energy[p] += float(np.max(env[lo:hi])) if hi > lo else 0.0
            phase_count[p] += 1
        return [phase_energy[p] / max(phase_count[p], 1) for p in range(4)]

    onset_per_phase = _sum_energy_per_phase(onset_env, radius=2)
    bass_per_phase = _sum_energy_per_phase(bass_env, radius=3)

    # Znormalizuj osobno
    def _norm_list(lst: list[float]) -> list[float]:
        m = max(lst) if lst else 1.0
        return [v / (m + 1e-8) for v in lst]

    onset_norm = _norm_list(onset_per_phase)
    bass_norm = _norm_list(bass_per_phase)

    # Wazona suma: bass ma wyzszy priorytet dla muzyki tanecznej
    combined = [0.4 * onset_norm[p] + 0.6 * bass_norm[p] for p in range(4)]
    best_phase = int(np.argmax(combined))

    # Confidence: odleglosc best od sredniej pozostalych
    best_val = combined[best_phase]
    others = [combined[p] for p in range(4) if p != best_phase]
    mean_others = float(np.mean(others)) if others else 0.0
    separation = best_val - mean_others  # [0..1] gdy inne sa rowne 0
    confidence = float(np.clip(0.45 + separation * 1.8, 0.0, 1.0))

    return best_phase, confidence


def _to_camelot(key_name: str) -> str:
    parts = key_name.split(" ")
    if len(parts) != 2:
        return "Unknown"

    note, mode = parts
    try:
        idx = NOTE_NAMES.index(note)
    except ValueError:
        return "Unknown"

    if mode.lower() == "minor":
        return CAMELOT_MINOR[idx]
    if mode.lower() == "major":
        return CAMELOT_MAJOR[idx]
    return "Unknown"


def _resample_stereo(audio: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    if source_sr == target_sr:
        return audio

    channels = []
    for channel in range(audio.shape[1]):
        channels.append(librosa.resample(audio[:, channel], orig_sr=source_sr, target_sr=target_sr))

    return np.stack(channels, axis=1).astype(np.float32)


def _ensure_stereo(audio: np.ndarray) -> np.ndarray:
    if audio.ndim == 1:
        return np.stack([audio, audio], axis=1)

    if audio.shape[1] == 1:
        return np.concatenate([audio, audio], axis=1)

    return audio[:, :2]


def _lp_filter(audio: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    """Low-pass filtr — usuwa wysokie częstotliwości (efekt buildup)."""
    cutoff_hz = float(np.clip(cutoff_hz, 20.0, sr / 2 - 1))
    sos = butter(4, cutoff_hz, btype="low", fs=sr, output="sos")
    return sosfilt(sos, audio, axis=0).astype(np.float32)


def _hp_filter(audio: np.ndarray, sr: int, cutoff_hz: float) -> np.ndarray:
    """High-pass filtr — usuwa niskie częstotliwości."""
    cutoff_hz = float(np.clip(cutoff_hz, 20.0, sr / 2 - 1))
    sos = butter(4, cutoff_hz, btype="high", fs=sr, output="sos")
    return sosfilt(sos, audio, axis=0).astype(np.float32)


def _volume_automation(audio: np.ndarray, gains: list[float]) -> np.ndarray:
    """Liniowa automatyka wolumenu — gains to lista N punktów od 0.0 do 1.0,
    interpolowana przez całą długość audio. DJ-standard ramping."""
    if audio.shape[0] == 0 or not gains:
        return audio
    x = np.linspace(0, 1, audio.shape[0], dtype=np.float32)
    xp = np.linspace(0, 1, len(gains), dtype=np.float32)
    envelope = np.interp(x, xp, np.array(gains, dtype=np.float32))
    return (audio * envelope[:, None]).astype(np.float32)


def _loop_to_length(audio: np.ndarray, length: int, start_offset: int = 0) -> np.ndarray:
    """Zapętla audio do zadanej długości, zaczynając od start_offset (downbeat alignment)."""
    if length <= 0:
        return np.zeros((0, audio.shape[1] if audio.ndim == 2 else 2), dtype=np.float32)

    if audio.shape[0] == 0:
        return np.zeros((length, 2), dtype=np.float32)

    # Zaczynamy od downbeat offset — loop brzmi muzycznie
    src = audio[start_offset:] if start_offset < audio.shape[0] else audio
    if src.shape[0] == 0:
        src = audio

    repeats = int(np.ceil(length / src.shape[0])) + 1
    tiled = np.tile(src, (repeats, 1))
    return tiled[:length].astype(np.float32)


def _crossfade(a: np.ndarray, b: np.ndarray, fade_samples: int) -> np.ndarray:
    """Miesza koniec 'a' z początkiem 'b' przez crossfade o długości fade_samples."""
    if fade_samples <= 0 or a.shape[0] == 0 or b.shape[0] == 0:
        return np.concatenate([a, b], axis=0)

    fade_samples = min(fade_samples, a.shape[0], b.shape[0])
    # Equal-power crossfade (avoids loudness dip at crossover point)
    t = np.linspace(0.0, np.pi / 2, fade_samples, dtype=np.float32)
    tail = a[-fade_samples:].copy() * np.cos(t)[:, None]
    head = b[:fade_samples].copy() * np.sin(t)[:, None]
    blend = tail + head

    return np.concatenate([a[:-fade_samples], blend, b[fade_samples:]], axis=0).astype(np.float32)


def _fade(audio: np.ndarray, fade_samples: int, fade_in: bool) -> np.ndarray:
    if fade_samples <= 0 or audio.shape[0] == 0:
        return audio

    fade_samples = min(fade_samples, audio.shape[0])
    curve = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
    result = audio.copy()
    if fade_in:
        result[:fade_samples] *= curve[:, None]
    else:
        result[-fade_samples:] *= curve[::-1][:, None]
    return result


def _build_ai_prompt(
    *,
    operation: str,  # "intro" | "outro"
    bpm: float,
    musical_key: str,
    camelot_key: str,
    style_preset: str,
    duration_s: float,
) -> str:
    """Auto-generate a Stable Audio prompt from track analysis data."""
    # Genre from BPM
    if bpm < 95:
        genre = "trip-hop, lo-fi hip hop"
    elif bpm < 110:
        genre = "downtempo, nu-disco"
    elif bpm < 118:
        genre = "house music"
    elif bpm < 126:
        genre = "tech house, progressive house"
    elif bpm < 133:
        genre = "techno, peak time techno"
    elif bpm < 142:
        genre = "hard techno, industrial techno"
    elif bpm < 158:
        genre = "trance, uplifting trance"
    else:
        genre = "drum and bass, liquid DnB"

    # Mood from key
    is_minor = "minor" in musical_key.lower() or musical_key.strip().endswith("m")
    mood = "dark, driving, hypnotic" if is_minor else "bright, uplifting, energetic"

    # Style descriptor from preset
    style_map = {
        "close_to_original": "faithful to original, natural production",
        "cleaner_club_edit": "clean, minimal club edit",
        "modern_deep_house_edit": "deep, warm, atmospheric",
        "radio_to_club_extended": "energetic build, radio-to-club transition",
    }
    style_desc = style_map.get(style_preset, "professional club mix")

    # Operation-specific description
    if operation == "intro":
        op_desc = (
            "DJ intro buildup, gradually layering drums and bass, low-pass filter sweep opening up, "
            "no lead vocals, no lyrics, clean kick, building energy, DJ-safe loop start"
        )
    else:
        op_desc = (
            "DJ outro breakdown, gradually stripping back layers, high-pass filter sweeping down, "
            "no lead vocals, no lyrics, drums fading, smooth loop ending, DJ-safe fadeout"
        )

    capped_dur = min(30, max(4, int(duration_s)))
    key_info = f"{musical_key} ({camelot_key})" if camelot_key else musical_key

    return (
        f"{genre}, {mood}, {style_desc}, "
        f"{op_desc}, "
        f"{int(round(bpm))} BPM, key {key_info}, "
        f"stereo, 44100 Hz, {capped_dur} seconds, professional DJ production"
    )


def _generate_stable_to_file(
    *,
    prompt_text: str,
    clip_duration_seconds: float,
    clip_bpm: float = 120.0,
    clip_key: str = "",
    destination_path: Path,
    seed: int | None = None,
    num_steps: int = 100,
) -> tuple[int, float, list[str]]:
    """Generate audio using the local stabilityai/stable-audio-open-1.0 model."""
    import torch
    import soundfile as sf_io

    duration_s = float(np.clip(clip_duration_seconds, 4.0, 30.0))
    pipe = _get_stable_audio_pipe()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    actual_seed = seed if seed is not None else 42
    generator = torch.Generator(device=device).manual_seed(actual_seed)

    negative_prompt = (
        "low quality, distortion, clipping, noise, silence, vocals, "
        "singing, speech, lyrics, talking"
    )

    logger.info(
        "Generating %.1fs audio on %s — prompt: %s",
        duration_s, device, prompt_text[:120],
    )
    result = pipe(
        prompt_text,
        negative_prompt=negative_prompt,
        num_inference_steps=num_steps,
        audio_end_in_s=duration_s,
        num_waveforms_per_prompt=1,
        generator=generator,
    )
    audio_np = result.audios[0].T.float().cpu().numpy()
    sample_rate: int = pipe.vae.sampling_rate
    sf_io.write(str(destination_path), audio_np, sample_rate)
    warnings_local: list[str] = []
    return sample_rate, duration_s, warnings_local

    try:
        generated_audio, sample_rate = sf.read(destination_path, always_2d=True)
    except Exception as exc:
        raise RuntimeError(f"Generated file decode failed: {exc}") from exc

    duration_local = float(generated_audio.shape[0] / max(sample_rate, 1))
    return int(sample_rate), duration_local, warnings_local


def _build_intro(
    drums: np.ndarray,
    bass: np.ndarray,
    other: np.ndarray,
    vocals: np.ndarray,
    length: int,
    include_vocal_hook: bool,
    downbeat_offset: int = 0,
    sr: int = 44100,
) -> np.ndarray:
    """Drums+bass-first intro buildup (4 etapy).

    Priorytet: groove i low-end pod miks DJ. Melody (other) jest tylko tłem w końcówce.
    """
    if length == 0:
        return np.zeros((0, 2), dtype=np.float32)

    part = max(1, length // 4)
    stage_lengths = [part, part, part, length - (3 * part)]
    o = downbeat_offset

    # --- ETAP 1: same drums, LP opening ---
    d1 = _loop_to_length(drums, stage_lengths[0], o)
    d1_lo = _lp_filter(d1, sr, 700.0)
    d1_hi = _lp_filter(d1, sr, 3800.0)
    env1 = np.linspace(0.0, 1.0, stage_lengths[0], dtype=np.float32)[:, None]
    stage1 = d1_lo * (1.0 - env1 * 0.70) + d1_hi * (env1 * 0.70)
    stage1 = _volume_automation(stage1, [0.50, 0.60, 0.70, 0.82])

    # --- ETAP 2: drums + bass (bass reveal sweep) ---
    d2 = _loop_to_length(drums, stage_lengths[1], o)
    b2 = _loop_to_length(bass, stage_lengths[1], o)
    b2_filtered_env = np.linspace(0.0, 1.0, stage_lengths[1], dtype=np.float32)[:, None]
    b2_hp = _hp_filter(b2, sr, 260.0)
    b2_full = b2
    b2_mixed = b2_hp * (1.0 - b2_filtered_env) + b2_full * b2_filtered_env
    bass_gain = np.linspace(0.0, 0.95, stage_lengths[1], dtype=np.float32)[:, None]
    stage2 = d2 * 0.98 + b2_mixed * bass_gain
    stage2 = _volume_automation(stage2, [0.82, 0.88, 0.94, 0.98])

    # --- ETAP 3: drums + bass full, subtle melody bed ---
    d3 = _loop_to_length(drums, stage_lengths[2], o)
    b3 = _loop_to_length(bass, stage_lengths[2], o)
    ot3 = _loop_to_length(other, stage_lengths[2], o)
    ot3_lp = _lp_filter(ot3, sr, 2200.0)
    ot3_full = ot3
    other_env = np.linspace(0.0, 1.0, stage_lengths[2], dtype=np.float32)[:, None]
    ot3_mixed = ot3_lp * (1.0 - other_env) + ot3_full * other_env
    other_gain = np.linspace(0.0, 0.22, stage_lengths[2], dtype=np.float32)[:, None]
    stage3 = d3 * 1.00 + b3 * 0.96 + ot3_mixed * other_gain
    stage3 = _volume_automation(stage3, [0.98, 1.00, 1.00, 1.00])

    # --- ETAP 4: handover to source, still drums+bass-led ---
    d4 = _loop_to_length(drums, stage_lengths[3], o)
    b4 = _loop_to_length(bass, stage_lengths[3], o)
    ot4 = _loop_to_length(other, stage_lengths[3], o)
    stage4 = d4 * 1.00 + b4 * 0.98 + ot4 * 0.26
    if include_vocal_hook:
        v4 = _loop_to_length(vocals, stage_lengths[3], o)
        stage4 = stage4 + v4 * 0.08
    stage4 = _volume_automation(stage4, [1.00, 1.00, 1.00, 1.00])

    xf = min(8192, max(1024, part // 8))
    intro = stage1
    intro = _crossfade(intro, stage2, xf)
    intro = _crossfade(intro, stage3, xf)
    intro = _crossfade(intro, stage4, xf)

    intro = _fade(intro, max(512, length // 10), fade_in=True)

    # Dopasuj do dokładnej docelowej długości
    if intro.shape[0] < length:
        intro = np.concatenate([intro, np.zeros((length - intro.shape[0], 2), dtype=np.float32)])
    elif intro.shape[0] > length:
        intro = intro[:length]
    return intro


def _build_outro(
    drums: np.ndarray,
    bass: np.ndarray,
    other: np.ndarray,
    vocals: np.ndarray,
    length: int,
    include_vocal_hook: bool,
    downbeat_offset: int = 0,
    sr: int = 44100,
) -> np.ndarray:
    """Drums+bass-first outro breakdown (4 etapy).

    Priorytet: zostawić DJ-friendly groove na wyjściu i kontrolowanie zdjąć melody.
    """
    if length == 0:
        return np.zeros((0, 2), dtype=np.float32)

    part = max(1, length // 4)
    stage_lengths = [part, part, part, length - (3 * part)]
    o = downbeat_offset

    # --- ETAP 1: handover from source, still groove-led ---
    d1 = _loop_to_length(drums, stage_lengths[0], o)
    b1 = _loop_to_length(bass, stage_lengths[0], o)
    ot1 = _loop_to_length(other, stage_lengths[0], o)
    stage1 = d1 * 1.00 + b1 * 0.98 + ot1 * 0.25
    if include_vocal_hook:
        v1 = _loop_to_length(vocals, stage_lengths[0], o)
        stage1 = stage1 + v1 * 0.08

    # --- ETAP 2: remove melody early, keep drums+bass body ---
    d2 = _loop_to_length(drums, stage_lengths[1], o)
    b2 = _loop_to_length(bass, stage_lengths[1], o)
    ot2 = _loop_to_length(other, stage_lengths[1], o)
    ot2_full = ot2
    ot2_lp = _lp_filter(ot2, sr, 900.0)
    other_env = np.linspace(1.0, 0.0, stage_lengths[1], dtype=np.float32)[:, None]
    ot2_mixed = ot2_full * other_env + ot2_lp * (1.0 - other_env)
    other_gain = np.linspace(0.22, 0.0, stage_lengths[1], dtype=np.float32)[:, None]
    stage2 = d2 * 0.98 + b2 * 0.94 + ot2_mixed * other_gain

    # --- ETAP 3: bass exits, drums stay forward ---
    d3 = _loop_to_length(drums, stage_lengths[2], o)
    b3 = _loop_to_length(bass, stage_lengths[2], o)
    b3_full = b3
    b3_hp = _hp_filter(b3, sr, 320.0)
    bass_env = np.linspace(0.0, 1.0, stage_lengths[2], dtype=np.float32)[:, None]
    b3_mixed = b3_full * (1.0 - bass_env) + b3_hp * bass_env
    bass_gain = np.linspace(0.92, 0.0, stage_lengths[2], dtype=np.float32)[:, None]
    stage3 = d3 * 0.95 + b3_mixed * bass_gain

    # --- ETAP 4: drums-only filtered tail ---
    d4 = _loop_to_length(drums, stage_lengths[3], o)
    d4_full = d4
    d4_lp = _lp_filter(d4, sr, 700.0)
    d4_env = np.linspace(0.0, 1.0, stage_lengths[3], dtype=np.float32)[:, None]
    stage4 = d4_full * (1.0 - d4_env * 0.68) + d4_lp * (d4_env * 0.68)
    stage4 = _volume_automation(stage4, [0.82, 0.70, 0.58, 0.46])

    xf = min(8192, max(1024, part // 8))
    outro = stage1
    outro = _crossfade(outro, stage2, xf)
    outro = _crossfade(outro, stage3, xf)
    outro = _crossfade(outro, stage4, xf)

    outro = _fade(outro, max(512, length // 10), fade_in=False)

    # Dopasuj do dokładnej docelowej długości
    if outro.shape[0] < length:
        outro = np.concatenate([outro, np.zeros((length - outro.shape[0], 2), dtype=np.float32)])
    elif outro.shape[0] > length:
        outro = outro[:length]
    return outro


def _apply_take_variant(
    *,
    take_index: int,
    take_label: str,
    intro: np.ndarray,
    source_mix: np.ndarray,
    outro: np.ndarray,
    sr: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Create audibly distinct takes from the same stem arrangement.

    Previous versions only changed small gain offsets, which disappeared after
    RMS normalization. Here each take gets a different tonal/arrangement bias.
    """
    label = take_label.lower()
    intro_mix = intro.copy()
    source_variant = source_mix.copy()
    outro_mix = outro.copy()

    if take_index == 0 or "original" in label or "faithful" in label:
        # Take 1: Reference — clean sub-bass only, no spectral change
        pass

    elif take_index == 1 or "club" in label or "clean" in label or "drums" in label:
        # Take 2: Punchy/Club — HP at 80 Hz removes sub-bass rumble → tighter, cleaner kick
        # (DJs typically cut sub on the outgoing track anyway during transition)
        intro_mix = _safe_mix(_hp_filter(intro_mix, sr, 80.0))
        source_variant = _safe_mix(_hp_filter(source_variant, sr, 80.0))
        outro_mix = _safe_mix(_hp_filter(outro_mix, sr, 80.0))

    else:
        # Take 3: Warm/Atmospheric — LP at 10 kHz rolls off air and harshness
        # Clearly darker tone: hi-hats softer, no harsh top-end, more "vinyl" feel
        intro_mix = _safe_mix(_lp_filter(intro_mix, sr, 10000.0))
        source_variant = _safe_mix(_lp_filter(source_variant, sr, 10000.0))
        outro_mix = _safe_mix(_lp_filter(outro_mix, sr, 10000.0))

    return intro_mix.astype(np.float32), source_variant.astype(np.float32), outro_mix.astype(np.float32)


def _safe_mix(audio: np.ndarray) -> np.ndarray:
    peak = np.max(np.abs(audio)) if audio.size > 0 else 0.0
    if peak > 0.99:
        audio = audio / (peak + 1e-8) * 0.98
    return audio.astype(np.float32)


def _normalize_to_rms(audio: np.ndarray, target_rms_db: float = -14.0) -> np.ndarray:
    """Normalizacja RMS do zadanego poziomu (w dB, np. -14 dBFS = standard streamingowy).
    Nie przekracza 0 dBFS — limiter na szczycie.
    """
    if audio.size == 0:
        return audio
    rms = float(np.sqrt(np.mean(audio ** 2) + 1e-12))
    target_rms = 10.0 ** (target_rms_db / 20.0)
    gain = target_rms / rms
    # Ogranicz gain aby nie klipowac
    peak = float(np.max(np.abs(audio)))
    if peak * gain > 0.98:
        gain = 0.98 / (peak + 1e-8)
    return (audio * gain).astype(np.float32)


def _ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def _rubberband_path() -> str | None:
    return shutil.which("rubberband")


def _convert_with_ffmpeg(ffmpeg_bin: str, input_path: Path, output_path: Path, args: list[str]) -> tuple[bool, str | None]:
    command = [ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error", "-i", str(input_path), *args, str(output_path)]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=300)
        return True, None
    except subprocess.TimeoutExpired:
        return False, f"FFmpeg conversion timeout: {output_path.name}"
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "unknown FFmpeg error").strip()
        return False, f"FFmpeg conversion failed for {output_path.name}: {detail[:300]}"


def _apply_rubberband_with_cli(
    rubberband_bin: str,
    input_path: Path,
    output_path: Path,
    target_sample_rate: int,
    time_stretch_ratio: float,
    pitch_semitones: float,
) -> tuple[bool, str | None]:
    clamped_tempo = float(np.clip(time_stretch_ratio, 0.5, 2.0))
    semitones = float(np.clip(pitch_semitones, -12.0, 12.0))

    # Native Rubber Band CLI in high-quality mode.
    command = [
        rubberband_bin,
        "--tempo",
        f"{clamped_tempo:.6f}",
        "--pitch",
        f"{semitones:.6f}",
        "--formant",
        "--pitch-hq",
        "--transients",
        "crisp",
        "--window",
        "long",
        str(input_path),
        str(output_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        return False, f"Rubber Band timeout: {output_path.name}"
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "unknown Rubber Band error").strip()
        return False, f"Rubber Band failed for {output_path.name}: {detail[:300]}"

    if target_sample_rate > 0:
        try:
            rb_audio, rb_sr = sf.read(str(output_path), always_2d=True)
            rb_audio = _ensure_stereo(rb_audio.astype(np.float32))
            rb_audio = _resample_stereo(rb_audio, int(rb_sr), int(target_sample_rate))
            sf.write(str(output_path), rb_audio, int(target_sample_rate), subtype="PCM_24")
        except Exception as exc:  # pragma: no cover
            return False, f"Rubber Band post-resample failed: {exc}"

    return True, None


def _extract_essentia_estimates(audio_mono: np.ndarray, sample_rate: int) -> tuple[float, str, float]:
    try:
        essentia_standard = importlib.import_module("essentia.standard")
        key_extractor_factory = getattr(essentia_standard, "KeyExtractor")
        rhythm_extractor_factory = getattr(essentia_standard, "RhythmExtractor2013")
    except Exception as exc:
        raise RuntimeError("Essentia is not installed. Install package 'essentia' for hybrid analysis.") from exc

    rhythm_extractor = rhythm_extractor_factory(method="multifeature")
    bpm, _, _, _, _ = rhythm_extractor(audio_mono)

    key_extractor = key_extractor_factory()
    key, scale, strength = key_extractor(audio_mono)

    mode = "minor" if str(scale).lower().startswith("minor") else "major"
    key_name = f"{key} {mode}"
    key_strength = float(np.clip(float(strength), 0.0, 1.0))
    return float(bpm), key_name, key_strength


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "pro-sidecar"}


@app.get("/serve_file")
def serve_file(path: str) -> FileResponse:
    """Serwuje plik audio z dysku (do odtwarzania w UI przez <audio src>).
    path musi byc absolutna sciezka na serwerze sidecar.
    """
    file_path = Path(path)
    # Resolve to real path (follows symlinks) to prevent symlink bypass attacks
    try:
        resolved = file_path.resolve(strict=True)
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    # Zabezpieczenie — tylko pliki audio w folderze runs/
    try:
        resolved.relative_to(Path.cwd().resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied: path outside working directory")
    mime, _ = mimetypes.guess_type(str(resolved))
    return FileResponse(
        path=resolved,
        media_type=mime or "audio/wav",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


@app.post("/transform_preview", response_model=TransformPreviewResult)
async def transform_preview(
    file: UploadFile = File(...),
    source_bpm: float = Form(...),
    target_bpm: float = Form(...),
    pitch_semitones: float = Form(0.0),
    preview_seconds: float = Form(30.0),
) -> TransformPreviewResult:
    """Generate 30s transformed preview (tempo and pitch independent)."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing source filename")

    rubberband_bin = _rubberband_path()
    if rubberband_bin is None:
        raise HTTPException(status_code=500, detail="Rubber Band CLI not found in PATH (expected command: rubberband)")

    raw_source = await file.read()
    if not raw_source:
        raise HTTPException(status_code=400, detail="Empty source audio")

    src_bpm = max(float(source_bpm), 1.0)
    dst_bpm = max(float(target_bpm), 1.0)
    tempo_ratio = float(np.clip(dst_bpm / src_bpm, 0.5, 2.0))
    semitones = float(np.clip(pitch_semitones, -12.0, 12.0))
    preview_s = float(np.clip(preview_seconds, 5.0, 45.0))

    render_job = uuid4().hex[:12]
    output_dir = Path.cwd() / "runs" / "transforms" / render_job
    output_dir.mkdir(parents=True, exist_ok=True)
    input_path = output_dir / "source_input.wav"
    transformed_path = output_dir / "preview_full.wav"
    preview_wav_path = output_dir / "preview_30s.wav"
    try:
        source_audio, source_sr = sf.read(io.BytesIO(raw_source), always_2d=True)
        source_audio = _ensure_stereo(source_audio.astype(np.float32))
        source_audio = _resample_stereo(source_audio, int(source_sr), 44100)
        sf.write(str(input_path), source_audio, 44100, subtype="PCM_24")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot decode source audio: {exc}") from exc

    ok, err = _apply_rubberband_with_cli(
        rubberband_bin=rubberband_bin,
        input_path=input_path,
        output_path=transformed_path,
        target_sample_rate=44100,
        time_stretch_ratio=tempo_ratio,
        pitch_semitones=semitones,
    )
    if not ok:
        raise HTTPException(status_code=500, detail=err or "Preview transform failed")

    transformed_audio, sr = sf.read(str(transformed_path), always_2d=True)
    max_samples = int(round(preview_s * max(sr, 1)))
    preview_audio = transformed_audio[:max_samples] if max_samples > 0 else transformed_audio
    sf.write(str(preview_wav_path), preview_audio, int(sr), subtype="PCM_24")
    duration_sec = float(preview_audio.shape[0] / max(sr, 1))
    input_path.unlink(missing_ok=True)
    transformed_path.unlink(missing_ok=True)

    return TransformPreviewResult(
        jobId=render_job,
        outputDirectory=str(output_dir),
        previewPath=str(preview_wav_path),
        durationSeconds=duration_sec,
        sampleRate=int(sr),
        warnings=[],
        transformEngine="rubberband-cli-v1",
    )


@app.post("/transform_audio", response_model=TransformAudioResult)
async def transform_audio(
    file: UploadFile = File(...),
    source_bpm: float = Form(...),
    target_bpm: float = Form(...),
    pitch_semitones: float = Form(0.0),
) -> TransformAudioResult:
    """Save full transformed audio (tempo and pitch independent)."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing source filename")

    rubberband_bin = _rubberband_path()
    if rubberband_bin is None:
        raise HTTPException(status_code=500, detail="Rubber Band CLI not found in PATH (expected command: rubberband)")

    ffmpeg_bin = _ffmpeg_path()
    if ffmpeg_bin is None:
        raise HTTPException(status_code=500, detail="FFmpeg not found in PATH")

    raw_source = await file.read()
    if not raw_source:
        raise HTTPException(status_code=400, detail="Empty source audio")

    src_bpm = max(float(source_bpm), 1.0)
    dst_bpm = max(float(target_bpm), 1.0)
    tempo_ratio = float(np.clip(dst_bpm / src_bpm, 0.5, 2.0))
    semitones = float(np.clip(pitch_semitones, -12.0, 12.0))

    render_job = uuid4().hex[:12]
    output_dir = Path.cwd() / "runs" / "transforms" / render_job
    output_dir.mkdir(parents=True, exist_ok=True)
    input_path = output_dir / "source_input.wav"
    wav_path = output_dir / "transform.wav"
    mp3_path = output_dir / "transform.mp3"
    aiff_path = output_dir / "transform.aiff"
    warnings: list[str] = []
    try:
        source_audio, source_sr = sf.read(io.BytesIO(raw_source), always_2d=True)
        source_audio = _ensure_stereo(source_audio.astype(np.float32))
        source_audio = _resample_stereo(source_audio, int(source_sr), 44100)
        sf.write(str(input_path), source_audio, 44100, subtype="PCM_24")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot decode source audio: {exc}") from exc

    ok, err = _apply_rubberband_with_cli(
        rubberband_bin=rubberband_bin,
        input_path=input_path,
        output_path=wav_path,
        target_sample_rate=44100,
        time_stretch_ratio=tempo_ratio,
        pitch_semitones=semitones,
    )
    if not ok:
        raise HTTPException(status_code=500, detail=err or "Transform failed")

    mp3_ok, mp3_error = _convert_with_ffmpeg(
        ffmpeg_bin,
        wav_path,
        mp3_path,
        ["-codec:a", "libmp3lame", "-b:a", "320k", "-ar", "44100"],
    )
    if not mp3_ok:
        warnings.append(mp3_error or "MP3 conversion failed")
        shutil.copy2(wav_path, mp3_path)

    aiff_ok, aiff_error = _convert_with_ffmpeg(
        ffmpeg_bin,
        wav_path,
        aiff_path,
        ["-c:a", "pcm_s24be", "-ar", "44100"],
    )
    if not aiff_ok:
        warnings.append(aiff_error or "AIFF conversion failed")
        shutil.copy2(wav_path, aiff_path)

    transformed_audio, sr = sf.read(str(wav_path), always_2d=True)
    duration_sec = float(transformed_audio.shape[0] / max(sr, 1))
    input_path.unlink(missing_ok=True)

    return TransformAudioResult(
        jobId=render_job,
        outputDirectory=str(output_dir),
        wavPath=str(wav_path),
        mp3Path=str(mp3_path),
        aiffPath=str(aiff_path),
        durationSeconds=duration_sec,
        sampleRate=int(sr),
        warnings=warnings,
        transformEngine="rubberband-cli-v1",
    )


@app.post("/analyze", response_model=ProAnalysisResult)
async def analyze(
    file: UploadFile = File(...),
    analysis_engine: Literal["librosa", "essentia", "hybrid"] = Form("librosa"),
) -> ProAnalysisResult:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        data, sample_rate = sf.read(io.BytesIO(raw), always_2d=True)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=400, detail=f"Cannot decode audio: {exc}") from exc

    mono = np.mean(data, axis=1).astype(np.float32)
    if mono.size < sample_rate * 10:
        raise HTTPException(status_code=400, detail="Audio too short for pro analysis")

    duration_seconds = float(mono.size / sample_rate)

    tempo, beat_frames = librosa.beat.beat_track(y=mono, sr=sample_rate, trim=False)
    bpm_primary = int(round(float(tempo)))

    # Korekcja oktawy BPM — librosa często zwraca 2x lub 0.5x dla muzyki elektronicznej.
    # Zakresy DJ-owe: house 120-135, techno 130-160, trance 125-145, drum&bass 160-180.
    # Clampujemy do sensownego przedziału 60-200 BPM.
    if bpm_primary > 200:
        bpm_primary = int(round(bpm_primary / 2.0))
    elif bpm_primary < 70:
        bpm_primary = int(round(bpm_primary * 2.0))

    onset_env = librosa.onset.onset_strength(y=mono, sr=sample_rate)
    autocorr = librosa.autocorrelate(onset_env)
    min_lag = int((60.0 / 180.0) * (sample_rate / 512.0))
    max_lag = int((60.0 / 70.0) * (sample_rate / 512.0))
    bpm_secondary = bpm_primary
    if max_lag > min_lag and autocorr.size > max_lag:
        lag = int(np.argmax(autocorr[min_lag:max_lag]) + min_lag)
        if lag > 0:
            bpm_secondary = int(round(60.0 / (lag / (sample_rate / 512.0))))
            if bpm_secondary > 200:
                bpm_secondary = int(round(bpm_secondary / 2.0))
            elif bpm_secondary < 70:
                bpm_secondary = int(round(bpm_secondary * 2.0))

    bpm_agreement = abs(bpm_primary - bpm_secondary)
    bpm_confidence = max(0.0, min(1.0, 0.88 - bpm_agreement * 0.08))

    beat_times = librosa.frames_to_time(beat_frames, sr=sample_rate).astype(float).tolist()

    # --- Robust multi-window key detection ---
    key_name, key_confidence = _key_vote_multi_window(mono, sample_rate)
    camelot = _to_camelot(key_name)

    warnings: list[str] = []
    essentia_bpm: float | None = None
    essentia_key: str | None = None
    essentia_key_confidence: float | None = None

    if analysis_engine in ("essentia", "hybrid"):
        try:
            essentia_bpm, essentia_key, essentia_key_confidence = _extract_essentia_estimates(mono, sample_rate)
        except RuntimeError as exc:
            if analysis_engine == "essentia":
                raise HTTPException(status_code=500, detail=str(exc)) from exc
            warnings.append(f"Essentia unavailable, fallback to librosa: {exc}")

    if analysis_engine == "essentia" and essentia_bpm is not None and essentia_key is not None:
        bpm_primary = int(round(float(essentia_bpm)))
        bpm_secondary = bpm_primary
        bpm_confidence = max(0.0, min(1.0, 0.82 + 0.18 * float(essentia_key_confidence or 0.5)))
        key_name = essentia_key
        key_confidence = float(essentia_key_confidence or key_confidence)
        camelot = _to_camelot(key_name)
    elif analysis_engine == "hybrid" and essentia_bpm is not None and essentia_key is not None:
        bpm_primary = int(round((float(bpm_primary) * 0.6) + (float(essentia_bpm) * 0.4)))
        bpm_secondary = int(round(float(essentia_bpm)))
        bpm_delta = abs(bpm_primary - bpm_secondary)
        bpm_confidence = float(np.clip((bpm_confidence * 0.65) + max(0.0, 0.35 - bpm_delta * 0.05), 0.0, 1.0))
        # Triangulacja klucza: jezeli essentia bardziej pewna, uzyj essentia; inaczej zachowaj wynik multi-window
        if float(essentia_key_confidence or 0.0) > key_confidence + 0.08:
            key_name = essentia_key
            key_confidence = float(essentia_key_confidence)
            camelot = _to_camelot(key_name)

    # --- Refined downbeat phase detection (sub-bass + onset combined) ---
    best_phase, downbeat_conf = _detect_downbeat_phase_refined(mono, sample_rate, beat_frames, beat_times)

    # Per-beat energy (do phrase detection)
    _, percussive = librosa.effects.hpss(mono)
    low_band = librosa.feature.rms(y=librosa.effects.preemphasis(percussive), frame_length=2048, hop_length=512)[0]
    beat_energy = []
    for frame in beat_frames:
        idx = int(np.clip(frame, 0, low_band.size - 1))
        beat_energy.append(float(low_band[idx]))

    if not beat_energy:
        raise HTTPException(status_code=400, detail="Failed to detect beat grid")

    # beat_interval musi być spójny z corrected bpm_primary
    beat_interval = 60.0 / max(bpm_primary, 1)

    # Phrase size candidate by section contrast
    phrase_candidates = [4, 8, 16]
    best_phrase = 8
    best_phrase_score = -1.0
    second_phrase_score = -1.0
    for candidate in phrase_candidates:
        window = candidate * 4
        if len(beat_energy) < window * 2:
            continue
        contrasts: list[float] = []
        for i in range(window, len(beat_energy) - window, window):
            prev = np.mean(beat_energy[i - window : i])
            nxt = np.mean(beat_energy[i : i + window])
            contrasts.append(float(abs(nxt - prev)))
        if not contrasts:
            continue
        score = float(np.mean(contrasts))
        if score > best_phrase_score:
            second_phrase_score = best_phrase_score
            best_phrase_score = score
            best_phrase = candidate
        elif score > second_phrase_score:
            second_phrase_score = score

    phrase_confidence = max(0.0, min(1.0, 0.55 + (best_phrase_score - max(second_phrase_score, 0.0)) * 25))

    downbeat_times: list[float] = []
    phrase_boundaries: list[float] = []
    markers: list[TimelineMarker] = []
    sections: list[StructureSection] = []

    beats_per_phrase = best_phrase * 4
    for i, t in enumerate(beat_times):
        rel = i - best_phase
        aligned = rel >= 0
        beat_in_bar = (rel % 4 + 4) % 4 + 1
        bar_index = rel // 4 + 1 if aligned else 0
        phrase_index = ((bar_index - 1) // best_phrase) + 1 if bar_index > 0 else 0

        markers.append(
            TimelineMarker(
                type="beat",
                seconds=float(t),
                beatIndex=i + 1,
                barIndex=bar_index,
                beatInBar=beat_in_bar,
                phraseIndex=phrase_index,
            )
        )

        if aligned and rel % 4 == 0:
            downbeat_times.append(float(t))
            markers.append(
                TimelineMarker(
                    type="downbeat",
                    seconds=float(t),
                    beatIndex=i + 1,
                    barIndex=bar_index,
                    beatInBar=1,
                    phraseIndex=phrase_index,
                )
            )
            if (bar_index - 1) % best_phrase == 0:
                phrase_boundaries.append(float(t))
                markers.append(
                    TimelineMarker(
                        type="phrase_start",
                        seconds=float(t),
                        beatIndex=i + 1,
                        barIndex=bar_index,
                        beatInBar=1,
                        phraseIndex=phrase_index,
                    )
                )

    for p_idx in range(len(phrase_boundaries) - 1):
        s = phrase_boundaries[p_idx]
        e = phrase_boundaries[p_idx + 1]
        mask = [(bt >= s and bt < e) for bt in beat_times]
        vals = [beat_energy[i] for i, keep in enumerate(mask) if keep]
        energy = float(np.mean(vals)) if vals else 0.0
        sections.append(
            StructureSection(
                startSeconds=float(s),
                endSeconds=float(e),
                bars=best_phrase,
                energy=_energy_label(float(np.clip(energy / max(np.max(beat_energy), 1e-8), 0.0, 1.0))),
            )
        )

    gates = [
        AnalysisGate(
            id="bpm_consensus",
            label="BPM consensus confidence",
            value=bpm_confidence,
            threshold=0.72,
            passed=bpm_confidence >= 0.72,
        ),
        AnalysisGate(
            id="key_confidence",
            label="Harmonic key confidence",
            value=key_confidence,
            threshold=0.65,
            passed=key_confidence >= 0.65,
        ),
        AnalysisGate(
            id="phrase_confidence",
            label="Phrase segmentation confidence",
            value=phrase_confidence,
            threshold=0.70,
            passed=phrase_confidence >= 0.70,
        ),
        AnalysisGate(
            id="downbeat_confidence",
            label="Downbeat lock confidence",
            value=downbeat_conf,
            threshold=0.70,
            passed=downbeat_conf >= 0.70,
        ),
        AnalysisGate(
            id="structure_density",
            label="Minimum phrase sections",
            value=min(1.0, len(sections) / 6.0),
            threshold=0.50,
            passed=len(sections) >= 3,
        ),
    ]

    overall_score = float(np.mean([gate.value for gate in gates])) if gates else 0.0
    production_ready = all(g.passed for g in gates)

    if not production_ready:
        for gate in gates:
            if not gate.passed:
                warnings.append(
                    f"Quality gate failed: {gate.label} ({round(gate.value * 100)}% < {round(gate.threshold * 100)}%)."
                )

    result = ProAnalysisResult(
        bpm=bpm_primary,
        bpmSecondary=bpm_secondary,
        bpmConfidence=float(np.clip(bpm_confidence, 0.0, 1.0)),
        musicalKey=key_name,
        camelotKey=camelot,
        keyConfidence=float(np.clip(key_confidence, 0.0, 1.0)),
        phraseBars=int(best_phrase),
        phraseConfidence=float(np.clip(phrase_confidence, 0.0, 1.0)),
        beatIntervalSeconds=float(beat_interval),
        beatCount=len(beat_times),
        downbeatOffsetSeconds=float(beat_times[best_phase] if len(beat_times) > best_phase else 0.0),
        downbeatConfidence=float(np.clip(downbeat_conf, 0.0, 1.0)),
        structureSections=sections,
        beatTimestampsSeconds=[float(x) for x in beat_times],
        downbeatTimestampsSeconds=downbeat_times,
        phraseBoundarySeconds=phrase_boundaries,
        timelineMarkers=markers,
        overallScore=float(np.clip(overall_score, 0.0, 1.0)),
        isProductionReady=production_ready,
        gates=gates,
        durationSeconds=duration_seconds,
        sampleRate=int(sample_rate),
        warnings=warnings,
        analyzerEngine="pro-sidecar",
    )

    return result


@app.post("/generate_stable", response_model=StableAudioGenerateResult)
async def generate_stable(
    prompt: str = Form(...),
    duration_seconds: float = Form(16.0),
    bpm: float = Form(120.0),
    musical_key: str = Form("A minor"),
) -> StableAudioGenerateResult:
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt must not be empty")

    job_id = uuid4().hex[:12]
    output_dir = Path.cwd() / "runs" / "generations" / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "stable_audio.wav"

    try:
        sample_rate, duration, warnings = _generate_stable_to_file(
            prompt_text=prompt,
            clip_duration_seconds=duration_seconds,
            clip_bpm=bpm,
            clip_key=musical_key,
            destination_path=output_path,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return StableAudioGenerateResult(
        jobId=job_id,
        outputPath=str(output_path),
        sampleRate=int(sample_rate),
        durationSeconds=duration,
        prompt=prompt,
        warnings=warnings,
        generationEngine="stable-audio-local",
    )


@app.post("/separate", response_model=StemSeparationResult)
async def separate(file: UploadFile = File(...)) -> StemSeparationResult:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")

    base_name = Path(file.filename).stem
    safe_name = "".join(character if character.isalnum() else "_" for character in base_name)
    job_id = uuid4().hex[:12]
    _set_progress(job_id, 0, 4, "Uploading audio...")

    with tempfile.TemporaryDirectory(prefix="djextender_sidecar_") as temp_root:
        temp_root_path = Path(temp_root)
        input_path = temp_root_path / f"{safe_name}.wav"
        output_root = temp_root_path / "demucs_out"
        output_root.mkdir(parents=True, exist_ok=True)
        input_path.write_bytes(raw)
        _set_progress(job_id, 1, 4, "Running Demucs AI stem separation (1–3 min)...")

        command = [
            sys.executable,
            "-m",
            "demucs.separate",
            "--name",
            "htdemucs",
            "--out",
            str(output_root),
            str(input_path),
        ]

        try:
            await asyncio.to_thread(
                subprocess.run,
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=1800,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail="Python executable not found for Demucs") from exc
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=500, detail="Demucs separation timed out") from exc
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr[-4000:] if exc.stderr else "Unknown Demucs error"
            raise HTTPException(status_code=500, detail=f"Demucs failed: {stderr}") from exc

        _set_progress(job_id, 2, 4, "Saving stems...")
        demucs_folder = output_root / "htdemucs" / input_path.stem
        if not demucs_folder.exists():
            raise HTTPException(status_code=500, detail="Demucs output folder missing")

        persistent_root = Path.cwd() / "runs" / "stems" / job_id
        persistent_root.mkdir(parents=True, exist_ok=True)

        stems: list[StemFile] = []
        warnings: list[str] = []
        for stem_name in ("drums", "bass", "other", "vocals"):
            source_path = demucs_folder / f"{stem_name}.wav"
            target_path = persistent_root / f"{stem_name}.wav"
            if source_path.exists():
                shutil.copy2(source_path, target_path)
                size = target_path.stat().st_size
                stems.append(
                    StemFile(
                        stem=stem_name,
                        path=str(target_path),
                        exists=True,
                        sizeBytes=size,
                    )
                )
            else:
                warnings.append(f"Missing stem file: {stem_name}.wav")
                stems.append(
                    StemFile(
                        stem=stem_name,
                        path=str(target_path),
                        exists=False,
                        sizeBytes=0,
                    )
                )

    is_ready = all(stem.exists for stem in stems)
    if not is_ready:
        warnings.append("Stem package incomplete. Block render until all required stems are present.")

    _set_progress(job_id, 4, 4, "Stem separation complete", done=True)

    return StemSeparationResult(
        jobId=job_id,
        model="htdemucs",
        outputDirectory=str(Path.cwd() / "runs" / "stems" / job_id),
        stems=stems,
        isReady=is_ready,
        warnings=warnings,
        stemEngine="demucs-sidecar",
    )


@app.post("/render_extended", response_model=RenderStartResult, status_code=202)
async def render_extended(
    file: UploadFile = File(...),
    metadata: str = Form(...),
) -> RenderStartResult:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing source filename")

    try:
        payload = json.loads(metadata)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid metadata JSON: {exc}") from exc

    raw_source = await file.read()
    if not raw_source:
        raise HTTPException(status_code=400, detail="Empty source audio")

    render_job = uuid4().hex[:12]
    _set_progress(render_job, 0, 1, "Queued...", done=False)

    # Uruchamiamy ciężki render w osobnym wątku — event loop pozostaje wolny
    asyncio.get_event_loop().run_in_executor(
        None, _run_render_extended_blocking, render_job, raw_source, payload
    )

    return RenderStartResult(jobId=render_job, status="started")


# ---------------------------------------------------------------------------
# Synchroniczna funkcja wykonywana w osobnym wątku (asyncio executor).
# NIE może używać `await` ani FastAPI HTTP exceptions — zgłasza wyjątki Python.
# ---------------------------------------------------------------------------
_AI_STAGE_TIMEOUT_SECONDS = 180  # watchdog: maks. czas na jeden etap AI


def _generate_stable_with_watchdog(
    prompt_text: str,
    clip_duration_seconds: float,
    destination_path: "Path",
    job_id: str,
    step_label: str,
) -> tuple[int, float, list[str]]:
    """Wrapper wywołujący `_generate_stable_to_file` z watchdogiem.
    Jeśli operacja przekroczy _AI_STAGE_TIMEOUT_SECONDS → podnosi TimeoutError."""
    result_box: list = []
    exc_box: list = []

    def _target():
        try:
            result_box.append(_generate_stable_to_file(
                prompt_text=prompt_text,
                clip_duration_seconds=clip_duration_seconds,
                destination_path=destination_path,
            ))
        except Exception as e:
            exc_box.append(e)

    t = threading.Thread(target=_target, daemon=True)
    deadline = time.time() + _AI_STAGE_TIMEOUT_SECONDS
    t.start()
    # Poll co 5s, aktualizuj heartbeat żeby frontend widział aktywność
    while t.is_alive():
        remaining = deadline - time.time()
        if remaining <= 0:
            # Wątek AI nadal żyje po timeoucie — oznaczamy jako błąd w progress
            _set_progress(job_id, -1, 1, f"TIMEOUT: {step_label} (>{_AI_STAGE_TIMEOUT_SECONDS}s)", error=f"AI stage timeout: {step_label}")
            raise TimeoutError(f"AI stage '{step_label}' exceeded {_AI_STAGE_TIMEOUT_SECONDS}s watchdog limit")
        t.join(timeout=5.0)
        # Odśwież heartbeat żeby pokazać że jesteśmy aktywni
        entry = _job_progress.get(job_id)
        if entry:
            _job_progress[job_id] = {**entry, "last_heartbeat": time.time()}

    if exc_box:
        raise exc_box[0]
    return result_box[0]


def _run_render_extended_blocking(render_job: str, raw_source: bytes, payload: dict) -> None:
    """Blokująca funkcja renderowania — uruchamiana w asyncio.to_thread / executor."""
    _render_logger = logging.getLogger("djextender.render")
    try:
        stem_output = payload.get("stemPackage", {}).get("outputDirectory")
        plan = payload.get("plan", {})
        request = payload.get("request", {})
        takes_payload = plan.get("takes", [])

        request_hf_token = str(request.get("huggingfaceToken") or "").strip()
        if request_hf_token:
            os.environ["HUGGINGFACE_TOKEN"] = request_hf_token

        if not stem_output:
            _set_progress(render_job, -1, 1, "Error: missing stem package directory", error="Missing stem package output directory")
            return

        stem_dir = Path(stem_output)
        if not stem_dir.exists():
            _set_progress(render_job, -1, 1, "Error: stem directory does not exist", error=f"Stem dir not found: {stem_dir}")
            return

        try:
            source_audio, source_sr = sf.read(io.BytesIO(raw_source), always_2d=True)
        except Exception as exc:
            _set_progress(render_job, -1, 1, f"Error: cannot decode audio: {exc}", error=str(exc))
            return

        source_audio = _ensure_stereo(source_audio.astype(np.float32))

        def load_stem(name: str) -> np.ndarray:
            path = stem_dir / f"{name}.wav"
            if not path.exists():
                raise FileNotFoundError(f"Missing stem file: {path}")
            audio, sr = sf.read(path, always_2d=True)
            audio = _ensure_stereo(audio.astype(np.float32))
            return _resample_stereo(audio, sr, source_sr)

        try:
            drums = load_stem("drums")
            bass = load_stem("bass")
            other = load_stem("other")
            vocals = load_stem("vocals")
        except FileNotFoundError as exc:
            _set_progress(render_job, -1, 1, f"Error: {exc}", error=str(exc))
            return

        bpm = float(request.get("bpm") or 120.0)
        intro_bars = int(plan.get("quantizedIntroBars") or 0)
        outro_bars = int(plan.get("quantizedOutroBars") or 0)
        operation_mode = str(request.get("operationMode") or "intro_outro")
        vocal_policy = str(request.get("vocalHandling") or "no_vocals")

        _render_logger.info(
            "[render_extended] bpm=%.2f intro_bars=%d outro_bars=%d operation_mode=%s "
            "source_shape=%s source_sr=%d drums=%s bass=%s other=%s vocals=%s",
            bpm, intro_bars, outro_bars, operation_mode,
            source_audio.shape, source_sr,
            drums.shape, bass.shape, other.shape, vocals.shape,
        )

        bars_to_samples = lambda bars: int(round((240.0 / max(bpm, 1.0)) * bars * source_sr))
        intro_samples = bars_to_samples(intro_bars)
        outro_samples = bars_to_samples(outro_bars)

        include_vocal_hook = vocal_policy == "keep_short_hook"
        target_sample_rate = 44100
        time_stretch_ratio = float(request.get("timeStretchRatio") or 1.0)
        pitch_semitones = float(request.get("pitchSemitones") or 0.0)
        style_preset = str(request.get("stylePreset") or "close_to_original")

        raw_ai_flag = request.get("useAiGeneratedIntroOutro", False)
        use_ai_intro_outro = (
            raw_ai_flag.lower() in ("1", "true", "yes", "on")
            if isinstance(raw_ai_flag, str)
            else bool(raw_ai_flag)
        )

        downbeat_offset_sec = float(request.get("downbeatOffsetSeconds") or 0.0)
        downbeat_offset_samples = int(round(downbeat_offset_sec * source_sr))

        source_aligned = source_audio
        if operation_mode in ("intro", "intro_outro") and 0 < downbeat_offset_samples < source_audio.shape[0]:
            source_aligned = np.concatenate(
                [source_audio[downbeat_offset_samples:], source_audio[:downbeat_offset_samples]],
                axis=0,
            ).astype(np.float32)

        output_dir = Path.cwd() / "runs" / "renders" / render_job
        output_dir.mkdir(parents=True, exist_ok=True)

        warnings: list[str] = []
        rendered_takes: list[RenderedTake] = []
        ffmpeg_bin = _ffmpeg_path()
        rubberband_bin = _rubberband_path()
        if ffmpeg_bin is None:
            warnings.append("FFmpeg not found in PATH. MP3 and AIFF exports will fallback to WAV copies.")
        if (abs(time_stretch_ratio - 1.0) > 1e-4 or abs(pitch_semitones) > 1e-4) and rubberband_bin is None:
            _set_progress(render_job, -1, 1, "Error: Rubber Band CLI not found", error="Rubber Band CLI not found in PATH")
            return

        take_count = len(takes_payload) if takes_payload else int(request.get("takeCount") or 1)
        take_count = max(1, min(5, take_count))

        wants_intro = operation_mode in ("intro", "intro_outro") and intro_samples > 0
        wants_outro = operation_mode in ("outro", "intro_outro") and outro_samples > 0
        ai_intro_step = use_ai_intro_outro and wants_intro
        ai_outro_step = use_ai_intro_outro and wants_outro
        ai_steps = int(ai_intro_step) + int(ai_outro_step)

        render_start_step = 2 + ai_steps
        total_steps = render_start_step + take_count
        _set_progress(render_job, 0, total_steps, "Preparing stems...")

        _set_progress(render_job, 1, total_steps, "Building intro...")
        intro = (
            _build_intro(drums, bass, other, vocals, intro_samples, include_vocal_hook, downbeat_offset_samples, sr=source_sr)
            if wants_intro
            else np.zeros((0, 2), dtype=np.float32)
        )
        _set_progress(render_job, 2, total_steps, "Building outro...")
        outro = (
            _build_outro(drums, bass, other, vocals, outro_samples, include_vocal_hook, downbeat_offset_samples, sr=source_sr)
            if wants_outro
            else np.zeros((0, 2), dtype=np.float32)
        )

        step_cursor = 2
        if use_ai_intro_outro:
            key_label = str(request.get("musicalKey") or "A minor")
            camelot_label = str(request.get("camelotKey") or "")
            ai_dir = output_dir / "ai_layers"
            ai_dir.mkdir(parents=True, exist_ok=True)

            if ai_intro_step:
                step_cursor += 1
                _set_progress(render_job, step_cursor, total_steps, f"Generating AI intro layer (Stable Audio, max {_AI_STAGE_TIMEOUT_SECONDS}s)...")
                intro_duration_s = max(4.0, min(30.0, intro_samples / max(source_sr, 1)))
                intro_prompt = _build_ai_prompt(
                    operation="intro",
                    bpm=bpm,
                    musical_key=key_label,
                    camelot_key=camelot_label,
                    style_preset=style_preset,
                    duration_s=intro_duration_s,
                )
                logger.info("AI intro prompt: %s", intro_prompt)
                try:
                    intro_ai_path = ai_dir / "intro_ai.wav"
                    ai_sr, _, ai_warnings = _generate_stable_with_watchdog(
                        prompt_text=intro_prompt,
                        clip_duration_seconds=intro_duration_s,
                        destination_path=intro_ai_path,
                        job_id=render_job,
                        step_label="AI intro",
                    )
                    warnings.extend(ai_warnings)
                    ai_intro, _ = sf.read(intro_ai_path, always_2d=True)
                    ai_intro = _ensure_stereo(ai_intro.astype(np.float32))
                    ai_intro = _resample_stereo(ai_intro, ai_sr, source_sr)
                    ai_intro = _loop_to_length(ai_intro, intro.shape[0], 0)
                    intro = _safe_mix(intro * 0.70 + ai_intro * 0.30)
                except (TimeoutError, Exception) as exc:
                    warnings.append(f"AI intro generation unavailable, fallback to deterministic intro: {exc}")
                    # Reset progress label after watchdog clears it
                    _set_progress(render_job, step_cursor, total_steps, "Fallback: using deterministic intro (AI timed out)")

            if ai_outro_step:
                step_cursor += 1
                _set_progress(render_job, step_cursor, total_steps, f"Generating AI outro layer (Stable Audio, max {_AI_STAGE_TIMEOUT_SECONDS}s)...")
                outro_duration_s = max(4.0, min(30.0, outro_samples / max(source_sr, 1)))
                outro_prompt = _build_ai_prompt(
                    operation="outro",
                    bpm=bpm,
                    musical_key=key_label,
                    camelot_key=camelot_label,
                    style_preset=style_preset,
                    duration_s=outro_duration_s,
                )
                logger.info("AI outro prompt: %s", outro_prompt)
                try:
                    outro_ai_path = ai_dir / "outro_ai.wav"
                    ai_sr, _, ai_warnings = _generate_stable_with_watchdog(
                        prompt_text=outro_prompt,
                        clip_duration_seconds=outro_duration_s,
                        destination_path=outro_ai_path,
                        job_id=render_job,
                        step_label="AI outro",
                    )
                    warnings.extend(ai_warnings)
                    ai_outro, _ = sf.read(outro_ai_path, always_2d=True)
                    ai_outro = _ensure_stereo(ai_outro.astype(np.float32))
                    ai_outro = _resample_stereo(ai_outro, ai_sr, source_sr)
                    ai_outro = _loop_to_length(ai_outro, outro.shape[0], 0)
                    outro = _safe_mix(outro * 0.72 + ai_outro * 0.28)
                except (TimeoutError, Exception) as exc:
                    warnings.append(f"AI outro generation unavailable, fallback to deterministic outro: {exc}")
                    _set_progress(render_job, step_cursor, total_steps, "Fallback: using deterministic outro (AI timed out)")

        bar_samples = bars_to_samples(1)
        cf_samples = max(2048, min(bar_samples, int(source_sr * 1.5)))

        for take_index in range(take_count):
            _set_progress(render_job, render_start_step + take_index + 1, total_steps, f"Rendering take {take_index + 1}/{take_count}...")
            take_payload = takes_payload[take_index] if take_index < len(takes_payload) else {}
            take_label = str(take_payload.get("label") or f"Take {take_index + 1}")
            variation_focus = str(take_payload.get("variationFocus") or "")
            intro_mix, source_mix, outro_mix = _apply_take_variant(
                take_index=take_index,
                take_label=f"{take_label} {variation_focus}",
                intro=intro,
                source_mix=source_aligned,
                outro=outro,
                sr=source_sr,
            )

            if intro_mix.shape[0] > 0 and source_mix.shape[0] > 0:
                combined = _crossfade(intro_mix, source_mix, cf_samples)
            else:
                combined = np.concatenate([intro_mix, source_mix], axis=0)

            if outro_mix.shape[0] > 0 and combined.shape[0] > 0:
                rendered = _crossfade(combined, outro_mix, cf_samples)
            else:
                rendered = np.concatenate([combined, outro_mix], axis=0)
            rendered = _safe_mix(rendered)
            rendered = _normalize_to_rms(rendered, target_rms_db=-14.0)
            rendered = _resample_stereo(rendered, source_sr, target_sample_rate)

            _render_logger.info(
                "[render_extended] take=%d intro_shape=%s source_shape=%s outro_shape=%s rendered_shape=%s (%.2fs)",
                take_index + 1, intro_mix.shape, source_mix.shape, outro_mix.shape,
                rendered.shape, rendered.shape[0] / target_sample_rate,
            )

            wav_path = output_dir / f"take_{take_index + 1}.wav"
            mp3_path = output_dir / f"take_{take_index + 1}.mp3"
            aiff_path = output_dir / f"take_{take_index + 1}.aiff"

            sf.write(wav_path, rendered, target_sample_rate, subtype="PCM_24")

            master_wav_path = wav_path
            if rubberband_bin is not None and (abs(time_stretch_ratio - 1.0) > 1e-4 or abs(pitch_semitones) > 1e-4):
                processed_path = output_dir / f"take_{take_index + 1}_post.wav"
                post_ok, post_error = _apply_rubberband_with_cli(
                    rubberband_bin=rubberband_bin,
                    input_path=wav_path,
                    output_path=processed_path,
                    target_sample_rate=target_sample_rate,
                    time_stretch_ratio=time_stretch_ratio,
                    pitch_semitones=pitch_semitones,
                )
                if post_ok:
                    master_wav_path = processed_path
                    wav_path.unlink(missing_ok=True)
                    master_wav_path.replace(wav_path)
                else:
                    warnings.append(post_error or f"Rubber Band post failed for take {take_index + 1}")

            if ffmpeg_bin is not None:
                mp3_ok, mp3_error = _convert_with_ffmpeg(
                    ffmpeg_bin,
                    wav_path,
                    mp3_path,
                    ["-codec:a", "libmp3lame", "-b:a", "320k", "-ar", str(target_sample_rate)],
                )
                if not mp3_ok:
                    warnings.append(mp3_error or f"MP3 conversion failed for take {take_index + 1}")
                    shutil.copy2(wav_path, mp3_path)

                aiff_ok, aiff_error = _convert_with_ffmpeg(
                    ffmpeg_bin,
                    wav_path,
                    aiff_path,
                    ["-c:a", "pcm_s24be", "-ar", str(target_sample_rate)],
                )
                if not aiff_ok:
                    warnings.append(aiff_error or f"AIFF conversion failed for take {take_index + 1}")
                    shutil.copy2(wav_path, aiff_path)
            else:
                shutil.copy2(wav_path, mp3_path)
                shutil.copy2(wav_path, aiff_path)

            rendered_takes.append(
                RenderedTake(
                    takeIndex=take_index + 1,
                    label=take_label,
                    outputPath=str(wav_path),
                    wavPath=str(wav_path),
                    mp3Path=str(mp3_path),
                    aiffPath=str(aiff_path),
                    durationSeconds=float(rendered.shape[0] / target_sample_rate),
                    sampleRate=int(target_sample_rate),
                )
            )

        if take_count < 3:
            warnings.append("Professional workflow expects 3 takes; current render produced fewer variants.")

        result = RenderExtendedResult(
            jobId=render_job,
            outputDirectory=str(output_dir),
            takes=rendered_takes,
            warnings=warnings,
            renderEngine="deterministic-sidecar-v1",
        )
        # Zapisujemy wynik do cache — frontend pobierze via /render_result/{jobId}
        _job_results[render_job] = result.model_dump()
        _set_progress(render_job, total_steps, total_steps, "Done", done=True)

    except Exception as exc:
        _render_logger.exception("[render_extended] Unhandled error in background render job %s", render_job)
        _set_progress(render_job, -1, 1, f"Error: {exc}", error=str(exc))


async def qa_render(
    wav_path: str = Form(...),
    expected_bpm: float = Form(...),
    expected_bars: int = Form(...),
    intro_bars: int = Form(0),
    outro_bars: int = Form(0),
) -> QARenderResult:
    """
    Automatyczne QA wygenerowanego WAV.
    Sprawdza: dlugosc vs oczekiwana, BPM drift, RMS/peak level, klipping,
    junction glitch (pop/click na granicach intro/outro).
    Zwraca score [0..1] i listę bramek jakości.
    """
    p = Path(wav_path)
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {wav_path}")

    qa_warnings: list[str] = []

    audio, sr = sf.read(str(p), always_2d=True)
    mono = np.mean(audio, axis=1).astype(np.float32)
    duration_sec = float(mono.size / sr)

    # --- Oczekiwana długość ---
    beat_interval = 60.0 / max(expected_bpm, 1.0)
    bar_duration = beat_interval * 4
    expected_duration = bar_duration * expected_bars
    duration_delta = abs(duration_sec - expected_duration)
    bar_count_measured = duration_sec / max(bar_duration, 0.001)
    bar_count_error = abs(bar_count_measured - expected_bars)

    # --- BPM pomiaru — tylko z sekcji oryginalnej, z marginesem od przejść ---
    # Mierzenie blisko junctionów bywa niestabilne, dlatego omijamy strefy crossfade.
    original_bars = expected_bars - intro_bars - outro_bars
    guard_bars = 1.0 if original_bars >= 4 else 0.5
    if original_bars > 0 and intro_bars > 0:
        # Wytnij sekcję oryginalną ze środka rendera, z guard-zone po obu stronach.
        intro_start_sample = int(round(bar_duration * (intro_bars + guard_bars) * sr))
        original_end_sample = int(round(bar_duration * (intro_bars + original_bars - guard_bars) * sr))
        intro_start_sample = min(intro_start_sample, max(0, mono.size - 1))
        original_end_sample = min(original_end_sample, mono.size)
        bpm_section = mono[intro_start_sample:original_end_sample] if original_end_sample > intro_start_sample else mono
    else:
        bpm_section = mono

    # Użyj przynajmniej 5 sekund do pomiaru BPM
    min_bpm_samples = int(5.0 * sr)
    if bpm_section.size < min_bpm_samples:
        bpm_section = mono  # fallback: cały plik

    tempo_arr, _ = librosa.beat.beat_track(
        y=bpm_section,
        sr=sr,
        start_bpm=float(expected_bpm),
        tightness=220,
        trim=False,
    )
    bpm_measured = float(np.squeeze(tempo_arr)) if np.ndim(tempo_arr) == 0 else float(tempo_arr[0])

    # Korekcja harmoniczna — librosa może zwrócić tempo harmoniczne (½x, 2x, ¾x, 4/3x).
    harmonic_factors = (1.0, 2.0, 0.5, 1.5, 2.0 / 3.0, 0.75, 4.0 / 3.0)
    bpm_measured = min((bpm_measured * factor for factor in harmonic_factors), key=lambda v: abs(v - expected_bpm))
    bpm_drift_pct = abs(bpm_measured - expected_bpm) / max(expected_bpm, 1.0) * 100.0

    # --- Poziomy ---
    rms = float(np.sqrt(np.mean(mono ** 2) + 1e-12))
    rms_db = float(20.0 * np.log10(rms + 1e-12))
    peak = float(np.max(np.abs(mono)))
    peak_db = float(20.0 * np.log10(peak + 1e-12))
    has_clipping = peak >= 0.99

    # --- Junction glitch score ---
    # Sprawdz sample-okna na granicy intro/original i original/outro
    glitch_score = 0.0
    window_ms = 24  # ms po każdej stronie junction
    window_samples = int(window_ms * sr / 1000)
    junction_points: list[int] = []
    if intro_bars > 0:
        intro_samples = int(round(bar_duration * intro_bars * sr))
        junction_points.append(intro_samples)
    if outro_bars > 0:
        original_bars = expected_bars - intro_bars - outro_bars
        original_samples = int(round(bar_duration * original_bars * sr))
        outro_start = int(round(bar_duration * intro_bars * sr)) + original_samples
        junction_points.append(outro_start)

    junction_scores: list[float] = []
    for jct in junction_points:
        left_lo = max(0, jct - window_samples)
        left_hi = min(mono.size, jct)
        right_lo = min(mono.size, jct)
        right_hi = min(mono.size, jct + window_samples)
        if left_hi <= left_lo or right_hi <= right_lo:
            continue

        left = mono[left_lo:left_hi]
        right = mono[right_lo:right_hi]
        if left.size == 0 or right.size == 0:
            continue

        # Click metric: direct sample jump on boundary normalized by local RMS.
        click_step = abs(float(right[0]) - float(left[-1]))
        local_window = np.concatenate([left, right], axis=0)
        local_rms = float(np.sqrt(np.mean(local_window.astype(np.float64) ** 2) + 1e-12))
        click_ratio = click_step / max(local_rms, 1e-6)

        # Optional loudness asymmetry near the seam.
        left_rms = float(np.sqrt(np.mean(left.astype(np.float64) ** 2) + 1e-12))
        right_rms = float(np.sqrt(np.mean(right.astype(np.float64) ** 2) + 1e-12))
        asym_ratio = abs(left_rms - right_rms) / max(local_rms, 1e-6)

        seam_ratio = 0.75 * click_ratio + 0.25 * asym_ratio
        seam_score = float(np.clip(seam_ratio / 0.6, 0.0, 1.0))
        junction_scores.append(seam_score)
        if seam_ratio > 0.32:
            qa_warnings.append(f"Potential junction glitch at {jct / sr:.2f}s (seam={seam_ratio:.3f})")

    glitch_score = float(np.mean(junction_scores)) if junction_scores else 0.0

    # --- Bramki QA ---
    duration_ok = duration_delta <= bar_duration * 2.0  # maks 2 bary rozbieżności
    bar_error_ok = bar_count_error <= 2.0
    bpm_ok = bpm_drift_pct <= 6.0
    level_ok = -16.0 <= rms_db <= -12.0  # -14 ±2 dBFS
    peak_ok = peak_db <= -0.3
    junction_ok = glitch_score <= 0.45

    gates = [
        QAGate(id="duration", label="Duration accuracy", passed=duration_ok,
             value=round(duration_delta, 3), threshold=round(bar_duration * 2.0, 3), unit="s"),
        QAGate(id="bar_count", label="Bar count error", passed=bar_error_ok,
             value=round(bar_count_error, 3), threshold=2.0, unit="bars"),
        QAGate(id="bpm_drift", label="BPM drift", passed=bpm_ok,
             value=round(bpm_drift_pct, 2), threshold=6.0, unit="%"),
        QAGate(id="rms_level", label="RMS level (-14 dBFS ±2)", passed=level_ok,
               value=round(rms_db, 2), threshold=-12.0, unit="dBFS"),
        QAGate(id="peak_level", label="Peak headroom", passed=peak_ok,
               value=round(peak_db, 2), threshold=-0.3, unit="dBFS"),
        QAGate(id="junction_glitch", label="Junction smoothness", passed=junction_ok,
             value=round(glitch_score, 4), threshold=0.45, unit="score"),
    ]

    # Score jako procent bramek OK
    score = float(sum(1 for g in gates if g.passed) / len(gates))
    passed = all(g.passed for g in gates)

    if has_clipping:
        qa_warnings.append(f"Digital clipping detected (peak={peak_db:.2f} dBFS)")
    if not level_ok:
        qa_warnings.append(f"RMS level out of target: {rms_db:.2f} dBFS (target -14 ±2)")

    return QARenderResult(
        wavPath=wav_path,
        durationSeconds=round(duration_sec, 3),
        sampleRate=int(sr),
        expectedDurationSeconds=round(expected_duration, 3),
        durationDeltaSeconds=round(duration_delta, 3),
        barCount=round(bar_count_measured, 2),
        expectedBarCount=expected_bars,
        barCountError=round(bar_count_error, 3),
        bpmMeasured=round(bpm_measured, 2),
        bpmExpected=expected_bpm,
        bpmDriftPercent=round(bpm_drift_pct, 3),
        rmsDb=round(rms_db, 2),
        peakDb=round(peak_db, 2),
        hasClipping=has_clipping,
        junctionGlitchScore=round(glitch_score, 4),
        score=round(score, 3),
        passed=passed,
        gates=gates,
        warnings=qa_warnings,
    )
