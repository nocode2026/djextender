# BUILD_PLAN.md — Plan budowania dla Claude Code
# Projekt: DJ Intro/Outro Generator

> Czytaj ten plik na początku każdej sesji.
> Realizuj kroki po kolei. Nie skacz do przodu.
> Każdy krok kończy się weryfikacją — bez niej nie przechodzisz dalej.

> Aktualny stan repo: desktopowy MVP na Tauri 2 + React 19 + TypeScript z analizą i renderem w `analysis-sidecar/`.
> Ten plan traktuj jako roadmapę dla obecnej architektury, nie jako specyfikację starego backend-first FastAPI/Celery stacku.

## Stan wyjściowy

- Frontend shell, planner i klienci sidecara są już zaimplementowane.
- Rust command layer buduje plan aranżacji i blokuje tryb pro, gdy analiza lub stem package nie przechodzą gate'ów.
- `analysis-sidecar/` dostarcza `/analyze`, `/separate`, `/transform_preview`, `/transform_audio` i `/render_extended`.
- Do dalszego dopracowania pozostają głównie spójność kontraktów, QA oraz dokumentacja operacyjna.

---

## Zasada ogólna

Budujemy od rdzenia na zewnątrz:
1. Infrastruktura → 2. Pipeline audio → 3. API → 4. Frontend

Każdy moduł musi działać samodzielnie zanim integrujemy z następnym.

---

## FAZA 1 — Infrastruktura Backend

### Krok 1.1 — Docker Compose setup
**Co robisz:**
- Stwórz `docker-compose.yml` z trzema serwisami: `api`, `worker`, `redis`
- Stwórz `Dockerfile` dla `api` i `worker` (ten sam obraz, inny CMD)
- Base image: `python:3.11-slim`
- Zainstaluj `ffmpeg` w Dockerfile (wymagany przez pydub i Demucs)
- Stwórz `requirements.txt` z wszystkimi bibliotekami

**requirements.txt:**
```
fastapi==0.111.0
uvicorn==0.29.0
celery==5.3.6
redis==5.0.4
pydantic==2.7.0
python-multipart==0.0.9
essentia==2.1b6.dev1110
madmom==0.16.1
demucs==4.0.1
audiocraft==1.3.0
pyrubberband==0.3.0
pydub==0.25.1
numpy==1.26.4
scipy==1.13.0
```

**Weryfikacja:**
```bash
docker-compose up --build
# Sprawdź: wszystkie 3 serwisy UP, brak błędów importu
docker-compose exec worker python -c "import essentia; import madmom; import demucs; print('OK')"
```

---

### Krok 1.2 — FastAPI skeleton
**Co robisz:**
- Stwórz `app/main.py` z podstawową strukturą FastAPI
- Health check endpoint: `GET /health` → `{"status": "ok"}`
- CORS middleware (allow Vercel domain + localhost:3000)
- Podstawowa obsługa błędów

**Weryfikacja:**
```bash
curl http://localhost:8000/health
# Oczekiwane: {"status": "ok"}
```

---

### Krok 1.3 — Celery + Redis queue
**Co robisz:**
- Stwórz `app/worker.py` z Celery app
- Stwórz task testowy: `add(x, y)` → zwraca x+y
- Podłącz Redis jako broker i backend wyników

**Weryfikacja:**
```bash
# W osobnym terminalu:
docker-compose exec worker celery -A app.worker worker --loglevel=info
# W API:
docker-compose exec api python -c "
from app.worker import add
result = add.delay(2, 3)
print(result.get(timeout=10))  # Oczekiwane: 5
"
```

---

## FAZA 2 — Pipeline Audio

### Krok 2.1 — Upload + Job Management
**Co robisz:**
- `POST /api/upload` — przyjmuje plik audio (MP3/WAV/FLAC/AAC, max 100MB)
- Walidacja: typ MIME po stronie serwera (nie tylko rozszerzenie)
- Zapis pliku jako `uploads/{uuid}.{ext}`
- Tworzenie job record w Redis: `job:{uuid}` → `{status: "queued", progress: 0}`
- Uruchomienie Celery task `process_audio.delay(job_id, file_path)`
- Zwraca: `{"job_id": "uuid", "status": "queued"}`
- `GET /api/status/{job_id}` → aktualny status + progress (0-100)

**Weryfikacja:**
```bash
curl -X POST http://localhost:8000/api/upload \
  -F "file=@test.mp3"
# Oczekiwane: {"job_id": "...", "status": "queued"}

curl http://localhost:8000/api/status/{job_id}
# Oczekiwane: {"status": "queued", "progress": 0}
```

---

### Krok 2.2 — Demucs: Stem Separation
**Co robisz:**
- Stwórz `app/pipeline/demucs.py`
- Funkcja: `separate_stems(input_path, output_dir) → dict`
- Model: `htdemucs`
- Output dict: `{"vocals": path, "drums": path, "bass": path, "melody": path}`
- Loguj czas wykonania
- Timeout: 30 minut (subprocess z timeout)
- Aktualizuj job progress: 0→25 podczas tego etapu

**Weryfikacja:**
```python
from app.pipeline.demucs import separate_stems
stems = separate_stems("test.mp3", "/tmp/test_output")
# Sprawdź: wszystkie 4 pliki istnieją i mają niezerowy rozmiar
for k, v in stems.items():
    assert os.path.exists(v), f"Missing: {k}"
    assert os.path.getsize(v) > 0, f"Empty: {k}"
print("Demucs OK")
```

---

### Krok 2.3 — Essentia: Pełna Analiza
**Co robisz:**
- Stwórz `app/pipeline/essentia_analysis.py`
- Funkcja: `analyze_audio(file_path) → dict`
- Wyciągnij WSZYSTKIE poniższe dane:

```python
{
  # Rytm
  "bpm": float,               # dokładność 0.01
  "bpm_confidence": float,    # 0-1
  "beat_positions": [float],  # pozycja każdego beatu w sekundach
  "tempo_stability": float,   # czy BPM jest stały
  
  # Harmonia
  "key": str,                 # "Am", "C#", itd.
  "mode": str,                # "major" / "minor"
  "key_confidence": float,
  "camelot": str,             # "8A", "1B", itd.
  "chord_progression": [str], # co bar
  
  # Struktura
  "segments": [
    {
      "type": str,            # "intro"/"verse"/"chorus"/"drop"/"breakdown"/"outro"
      "start": float,         # sekundy
      "end": float,
      "bars": int
    }
  ],
  
  # Energia
  "energy_curve": [float],    # energia co 0.1s (0-1)
  "lufs": float,              # głośność
  "dynamic_range": float,
  
  # Spektrum
  "spectral_centroid": float,
  "brightness": float,
  "bass_intensity": float,
  "stereo_width": float,
  
  # Waveform data dla Pixi.js
  "waveform": {
    "low": [float],           # bass peaks co ~10ms
    "mid": [float],           # mid peaks
    "high": [float]           # high peaks
  },
  
  # Metadane
  "duration": float,
  "sample_rate": int
}
```

**Weryfikacja:**
```python
from app.pipeline.essentia_analysis import analyze_audio
result = analyze_audio("test.mp3")
assert 60 < result["bpm"] < 200, "BPM poza zakresem"
assert result["key"] in ["C","C#","D","Eb","E","F","F#","G","Ab","A","Bb","B",
                          "Cm","C#m","Dm","Ebm","Em","Fm","F#m","Gm","Abm","Am","Bbm","Bm"]
assert len(result["segments"]) > 0, "Brak segmentów"
assert len(result["waveform"]["low"]) > 0, "Brak danych waveform"
print("Essentia OK")
```

---

### Krok 2.4 — madmom: Beat Grid + Phrase Detection
**Co robisz:**
- Stwórz `app/pipeline/madmom_analysis.py`
- Funkcja: `analyze_beats(file_path) → dict`
- Output:

```python
{
  "beats": [float],           # pozycja każdego beatu (sekundy)
  "downbeats": [float],       # pozycja każdej jedynki (pierwszego beatu bara)
  "bpm_precise": float,       # bardziej precyzyjne BPM niż Essentia
  "phrases": {
    "4bar": [float],          # pozycje granic fraz 4-barowych
    "8bar": [float],          # pozycje granic fraz 8-barowych
    "16bar": [float]          # pozycje granic fraz 16-barowych
  },
  "time_signature": str       # "4/4", "3/4", etc.
}
```

**Weryfikacja:**
```python
from app.pipeline.madmom_analysis import analyze_beats
result = analyze_beats("test.mp3")
assert len(result["beats"]) > 0
assert len(result["downbeats"]) > 0
assert len(result["downbeats"]) < len(result["beats"]), "Downbeats musi być mniej niż beats"
print(f"Beat grid: {len(result['beats'])} beats, {len(result['downbeats'])} bars")
print("madmom OK")
```

---

### Krok 2.5 — Auto Cue Points
**Co robisz:**
- Stwórz `app/pipeline/cue_points.py`
- Funkcja: `generate_cue_points(analysis, beats) → list`
- Generuj cue pointy snappowane do nearest beat z beats array
- Każdy cue point:

```python
{
  "id": str,          # "mix_in", "mix_out", "drop", "breakdown", "vocal_in", "8bar_0", etc.
  "label": str,       # czytelna etykieta
  "time": float,      # pozycja w sekundach (snappowana do beatu)
  "beat_number": int, # numer beatu
  "color": str        # hex kolor dla UI
}
```

**Weryfikacja:**
```python
from app.pipeline.cue_points import generate_cue_points
cues = generate_cue_points(essentia_result, madmom_result)
assert any(c["id"] == "mix_in" for c in cues), "Brak mix_in"
assert any(c["id"] == "mix_out" for c in cues), "Brak mix_out"
for cue in cues:
    # Sprawdź że każdy cue jest na pozycji beatu
    assert any(abs(cue["time"] - beat) < 0.01 for beat in beats), f"Cue {cue['id']} nie na beacie"
print("Cue points OK")
```

---

### Krok 2.6 — MusicGen: Generowanie Intro/Outro
**Co robisz:**
- Stwórz `app/pipeline/musicgen.py`
- Funkcja: `generate_variations(stems, analysis, beats) → dict`
- Konstruuj text prompt z analizy:
  ```python
  f"{bpm:.0f} BPM, {key}, {genre_desc}, progressive build, 
   drums and bass intro, no vocals, club music"
  ```
- Audio conditioning: skej drums+bass+melody stems (bez wokali), pierwsze 10s
- Generuj 3x intro (długość: 16 barów) + 3x outro (długość: 16 barów)
- Każda generacja phrase-quantized: zaokrąglij do pełnego bara
- Progressive stem build dla intro: implementuj przez mixowanie stemów
- Reverb tail na outro: pydub `apply_gain_stereo` z fade out + reverb effect
- Timeout: 20 minut per generacja
- Output:

```python
{
  "intros": ["path/to/intro_0.wav", "path/to/intro_1.wav", "path/to/intro_2.wav"],
  "outros": ["path/to/outro_0.wav", "path/to/outro_1.wav", "path/to/outro_2.wav"]
}
```

**Weryfikacja:**
```python
# Sprawdź że pliki istnieją i mają sensowną długość
for path in result["intros"] + result["outros"]:
    from pydub import AudioSegment
    audio = AudioSegment.from_wav(path)
    assert 10000 < len(audio) < 120000, f"Podejrzana długość: {len(audio)}ms"
print("MusicGen OK")
```

---

### Krok 2.7 — pyrubberband: Pitch/BPM Processing
**Co robisz:**
- Stwórz `app/pipeline/rubberband.py`
- Funkcja: `shift_pitch(file_path, semitones, output_path) → str`
- Funkcja: `stretch_tempo(file_path, target_bpm, original_bpm, output_path) → str`
- Ostrzeżenie (nie błąd) gdy: `abs(semitones) > 2` lub `abs(bpm_change_pct) > 10`
- Używaj `pyrubberband` z `RubberBandStretcher` (R3 engine dla jakości)

**Weryfikacja:**
```python
from app.pipeline.rubberband import shift_pitch, stretch_tempo
out = shift_pitch("test.mp3", -2, "/tmp/shifted.wav")
assert os.path.exists(out)
# Zweryfikuj BPM output == target
```

---

### Krok 2.8 — Sklejanie + Export
**Co robisz:**
- Stwórz `app/pipeline/export.py`
- Funkcja: `build_final_track(intro_path, original_path, outro_path, crossfade_bars, bpm) → str`
  - Crossfade długości 1 bara
  - Normalizacja do LUFS oryginału
  - Output: WAV 24bit + MP3 320kbps
- Funkcja: `export_rekordbox_xml(cue_points, beats, bpm, key, output_path) → str`
  - Standardowy format Rekordbox XML
- Funkcja: `export_mixxx_sqlite(cue_points, beats, bpm, key, output_path) → str`
  - Format bazy Mixxx

**Weryfikacja:**
```python
# Sprawdź że XML jest validny
import xml.etree.ElementTree as ET
tree = ET.parse(rekordbox_xml_path)
root = tree.getroot()
assert root.tag == "DJ_PLAYLISTS"
print("Export OK")
```

---

## FAZA 3 — Integracja Pipeline w Celery

### Krok 3.1 — Główny task Celery
**Co robisz:**
- W `app/worker.py` stwórz task `process_audio(job_id, file_path)`
- Sekwencja z aktualizacją progressu:
  - 0%: start
  - 10%: Demucs start
  - 25%: Demucs done, Essentia start
  - 45%: Essentia done, madmom start
  - 55%: madmom done, cue points
  - 60%: cue points done, MusicGen start
  - 85%: MusicGen done, sklejanie
  - 95%: sklejanie done, export
  - 100%: wszystko gotowe
- Każdy etap w try/except — błąd zapisuje się do job status ale nie crashuje
- Finalny wynik zapisz do Redis: `job:{uuid}:result → json`

### Krok 3.2 — Reprocess endpoint
**Co robisz:**
- `POST /api/reprocess/{job_id}` z body korekt
- Walidacja: key_shift w zakresie -12/+12, bpm_target > 0
- Uruchamia nowy (szybszy) task który pomija etapy 1-4 i przetwarza tylko audio

---

## FAZA 4 — Frontend

### Krok 4.1 — Setup projektu
```bash
npx create-react-app frontend --template typescript
cd frontend
npm install axios pixi.js @pixi/react tailwindcss
```
- Skonfiguruj Tailwind
- Stwórz `src/api/client.ts` z wszystkimi endpointami
- Stwórz typy TypeScript dla wszystkich response'ów API

### Krok 4.2 — Upload Component
- Drag & drop zone
- Walidacja formatu i rozmiaru po stronie klienta (dodatkowa, nie jedyna)
- Po upload: polling `useJobPolling` hook co 3s
- Progress bar z etapami tekstowymi

**Weryfikacja:** wgraj MP3, sprawdź czy progress się aktualizuje

### Krok 4.3 — Waveform Component (Pixi.js)
To jest najbardziej złożony komponent. Rób krok po kroku:

**4.3a:** Renderuj podstawowy waveform (mono, szary) z danych JSON
**4.3b:** Dodaj RGB kolorowanie (red=low, green=mid, blue=high)
**4.3c:** Dodaj beat grid (pionowe linie)
**4.3d:** Dodaj phrase markers (pogrubione co 8 barów)
**4.3e:** Dodaj kolorowane sekcje tłem (intro/drop/outro)
**4.3f:** Dodaj przeciągalne cue point markery
**4.3g:** Dodaj zoom (scroll wheel)
**4.3h:** Dodaj playback cursor + klik do skoku

**Weryfikacja po każdym sub-kroku** — sprawdź wizualnie czy renderuje poprawnie.

### Krok 4.4 — Analysis Dashboard
- BPM + Key jako duże liczby
- Camelot wheel (SVG, 12 segmentów, aktywny podświetlony)
- Struktura jako poziomy timeline
- Krzywa energii (recharts LineChart)
- Tabela cue pointów

### Krok 4.5 — Editor Panel
- Silence trim: przeciągalny marker na waveformie
- Downbeat marker: klikasz na waveform gdzie jest "jedynka"
- Camelot wheel klikalna: kliknięcie → wysyła `key_shift` do API
- BPM suwak: zakres originalBPM ±10%

### Krok 4.6 — Variations Player
- 3 karty intro, 3 karty outro
- Miniaturowy waveform (uproszczony, bez RGB) w każdej karcie
- Play/stop button
- Radio selection (który wariant wybrany)

### Krok 4.7 — Export Panel
- Przycisk "Zastosuj i pobierz" → POST /reprocess → polling → download
- Checkboxy formatów
- Download ZIP ze wszystkimi plikami

---

## Deployment

### Backend (Hetzner CPX41)
```bash
# Na serwerze:
git clone {repo}
cd backend
cp .env.example .env
# Uzupełnij .env: REDIS_URL, etc.
docker-compose up -d
```

### Frontend (Vercel)
- Połącz repo z Vercel
- Ustaw env var: `REACT_APP_API_URL=https://api.twoja-domena.com`
- Deploy automatyczny przy push do main

---

## Kolejność weryfikacji końcowej

1. Wgraj MP3 5-minutowego techno tracku (128 BPM)
2. Sprawdź że wszystkie etapy pipeline przeszły w logach Celery
3. Sprawdź że waveform RGB renderuje i beat grid jest wyrównany
4. Sprawdź że BPM i tonacja są poprawne (zweryfikuj ręcznie)
5. Odtwórz 3 warianty intro — czy brzmią jak intro do tego tracku?
6. Pobierz Rekordbox XML — wgraj do Rekordbox i sprawdź cue pointy
7. Pobierz finalny MP3 — sprawdź przejścia intro→oryginał→outro

---

## Znane ryzyka i jak je obsłużyć

| Ryzyko | Prawdopodobieństwo | Obsługa |
|--------|-------------------|---------|
| Demucs OOM na 16GB | Niskie | Użyj `htdemucs_ft` (mniejszy model) |
| MusicGen timeout na CPU | Wysokie | Ustaw max 60 bars generowania |
| Essentia brak segmentacji | Średnie | Fallback: struktura na podstawie energii |
| pyrubberband artefakty | Niskie przy ±2st | Ostrzeżenie UI przy dużych zmianach |
| Rekordbox XML odmawia importu | Średnie | Testuj na każdej wersji Rekordboxa |
