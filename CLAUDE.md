# CLAUDE.md — Instrukcje operacyjne dla Claude Code
# Projekt: DJ Intro/Outro Generator

## Kim jesteś i jaka jest Twoja rola

Jesteś inteligentnym partnerem developerskim, nie wykonawcą poleceń.
Budujesz aplikację do profesjonalnej analizy audio i generowania intro/outro dla DJ-ów.
Twoja praca to rozumienie projektu jako całości, przewidywanie konsekwencji zmian i dostarczanie rozwiązań które faktycznie działają.

Nie zgadujesz — weryfikujesz. Nie mówisz "powinno działać" — udowadniasz że działa.

---

## Stack technologiczny

### Backend (Hetzner CPX41 — 16GB RAM, 4 vCPU)
- **Runtime:** Python 3.11
- **Framework:** FastAPI
- **Queue:** Celery + Redis
- **Kontener:** Docker Compose
- **Biblioteki audio (kolejność ważna):**
  1. `Demucs` (Meta) — stem separation: vocals/drums/bass/melody
  2. `Essentia` (MTG Barcelona) — pełna analiza audio
  3. `madmom` — precyzyjny beat grid, downbeat, phrase detection
  4. `MusicGen` / `audiocraft` (Meta) — generowanie intro/outro
  5. `pyrubberband` — pitch shifting + time stretching
  6. `pydub` + `ffmpeg` — sklejanie audio, konwersja formatów

### Frontend (Vercel)
- **Framework:** React 18 + TypeScript
- **Styling:** Tailwind CSS
- **Waveform:** Pixi.js (WebGL) — RGB kolorowanie per pasmo częstotliwości
- **State:** React useState / useReducer (bez Zustand/Redux dopóki nie ma potrzeby)
- **HTTP:** axios

### Infrastruktura
- **Repo:** GitHub
- **CI/CD:** GitHub Actions → Vercel (frontend) / Docker Hub → Hetzner (backend)
- **Zmienne środowiskowe:** `.env` nigdy nie trafia do repo

---

## Architektura systemu

```
[React Frontend — Vercel]
  Upload → Polling → Dashboard → Edytor → Export
        ↕ REST API (HTTPS)
[FastAPI — Hetzner]
  /upload → Celery Queue → Redis
                ↓
        [Worker Pipeline]
        1. Demucs (stems)
        2. Essentia (analiza)
        3. madmom (beat grid)
        4. Cue points generator
        5. MusicGen (3x intro + 3x outro)
        6. pyrubberband (pitch/BPM korekta)
        7. pydub (sklejanie)
        8. Export builder
                ↓
        Wyniki zapisane na dysku → dostępne przez API
```

---

## Pipeline przetwarzania — szczegóły

### Etap 1: Stem Separation (Demucs)
- Model: `htdemucs` (najlepszy jakościowo)
- Output: 4 pliki WAV — vocals, drums, bass, melody
- Użycie: stems instrumentalne → kondycjonowanie MusicGen
- Czas CPU: ~10-20 min dla 5-minutowego utworu

### Etap 2: Pełna Analiza (Essentia)
Wyciągamy maksymalną ilość informacji:
- **Rytm:** BPM (dokładność 0.01), beat positions, tempo stability
- **Harmonia:** key, mode (major/minor), chords progression, chord rhythm
- **Struktura:** segmentacja intro/verse/chorus/drop/breakdown/outro z timestampami
- **Energia:** krzywa energii w czasie, LUFS loudness, dynamic range
- **Spektrum:** spectral centroid, brightness, bass intensity, stereo width
- **Waveform data:** RGB peaks per frame (low/mid/high bands) dla Pixi.js

### Etap 3: Beat Grid + Phrase Detection (madmom)
- Dokładna pozycja każdego beatu
- Downbeat detection (pierwsza jedynka każdego bara)
- Phrase boundaries: 4-bar, 8-bar, 16-bar
- Time signature detection

### Etap 4: Auto Cue Points
Generowane na podstawie analizy struktury:
- `mix_in` — pierwszy beat po intro (wejście dropu)
- `mix_out` — pierwszy beat outro (wyjście)
- `drop` — główny drop
- `breakdown` — gdzie energia spada
- `vocal_in` — pierwsze pojawienie wokali (z Demucs wiemy dokładnie)
- `8bar_markers` — co 8 barów dla nawigacji
- Wszystkie snappowane do beat gridu

### Etap 5: Generowanie (MusicGen)
- Model: `facebook/musicgen-melody` (kondycjonowanie audio + tekst)
- Input audio: pierwsze 10s stemów instrumentalnych (drums+bass+melody bez wokali)
- Input text: wygenerowany z analizy Essentia, np.:
  `"128 BPM, Am minor, tech house, dark energy, progressive build, drums and bass intro"`
- Generujemy: 3 warianty intro + 3 warianty outro
- Każdy wariant: dokładnie N barów (phrase-quantized)
- Progressive stem build w intro: drums (8 bars) → +bass (8 bars) → +melody (8 bars)
- Reverb tail na końcu outro dla czystego mix-out

### Etap 6: Audio Processing (pyrubberband)
- Pitch shifting: zmiana tonacji bez zmiany tempa
- Time stretching: zmiana BPM bez zmiany tonacji
- Zakres bezpieczny: ±2 semitony, ±10% BPM (bez artefaktów)
- Ostrzeżenie przy większych zmianach

### Etap 7: Sklejanie (pydub)
- Kolejność: wygenerowane_intro + oryginał + wygenerowane_outro
- Crossfade na łączeniach (długość = 1 bar)
- Normalizacja głośności do LUFS oryginału

### Etap 8: Export
- Audio: MP3 320kbps + WAV 24bit/44.1kHz
- Rekordbox XML (cue points + beat grid)
- Mixxx SQLite (cue points + beat grid)
- Waveform data JSON (dla frontend cache)

---

## API Endpoints

```
POST   /api/upload              — wgraj plik audio
GET    /api/status/{job_id}     — status przetwarzania (polling co 3s)
GET    /api/result/{job_id}     — pełne wyniki analizy + linki do plików
POST   /api/reprocess/{job_id}  — zastosuj ręczne korekty
  body: {
    trim_start: float,     // sekundy — ucięcie ciszy
    first_beat: float,     // pozycja downbeatu
    key_shift: int,        // semitony (-12 do +12)
    bpm_target: float,     // docelowe BPM
    selected_intro: int,   // wybrany wariant intro (0/1/2)
    selected_outro: int    // wybrany wariant outro (0/1/2)
  }
GET    /api/download/{job_id}/{file_type}  — pobierz plik
```

---

## Frontend — komponenty

### Upload View
- Drag & drop MP3/WAV/FLAC/AAC
- Walidacja: max 100MB, obsługiwane formaty
- Progress bar z etapami: Separacja → Analiza → Generowanie
- Polling `/api/status` co 3 sekundy

### Waveform Component (Pixi.js)
- RGB kolorowanie: czerwony=bass, zielony=mid, niebieski=high
- Beat grid overlay (pionowe linie na każdym beacie)
- Phrase markers (pogrubione linie co 8 barów)
- Sekcje kolorowane tłem (intro/drop/outro różne kolory)
- Cue point markery (przeciągalne)
- Playback cursor
- Zoom in/out (scroll)
- Klik = skok do pozycji w playerze

### Analysis Dashboard
- BPM + Key + Camelot wheel (wizualny)
- Struktura utworu jako timeline
- Krzywa energii (wykres)
- Tabela cue pointów (edytowalna)

### Editor Panel
- Silence trim handle na początku waveforma
- Downbeat alignment marker (snap do transientów)
- Camelot wheel klikalna (zmiana tonacji)
- Suwak BPM (±10%, aktualizuje beat grid)

### Variations Player
- 3 karty dla intro, 3 karty dla outro
- Każda karta: miniaturowy waveform + play/stop
- Wybór aktywnego wariantu (radio button)

### Export Panel
- Wybór formatu audio (MP3/WAV)
- Checkboxy: Rekordbox XML, Mixxx format
- Przycisk "Pobierz wszystko" (ZIP)

---

## Struktura folderów

### Backend
```
backend/
├── app/
│   ├── main.py              # FastAPI app, endpoints
│   ├── worker.py            # Celery tasks
│   ├── pipeline/
│   │   ├── demucs.py        # Stem separation
│   │   ├── essentia.py      # Audio analysis
│   │   ├── madmom.py        # Beat grid
│   │   ├── cue_points.py    # Cue point generation
│   │   ├── musicgen.py      # Generation
│   │   ├── rubberband.py    # Pitch/BPM
│   │   └── export.py        # Rekordbox/Mixxx export
│   └── models/
│       └── schemas.py       # Pydantic models
├── docker-compose.yml
├── Dockerfile
└── requirements.txt
```

### Frontend
```
frontend/
├── src/
│   ├── components/
│   │   ├── Upload/
│   │   ├── Waveform/        # Pixi.js component
│   │   ├── Dashboard/
│   │   ├── Editor/
│   │   ├── Variations/
│   │   └── Export/
│   ├── hooks/
│   │   ├── useJobPolling.ts
│   │   └── useAudioPlayer.ts
│   ├── api/
│   │   └── client.ts
│   └── types/
│       └── index.ts
└── package.json
```

---

## Zasady bezpieczeństwa (nienaruszalne)

- Klucze API zawsze przez zmienne środowiskowe — nigdy hardcoded
- Nigdy nie commituj `.env` — sprawdź `.gitignore` przed każdym commitem
- Walidacja uploadowanych plików: typ MIME + rozmiar po stronie serwera
- Pliki użytkownika przechowywane z UUID jako nazwą — nigdy oryginalną nazwą
- Czyść pliki tymczasowe po zakończeniu zadania (Celery cleanup task)

---

## Zasady jakości kodu

- Każda funkcja pipeline ma osobny plik — nie mieszaj Demucs z Essentia
- Loguj każdy etap pipeline z czasem wykonania
- Obsłuż timeout dla każdego etapu (Demucs max 30min, MusicGen max 20min)
- Jeśli etap się wysypie — zapisz błąd do job status, nie crashuj całego pipeline
- TypeScript strict mode na frontendzie — bez `any`

---

## Weryfikacja każdego etapu

Zanim powiesz "gotowe" — przetestuj konkretnym plikiem audio.

**Backend:**
- Upload i sprawdź czy job_id wraca
- Sprawdź Redis czy task jest w kolejce
- Sprawdź logi Celery czy pipeline przechodzi wszystkie etapy
- Sprawdź output files czy istnieją

**Frontend:**
- Upload pliku i sprawdź polling
- Sprawdź czy Waveform renderuje RGB (nie szary)
- Sprawdź czy beat grid jest wyrównany z transientami
- Sprawdź czy cue pointy można przeciągać
- Sprawdź czy download działa

---

## Obowiązkowe pliki projektu

Na początku każdej sesji przeczytaj oba pliki:
- `WORK_LOG.md` — co zostało zrobione
- `KNOWN_ISSUES.md` — znane błędy i rozwiązania

Po każdej znaczącej akcji aktualizuj `WORK_LOG.md`.
Jeśli napotkasz i rozwiążesz błąd — zapisz do `KNOWN_ISSUES.md`.

---

## Czego nigdy nie rób

- Nie instaluj `librosa` — używamy Essentia (jest lepsza i wystarczająca)
- Nie używaj modelu MusicGen większego niż `musicgen-melody` bez zgody — za wolny na CPU
- Nie przetwarzaj audio synchronicznie w FastAPI — zawsze przez Celery
- Nie trzymaj plików audio w pamięci — zawsze zapis na dysk, streaming
- Nie commituj wygenerowanych plików audio do repo
- Nie zakładaj że biblioteka działa — przetestuj na rzeczywistym pliku MP3
