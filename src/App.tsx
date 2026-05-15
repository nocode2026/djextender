import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { type AudioAnalysisResult } from "./audioAnalyzer";
import { analyzeWithProSidecar } from "./proAnalysisClient";
import { separateWithProSidecar } from "./proStemClient";
import { renderExtendedWithProSidecar, type RenderExtendedResult, type RenderProgress } from "./proRenderClient";
import {
  transformAudioWithProSidecar,
  transformPreviewWithProSidecar,
  type TransformAudioResult,
  type TransformPreviewResult,
} from "./proTransformClient";
import { qaRender, type QARenderResult } from "./proQAClient";
import "./App.css";

type OperationMode = "intro" | "outro" | "intro_outro";
type StylePreset =
  | "close_to_original"
  | "cleaner_club_edit"
  | "modern_deep_house_edit"
  | "radio_to_club_extended";
type VocalHandling = "no_vocals" | "vocal_chops_only" | "keep_short_hook";
type AiIntroOutroMode = "ai_assisted" | "deterministic";

type PlannerRequest = {
  title: string;
  bpm: number;
  musicalKey: string;
  camelotKey?: string;
  huggingfaceToken?: string;
  durationSeconds: number;
  detectedPhraseBars: number;
  introBars: number;
  outroBars: number;
  genre: string;
  energyProfile: string;
  preserveVocals: boolean;
  operationMode: OperationMode;
  stylePreset: StylePreset;
  vocalHandling: VocalHandling;
  useAiGeneratedIntroOutro?: boolean;
  takeCount: number;
  analysisOverallScore?: number;
  analysisProductionReady?: boolean;
  downbeatOffsetSeconds?: number;
  downbeatConfidence?: number;
  markerCount?: number;
  stemPackageReady?: boolean;
  stemEngine?: string;
  stemPackageId?: string;
  targetBpm?: number;
  targetMusicalKey?: string;
  timeStretchRatio?: number;
  pitchSemitones?: number;
};

type PlanResponse = {
  projectTitle: string;
  sourceTitle: string;
  introDurationSeconds: number;
  outroDurationSeconds: number;
  totalExportDurationSeconds: number;
  quantizedIntroBars: number;
  quantizedOutroBars: number;
  takes: Array<{
    takeIndex: number;
    label: string;
    variationFocus: string;
    exportLabel: string;
  }>;
  warnings: string[];
  engineerNotes: string[];
  exportLabel: string;
};

type Step = 1 | 2 | 3 | 4;

function formatSeconds(value: number) {
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function wslToWin(p: string): string {
  return `\\\\wsl.localhost\\Ubuntu-22.04${p}`;
}

const STYLE_LABELS: Record<StylePreset, string> = {
  close_to_original: "Oryginalny styl",
  cleaner_club_edit: "Edit klubowy",
  modern_deep_house_edit: "Deep house",
  radio_to_club_extended: "Radio do klubu",
};

const VOCAL_LABELS: Record<VocalHandling, string> = {
  no_vocals: "Bez wokalu",
  vocal_chops_only: "Vocal chopy",
  keep_short_hook: "Zachowaj hook",
};

const AI_MODE_LABELS: Record<AiIntroOutroMode, string> = {
  ai_assisted: "AI intro/outro (Stable Audio)",
  deterministic: "Deterministyczny (tylko stemy)",
};

const KEY_OPTIONS = [
  "C major", "C# major", "D major", "D# major", "E major", "F major", "F# major", "G major", "G# major", "A major", "A# major", "B major",
  "C minor", "C# minor", "D minor", "D# minor", "E minor", "F minor", "F# minor", "G minor", "G# minor", "A minor", "A# minor", "B minor",
];

const NOTE_TO_SEMITONE: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

function parseMusicalKey(rawKey: string): { semitone: number; mode: "major" | "minor" } | null {
  const normalized = rawKey.trim();
  const match = normalized.match(/^([A-Ga-g](?:#|b)?)[\s_-]+(major|minor)$/i);
  if (!match) return null;
  const note = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const semitone = NOTE_TO_SEMITONE[note];
  if (semitone === undefined) return null;
  const mode = match[2].toLowerCase() === "major" ? "major" : "minor";
  return { semitone, mode };
}

function semitoneDeltaBetweenKeys(sourceKey: string, targetKey: string): number | null {
  const src = parseMusicalKey(sourceKey);
  const dst = parseMusicalKey(targetKey);
  if (!src || !dst || src.mode !== dst.mode) return null;
  let delta = dst.semitone - src.semitone;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return Math.max(-6, Math.min(6, delta));
}

function StepDot({ n, current }: { n: Step; current: Step }) {
  const state = n < current ? "done" : n === current ? "active" : "idle";
  return (
    <div className={`step-dot step-dot--${state}`}>
      {state === "done" ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span>{n}</span>
      )}
    </div>
  );
}

function PillGroup<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Record<T, string>;
}) {
  return (
    <div className="pill-group">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`pill ${opt === value ? "pill--active" : ""}`}
          onClick={() => onChange(opt)}
        >
          {labels ? labels[opt] : opt}
        </button>
      ))}
    </div>
  );
}

function App() {
  const HF_TOKEN_STORAGE_KEY = "djextender.huggingfaceToken";
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [dragOver, setDragOver] = useState(false);

  // Sidecar health
  const [sidecarOnline, setSidecarOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const SIDECAR = (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? "http://127.0.0.1:8765";
    async function check() {
      try {
        const res = await fetch(`${SIDECAR}/health`, { signal: AbortSignal.timeout(3000) });
        setSidecarOnline(res.ok);
      } catch {
        setSidecarOnline(false);
      }
    }
    void check();
    const id = setInterval(() => void check(), 10_000);
    return () => clearInterval(id);
  }, []);

  // File
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Step 2 - analysis
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AudioAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");

  // Step 3 - config
  const [introBars, setIntroBars] = useState(32);
  const [outroBars, setOutroBars] = useState(32);
  const [operationMode, setOperationMode] = useState<OperationMode>("intro_outro");
  const [stylePreset, setStylePreset] = useState<StylePreset>("close_to_original");
  const [vocalHandling, setVocalHandling] = useState<VocalHandling>("no_vocals");
  const [aiIntroOutroMode, setAiIntroOutroMode] = useState<AiIntroOutroMode>("ai_assisted");
  const [targetBpm, setTargetBpm] = useState<number>(120);
  const [pitchSemitones, setPitchSemitones] = useState<number>(0);
  const [targetMusicalKey, setTargetMusicalKey] = useState<string>("");
  const [isPreviewingTransform, setIsPreviewingTransform] = useState(false);
  const [transformPreview, setTransformPreview] = useState<TransformPreviewResult | null>(null);
  const [transformResult, setTransformResult] = useState<TransformAudioResult | null>(null);
  const transformPreviewRef = useRef<HTMLAudioElement | null>(null);
  const [transformPreviewTime, setTransformPreviewTime] = useState(0);
  const [transformPreviewDuration, setTransformPreviewDuration] = useState(0);
  const [transformPreviewPlaying, setTransformPreviewPlaying] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [huggingfaceTokenInput, setHuggingfaceTokenInput] = useState("");
  const [tokenSavedBanner, setTokenSavedBanner] = useState("");

  // Step 4 - generate
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationFlow, setGenerationFlow] = useState<"extended" | "transform">("extended");
  const [generateStage, setGenerateStage] = useState("");
  const [renderResult, setRenderResult] = useState<RenderExtendedResult | null>(null);
  const [generateError, setGenerateError] = useState("");
  const [selectedTake, setSelectedTake] = useState(0);
  const [qaResults, setQaResults] = useState<QARenderResult[]>([]);
  const [isQARunning, setIsQARunning] = useState(false);
  const [sseProgress, setSseProgress] = useState<{step: number; total: number; label: string; elapsed_seconds?: number; eta_seconds?: number | null; last_heartbeat?: number | null} | null>(null);
  const [renderStaleWarning, setRenderStaleWarning] = useState<string | null>(null);
  const renderAbortRef = useRef<AbortController | null>(null);

  // Stem player state
  const [stemPackageResult, setStemPackageResult] = useState<{jobId: string; outputDirectory: string; stems: Array<{stem: string; path: string}>} | null>(null);
  // Independent stem player state
  const [stemPlayerPlaying, setStemPlayerPlaying] = useState(false);
  const [stemPlayerTime, setStemPlayerTime] = useState(0);
  const [stemPlayerDuration, setStemPlayerDuration] = useState(0);
  const [enabledStemLayers, setEnabledStemLayers] = useState<Set<string>>(new Set(["drums", "bass", "melody", "vocals"]));
  const stemAudioRefs = useRef<Record<string, HTMLAudioElement>>({});
  const stemCanvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const stemPeaksRef = useRef<Record<string, Float32Array>>({}); // pre-computed waveform peaks
  const stemRafRef = useRef<number>(0);

  // Analysis progress
  const [analyzeProgress, setAnalyzeProgress] = useState<{step: number; total: number; label: string} | null>(null);
  const analyzeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Source player (Step 2) - odtwarzanie oryginalnego utworu
  const srcPlayerRef = useRef<HTMLAudioElement | null>(null);
  const srcBeatgridRef = useRef<HTMLCanvasElement | null>(null);
  const [sourceBlobUrl, setSourceBlobUrl] = useState("");

  // Cleanup blob URL whenever it changes and on unmount.
  useEffect(() => {
    return () => {
      if (sourceBlobUrl) URL.revokeObjectURL(sourceBlobUrl);
    };
  }, [sourceBlobUrl]);
  const [srcPlaying, setSrcPlaying] = useState(false);
  const [srcTime, setSrcTime] = useState(0);
  const [srcDuration, setSrcDuration] = useState(0);

  // Player w Step 4
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const markerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(HF_TOKEN_STORAGE_KEY) ?? "";
    if (saved) {
      setHuggingfaceTokenInput(saved);
    }
  }, []);

  useEffect(() => {
    if (!analysisResult) return;
    setTargetBpm(analysisResult.bpm);
    setPitchSemitones(0);
    setTargetMusicalKey(analysisResult.musicalKey);
    setTransformPreview(null);
    setTransformResult(null);
    setTransformPreviewTime(0);
    setTransformPreviewDuration(0);
    setTransformPreviewPlaying(false);
  }, [analysisResult]);

  function saveHuggingfaceToken() {
    const trimmed = huggingfaceTokenInput.trim();
    if (!trimmed) {
      localStorage.removeItem(HF_TOKEN_STORAGE_KEY);
      setTokenSavedBanner("Token usunięty z ustawień aplikacji.");
      return;
    }
    localStorage.setItem(HF_TOKEN_STORAGE_KEY, trimmed);
    setTokenSavedBanner("Token zapisany w ustawieniach aplikacji.");
  }

  function closeSettings() {
    setSettingsOpen(false);
    setTokenSavedBanner("");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeSettings();
      }
    }
    if (settingsOpen) {
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
    return undefined;
  }, [settingsOpen]);

  // --- Independent stem player helpers ---
  // Draw static peak waveform + animated playhead cursor on a canvas
  function drawStemCanvas(canvas: HTMLCanvasElement, peaks: Float32Array | null, currentTime: number, duration: number) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth || 300;
    const cssH = canvas.offsetHeight || 48;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssW, cssH);
    ctx2d.fillStyle = "rgba(0,0,0,0.35)";
    ctx2d.fillRect(0, 0, cssW, cssH);
    const mid = cssH / 2;
    if (peaks && peaks.length > 0) {
      // Draw played portion (brighter)
      const playedFrac = duration > 0 ? Math.min(1, currentTime / duration) : 0;
      const playedPx = Math.round(playedFrac * cssW);
      for (let px = 0; px < cssW; px++) {
        const idx = Math.floor((px / cssW) * peaks.length);
        const amp = (peaks[idx] ?? 0) * mid * 0.9;
        ctx2d.fillStyle = px < playedPx ? "rgba(124,109,250,0.95)" : "rgba(124,109,250,0.35)";
        ctx2d.fillRect(px, mid - amp, 1, amp * 2 || 1);
      }
      // Cursor line
      if (duration > 0 && currentTime > 0) {
        const cx = playedFrac * cssW;
        ctx2d.fillStyle = "rgba(255,255,255,0.85)";
        ctx2d.fillRect(cx - 0.5, 0, 1, cssH);
      }
    } else {
      // Placeholder
      ctx2d.fillStyle = "rgba(255,255,255,0.12)";
      ctx2d.fillRect(0, mid - 1, cssW, 2);
    }
  }

  // Pre-compute RMS peaks for a stem audio URL (offline decode, no playback)
  async function loadStemPeaks(key: string, url: string) {
    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const arrayBuffer = await response.arrayBuffer();
      const offlineCtx = new OfflineAudioContext(1, 1, 44100);
      const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
      const data = audioBuffer.getChannelData(0);
      const BINS = 500;
      const peaks = new Float32Array(BINS);
      const binSize = Math.floor(data.length / BINS);
      for (let i = 0; i < BINS; i++) {
        let sum = 0;
        for (let j = 0; j < binSize; j++) {
          const v = data[i * binSize + j] ?? 0;
          sum += v * v;
        }
        peaks[i] = Math.sqrt(sum / binSize);
      }
      // Normalize peaks
      const maxPeak = Math.max(...peaks, 0.001);
      for (let i = 0; i < BINS; i++) peaks[i] /= maxPeak;
      stemPeaksRef.current[key] = peaks;
      // Draw immediately
      const canvas = stemCanvasRefs.current[key];
      if (canvas) drawStemCanvas(canvas, peaks, 0, audioBuffer.duration);
    } catch { /* ignore */ }
  }

  function startStemRaf() {
    const tick = () => {
      const firstAudio = Object.values(stemAudioRefs.current)[0];
      const currentTime = firstAudio ? firstAudio.currentTime : 0;
      setStemPlayerTime(currentTime);
      // Redraw all canvases with playhead cursor
      const dur = firstAudio?.duration || stemPlayerDuration;
      Object.entries(stemCanvasRefs.current).forEach(([key, canvas]) => {
        if (!canvas) return;
        const peaks = stemPeaksRef.current[key] ?? null;
        drawStemCanvas(canvas, peaks, currentTime, dur);
      });
      stemRafRef.current = requestAnimationFrame(tick);
    };
    stemRafRef.current = requestAnimationFrame(tick);
  }

  function stopStemRaf() {
    if (stemRafRef.current) { cancelAnimationFrame(stemRafRef.current); stemRafRef.current = 0; }
  }

  async function stemPlay() {
    const time = stemPlayerTime;
    const audios = Object.entries(stemAudioRefs.current);
    if (audios.length === 0) return;
    // Sync positions, set mute state, then play all
    for (const [key, audio] of audios) {
      audio.muted = !enabledStemLayers.has(key);
      if (Math.abs(audio.currentTime - time) > 0.05) audio.currentTime = time;
    }
    // Start all in sequence (browsers allow concurrent play from user gesture)
    for (const [, audio] of audios) {
      try { await audio.play(); } catch { /* ignore autoplay rejection */ }
    }
    setStemPlayerPlaying(true);
    startStemRaf();
  }

  function stemPause() {
    Object.values(stemAudioRefs.current).forEach((a) => a.pause());
    stopStemRaf();
    setStemPlayerPlaying(false);
  }

  function stemStop() {
    stemPause();
    Object.values(stemAudioRefs.current).forEach((a) => { a.currentTime = 0; });
    setStemPlayerTime(0);
    // Redraw canvases at t=0
    const dur = Object.values(stemAudioRefs.current)[0]?.duration || stemPlayerDuration;
    Object.entries(stemCanvasRefs.current).forEach(([key, canvas]) => {
      if (canvas) drawStemCanvas(canvas, stemPeaksRef.current[key] ?? null, 0, dur);
    });
  }

  function stemSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const t = Number(e.target.value);
    Object.values(stemAudioRefs.current).forEach((a) => { a.currentTime = t; });
    setStemPlayerTime(t);
  }

  function toggleStemEnabled(key: string) {
    setEnabledStemLayers((prev) => {
      const next = new Set(prev);
      const nowEnabled = !next.has(key);
      if (nowEnabled) next.add(key); else next.delete(key);
      if (stemAudioRefs.current[key]) {
        stemAudioRefs.current[key].muted = !nowEnabled;
      }
      return next;
    });
  }

  function stopAllPlayers() {
    const mainPlayer = playerRef.current;
    if (mainPlayer) {
      mainPlayer.pause();
      mainPlayer.currentTime = 0;
    }
    const sourcePlayer = srcPlayerRef.current;
    if (sourcePlayer) {
      sourcePlayer.pause();
      sourcePlayer.currentTime = 0;
    }
    const transformPreviewPlayer = transformPreviewRef.current;
    if (transformPreviewPlayer) {
      transformPreviewPlayer.pause();
      transformPreviewPlayer.currentTime = 0;
    }
    stemStop();
    setIsPlaying(false);
    setSrcPlaying(false);
    setTransformPreviewPlaying(false);
    setPlayerTime(0);
    setSrcTime(0);
    setTransformPreviewTime(0);
  }

  function loadFile(file: File) {
    stopAllPlayers();
    setSelectedFile(file);
    setAnalysisResult(null);
    setRenderResult(null);
    setQaResults([]);
    setAnalysisError("");
    setGenerateError("");
    setTransformPreview(null);
    setTransformResult(null);
    setTransformPreviewTime(0);
    setTransformPreviewDuration(0);
    setTransformPreviewPlaying(false);
    setSelectedTake(0);
    setSrcTime(0);
    setSrcDuration(0);
    setSrcPlaying(false);
    // Stworz blob URL dla source playera
    setSourceBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
    setStep(2);
    runAnalysis(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }

  async function runAnalysis(file: File) {
    setIsAnalyzing(true);
    setAnalysisError("");
    setAnalyzeProgress({ step: 0, total: 7, label: "Uploading audio to analyzer..." });

    const analyzeSteps = [
      "Wysyłam audio do analizatora...",
      "Dekoduję audio i wczytuję waveform...",
      "Wykrywam BPM i siatkę beatów (librosa)...",
      "Analizuję tonację i harmonię (CQT)...",
      "Walidacja krzyżowa z Essentia...",
      "Wykrywam fazy taktowe i frazy...",
      "Skanuję sekcje i buduję beatgrid...",
      "Finalizuję wynik...",
    ];
    let analyzeStep = 0;
    const analyzeTimer = setInterval(() => {
      analyzeStep = Math.min(analyzeStep + 1, analyzeSteps.length - 1);
      setAnalyzeProgress({ step: analyzeStep, total: analyzeSteps.length - 1, label: analyzeSteps[analyzeStep] });
    }, 2800);
    analyzeTimerRef.current = analyzeTimer;

    try {
      const result = await analyzeWithProSidecar(file, { analysisEngine: "hybrid" });
      setAnalysisResult(result);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed. Is the sidecar running?");
    } finally {
      clearInterval(analyzeTimer);
      analyzeTimerRef.current = null;
      setIsAnalyzing(false);
      setAnalyzeProgress(null);
    }
  }

  async function handleGenerate() {
    if (!selectedFile || !analysisResult) return;
    const safeTargetBpm = Number.isFinite(targetBpm) ? Math.max(1, targetBpm) : analysisResult.bpm;
    const timeStretchRatio = Math.max(0.5, Math.min(2.0, safeTargetBpm / Math.max(analysisResult.bpm, 1)));
    const safeSemitones = Math.max(-6, Math.min(6, Math.round(pitchSemitones)));
    setIsGenerating(true);
    setGenerationFlow("extended");
    setGenerateError("");
    setRenderResult(null);
    setTransformResult(null);
    setSseProgress(null);
    setRenderStaleWarning(null);
    setStep(4);

    try {
      setSseProgress({ step: 0, total: 4, label: "Wysyłam audio do sidecara..." });
      setGenerateStage("Separuję stemy (AI Demucs)...");
      const stemPackage = await separateWithProSidecar(selectedFile, {
        onProgress: (p) => {
          setSseProgress({ step: p.step, total: p.total, label: p.label });
        },
      });
      setStemPackageResult(stemPackage as typeof stemPackageResult);
      setSseProgress({ step: 4, total: 4, label: "Separacja stemów zakończona ✓" });

      setGenerateStage("Buduję plan aranżacji...");
      const planRequest: PlannerRequest = {
        title: selectedFile.name.replace(/\.[^.]+$/, ""),
        bpm: analysisResult.bpm,
        musicalKey: analysisResult.musicalKey,
        camelotKey: analysisResult.camelotKey,
        huggingfaceToken: huggingfaceTokenInput.trim() || undefined,
        durationSeconds: Math.round(analysisResult.durationSeconds),
        detectedPhraseBars: analysisResult.phraseBars,
        introBars,
        outroBars,
        genre: "Electronic",
        energyProfile: "peak",
        preserveVocals: vocalHandling !== "no_vocals",
        operationMode,
        stylePreset,
        vocalHandling,
        useAiGeneratedIntroOutro: aiIntroOutroMode === "ai_assisted",
        takeCount: 3,
        analysisOverallScore: analysisResult.overallScore,
        analysisProductionReady: true,
        downbeatOffsetSeconds: analysisResult.downbeatOffsetSeconds,
        downbeatConfidence: analysisResult.downbeatConfidence,
        markerCount: analysisResult.timelineMarkers.length,
        stemPackageReady: stemPackage.isReady,
        stemEngine: stemPackage.stemEngine,
        stemPackageId: stemPackage.jobId,
        targetBpm: safeTargetBpm,
        targetMusicalKey: targetMusicalKey || undefined,
        timeStretchRatio,
        pitchSemitones: safeSemitones,
      };

      const plan = await invoke<PlanResponse>("build_extension_plan", { request: planRequest });

      setGenerateStage("Renderuję extended mix...");
      setRenderStaleWarning(null);
      const abortCtrl = new AbortController();
      renderAbortRef.current = abortCtrl;

      const STALE_THRESHOLD_S = 30;

      const result = await renderExtendedWithProSidecar({
        sourceFile: selectedFile,
        request: planRequest as unknown as Record<string, unknown>,
        plan,
        stemPackage,
        signal: abortCtrl.signal,
        onProgress: (p: RenderProgress) => {
          setSseProgress({
            step: p.step,
            total: p.total,
            label: p.label,
            elapsed_seconds: p.elapsed_seconds,
            eta_seconds: p.eta_seconds,
            last_heartbeat: p.last_heartbeat,
          });
          // Stale detector: heartbeat starszy niż STALE_THRESHOLD_S sekund
          if (p.last_heartbeat !== null && p.last_heartbeat !== undefined) {
            const age = Date.now() / 1000 - p.last_heartbeat;
            if (age > STALE_THRESHOLD_S && !p.done) {
              setRenderStaleWarning(`Render może wisieć — ostatnia aktywność: ${Math.round(age)}s temu`);
            } else {
              setRenderStaleWarning(null);
            }
          }
        },
      });
      renderAbortRef.current = null;
      setSseProgress({step: 1, total: 1, label: "Render zakończony ✓"});

      setRenderResult(result);
      setGenerateStage("");

      // Auto-run QA asynchronicznie (nie blokuje generatora)
      if (result.takes.length > 0 && analysisResult) {
        const sourceBars = Math.round(
          analysisResult.durationSeconds / (analysisResult.beatIntervalSeconds * 4)
        );
        const expectedBars =
          (operationMode !== "outro" ? introBars : 0) +
          sourceBars +
          (operationMode !== "intro" ? outroBars : 0);

        const _analysisSnapshot = analysisResult;
        setIsQARunning(true);
        Promise.all(
          result.takes.map((take) =>
            qaRender({
              wavPath: take.wavPath,
              expectedBpm: _analysisSnapshot.bpm,
              expectedBars,
              introBars: operationMode !== "outro" ? introBars : 0,
              outroBars: operationMode !== "intro" ? outroBars : 0,
            }).catch(() => null)
          )
        )
          .then((qaAll) =>
            setQaResults(qaAll.filter((r): r is NonNullable<typeof r> => r !== null))
          )
          .finally(() => setIsQARunning(false));
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed. Check the sidecar logs.");
    } finally {
      setIsGenerating(false);
    }
  }

  function applyTargetKey(nextKey: string) {
    setTargetMusicalKey(nextKey);
    if (!analysisResult) return;
    const delta = semitoneDeltaBetweenKeys(analysisResult.musicalKey, nextKey);
    if (delta === null) return;
    setPitchSemitones(delta);
  }

  async function handlePreviewTransform() {
    if (!selectedFile || !analysisResult) return;
    setIsPreviewingTransform(true);
    setGenerateError("");
    try {
      const preview = await transformPreviewWithProSidecar({
        sourceFile: selectedFile,
        sourceBpm: analysisResult.bpm,
        targetBpm: Math.max(1, targetBpm),
        pitchSemitones: Math.max(-6, Math.min(6, Math.round(pitchSemitones))),
        previewSeconds: 30,
      });
      setTransformPreview(preview);
      setTransformPreviewTime(0);
      setTransformPreviewDuration(preview.durationSeconds);
      setTransformPreviewPlaying(false);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Preview transform failed.");
    } finally {
      setIsPreviewingTransform(false);
    }
  }

  async function handleSaveTransformOnly() {
    if (!selectedFile || !analysisResult) return;
    setStep(4);
    setIsGenerating(true);
    setGenerationFlow("transform");
    setGenerateError("");
    setRenderResult(null);
    setTransformResult(null);
    setSseProgress({ step: 1, total: 3, label: "Przetwarzam tempo i tonację (Rubber Band)..." });
    try {
      const result = await transformAudioWithProSidecar({
        sourceFile: selectedFile,
        sourceBpm: analysisResult.bpm,
        targetBpm: Math.max(1, targetBpm),
        pitchSemitones: Math.max(-6, Math.min(6, Math.round(pitchSemitones))),
      });
      setSseProgress({ step: 3, total: 3, label: "Transformacja zakończona ✓" });
      setTransformResult(result);
      setGenerateStage("");
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Transform save failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function openFile(path: string) {
    try {
      await openPath(wslToWin(path));
    } catch {
      try {
        await openPath(path);
      } catch {
        /* ignore */
      }
    }
  }

  async function openFolder(path: string) {
    try {
      await revealItemInDir(wslToWin(path));
    } catch {
      try {
        await openPath(wslToWin(path));
      } catch {
        /* ignore */
      }
    }
  }

  // Initialize stem audio elements when stem package is ready
  useEffect(() => {
    if (!stemPackageResult?.stems) return;
    // Clean up old audio elements
    stopStemRaf();
    Object.values(stemAudioRefs.current).forEach((a) => { a.pause(); a.src = ""; });
    stemAudioRefs.current = {};
    stemPeaksRef.current = {};
    setStemPlayerPlaying(false);
    setStemPlayerTime(0);
    setStemPlayerDuration(0);
    setEnabledStemLayers(new Set(["drums", "bass", "melody", "vocals"]));

    const sidecarUrl = (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? "http://127.0.0.1:8765";

    const STEMS = [
      { key: "drums", stemKey: "drums" },
      { key: "bass", stemKey: "bass" },
      { key: "melody", stemKey: "other" },
      { key: "vocals", stemKey: "vocals" },
    ] as const;
    let durationSet = false;
    STEMS.forEach(({ key, stemKey }) => {
      const stemPath = stemPackageResult.stems.find((s) => s.stem === stemKey)?.path;
      if (!stemPath) return;
      const url = `${sidecarUrl}/serve_file?path=${encodeURIComponent(stemPath)}`;
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.crossOrigin = "anonymous";
      audio.onloadedmetadata = () => {
        if (!durationSet) { setStemPlayerDuration(audio.duration); durationSet = true; }
      };
      audio.onended = () => { setStemPlayerPlaying(false); setStemPlayerTime(0); stopStemRaf(); };
      stemAudioRefs.current[key] = audio;
      // Load waveform peaks in background
      void loadStemPeaks(key, url);
    });

    return () => {
      stopStemRaf();
      Object.values(stemAudioRefs.current).forEach((a) => { a.pause(); a.src = ""; });
      stemAudioRefs.current = {};
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stemPackageResult]);

  const currentTake = renderResult?.takes[selectedTake];

  const SIDECAR = (import.meta.env.VITE_ANALYSIS_SIDECAR_URL as string | undefined) ?? "http://127.0.0.1:8765";
  const playerSrc = currentTake
    ? `${SIDECAR}/serve_file?path=${encodeURIComponent(currentTake.wavPath)}`
    : "";

  function handleTakeChange(i: number) {
    setSelectedTake(i);
    setIsPlaying(false);
    setPlayerTime(0);
    setPlayerDuration(0);
    stemStop();
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (step === 4 && playerRef.current) togglePlay();
        else if (step === 2 && srcPlayerRef.current) toggleSrcPlay();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const el = step === 4 ? playerRef.current : step === 2 ? srcPlayerRef.current : null;
        if (el) el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const el = step === 4 ? playerRef.current : step === 2 ? srcPlayerRef.current : null;
        if (el) el.currentTime = Math.max(0, el.currentTime - 5);
      } else if (e.code === "Tab" && step === 4 && renderResult) {
        e.preventDefault();
        const next = (selectedTake + (e.shiftKey ? -1 : 1) + renderResult.takes.length) % renderResult.takes.length;
        handleTakeChange(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, selectedTake, renderResult]);

  function togglePlay() {
    const el = playerRef.current;
    if (!el) return;
    if (el.paused) { void el.play(); } else { el.pause(); }
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const el = playerRef.current;
    if (!el) return;
    const t = Number(e.target.value);
    el.currentTime = t;
  }

  function seekFromCanvas(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = ratio * (playerDuration || (currentTake?.durationSeconds ?? 0));
    const nextTime = Math.max(0, t);
    if (playerRef.current) {
      playerRef.current.currentTime = nextTime;
    }
  }

  function resetToStart() {
    stopAllPlayers();
    setStep(1);
    setSelectedFile(null);
    setAnalysisResult(null);
    setRenderResult(null);
    setTransformPreview(null);
    setTransformResult(null);
    setQaResults([]);
    setIsQARunning(false);
  }

  // Source player helpers
  function toggleSrcPlay() {
    const el = srcPlayerRef.current;
    if (!el) return;
    if (el.paused) { void el.play(); } else { el.pause(); }
  }
  function srcSeekFromCanvas(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = ratio * (srcDuration || (analysisResult?.durationSeconds ?? 0));
    if (srcPlayerRef.current) srcPlayerRef.current.currentTime = Math.max(0, t);
  }
  function srcSeek(e: React.ChangeEvent<HTMLInputElement>) {
    if (srcPlayerRef.current) srcPlayerRef.current.currentTime = Number(e.target.value);
  }

  function toggleTransformPreviewPlay() {
    const el = transformPreviewRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  }

  function seekTransformPreview(e: React.ChangeEvent<HTMLInputElement>) {
    const el = transformPreviewRef.current;
    if (!el) return;
    const t = Number(e.target.value);
    el.currentTime = t;
  }

  // Beatgrid canvas dla source playera (DPR-aware + RAF throttle)
  useEffect(() => {
    const canvas = srcBeatgridRef.current;
    if (!canvas || !analysisResult) return;
    let rafId: number;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.offsetWidth;
      const cssH = canvas.offsetHeight || 36;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const W = cssW;
      const H = cssH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const dur = srcDuration || analysisResult.durationSeconds;
      if (!dur) return;
      const toX = (t: number) => (t / dur) * W;

      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(0, 0, W, H);

      // Beat ticks
      if (analysisResult.beatTimestampsSeconds?.length) {
        ctx.fillStyle = "rgba(255,255,255,0.18)";
        for (const t of analysisResult.beatTimestampsSeconds) {
          ctx.fillRect(Math.round(toX(t)), Math.floor(H * 0.6), 1, Math.ceil(H * 0.4));
        }
      }
      // Downbeat ticks
      if (analysisResult.downbeatTimestampsSeconds?.length) {
        ctx.fillStyle = "rgba(165,150,253,0.7)";
        for (const t of analysisResult.downbeatTimestampsSeconds) {
          ctx.fillRect(Math.round(toX(t)), Math.floor(H * 0.25), 1, Math.ceil(H * 0.75));
        }
      }
      // Phrase boundaries (amber)
      if (analysisResult.phraseBoundarySeconds?.length) {
        ctx.fillStyle = "rgba(251,191,36,0.9)";
        for (const t of analysisResult.phraseBoundarySeconds) {
          ctx.fillRect(Math.round(toX(t)) - 1, 0, 2, H);
        }
      }
      // Playhead
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(toX(srcTime)) - 1, 0, 2, H);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [srcTime, srcDuration, analysisResult]);

  // JSON markers export
  function exportMarkersJson() {
    if (!analysisResult) return;
    const payload = {
      bpm: analysisResult.bpm,
      musicalKey: analysisResult.musicalKey,
      camelotKey: analysisResult.camelotKey,
      phraseBars: analysisResult.phraseBars,
      beatIntervalSeconds: analysisResult.beatIntervalSeconds,
      downbeatOffsetSeconds: analysisResult.downbeatOffsetSeconds,
      beatTimestampsSeconds: analysisResult.beatTimestampsSeconds,
      downbeatTimestampsSeconds: analysisResult.downbeatTimestampsSeconds,
      phraseBoundarySeconds: analysisResult.phraseBoundarySeconds,
      durationSeconds: analysisResult.durationSeconds,
      sampleRate: analysisResult.sampleRate,
      exportedAt: new Date().toISOString(),
      file: selectedFile?.name ?? "",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(selectedFile?.name ?? "track").replace(/\.[^.]+$/, "")}_markers.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Rysuj marker track na canvasie (DPR-aware + RAF throttle)
  useEffect(() => {
    const canvas = markerCanvasRef.current;
    if (!canvas) return;
    let rafId: number;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.offsetWidth;
      const cssH = canvas.offsetHeight || 36;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const W = cssW;
      const H = cssH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const dur = playerDuration || (currentTake?.durationSeconds ?? 0);
      if (!dur) return;

      const toX = (t: number) => (t / dur) * W;
      const beatInterval = analysisResult?.beatIntervalSeconds ?? 0;
      const introSec = operationMode !== "outro" && beatInterval > 0 ? introBars * beatInterval * 4 : 0;
      const outroSec = operationMode !== "intro" && beatInterval > 0 ? outroBars * beatInterval * 4 : 0;
      const originalSec = analysisResult?.durationSeconds ?? dur;

      if (introSec > 0) {
        ctx.fillStyle = "rgba(124, 109, 250, 0.18)";
        ctx.fillRect(0, 0, toX(introSec), H);
      }
      ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
      ctx.fillRect(toX(introSec), 0, toX(introSec + originalSec) - toX(introSec), H);
      if (outroSec > 0) {
        ctx.fillStyle = "rgba(74, 222, 128, 0.14)";
        ctx.fillRect(toX(introSec + originalSec), 0, W - toX(introSec + originalSec), H);
      }
      if (analysisResult?.downbeatTimestampsSeconds?.length) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        for (const t of analysisResult.downbeatTimestampsSeconds) {
          ctx.fillRect(Math.round(toX(introSec + t)), Math.floor(H * 0.4), 1, Math.ceil(H * 0.6));
        }
      }
      if (analysisResult?.phraseBoundarySeconds?.length) {
        ctx.fillStyle = "rgba(251, 191, 36, 0.65)";
        for (const t of analysisResult.phraseBoundarySeconds) {
          ctx.fillRect(Math.round(toX(introSec + t)) - 0.5, 0, 1, H);
        }
      }
      if (introSec > 0) {
        ctx.fillStyle = "rgba(165, 150, 253, 0.9)";
        ctx.fillRect(Math.round(toX(introSec)) - 1, 0, 2, H);
      }
      if (outroSec > 0) {
        ctx.fillStyle = "rgba(74, 222, 128, 0.9)";
        ctx.fillRect(Math.round(toX(introSec + originalSec)) - 1, 0, 2, H);
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(toX(playerTime)) - 1, 0, 2, H);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [playerTime, playerDuration, analysisResult, introBars, outroBars, operationMode, currentTake]);

  return (
    <div className="shell">
      {/* Header */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">DJextender</span>
        </div>
        <div className="step-track">
          <StepDot n={1} current={step} />
          <div className={`step-line ${step > 1 ? "step-line--done" : ""}`} />
          <StepDot n={2} current={step} />
          <div className={`step-line ${step > 2 ? "step-line--done" : ""}`} />
          <StepDot n={3} current={step} />
          <div className={`step-line ${step > 3 ? "step-line--done" : ""}`} />
          <StepDot n={4} current={step} />
        </div>
        <div className="topbar-right">
          <button
            className="settings-btn"
            type="button"
            onClick={() => {
              setSettingsOpen(true);
              setTokenSavedBanner("");
            }}
            title="Open settings"
            aria-label="Otwórz ustawienia"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.427 1.756 2.925 0 3.352a1.724 1.724 0 0 0-1.066 2.572c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.427 1.756-2.925 1.756-3.352 0a1.724 1.724 0 0 0-2.572-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.427-1.756-2.925 0-3.352A1.724 1.724 0 0 0 5.38 7.753c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.066Z" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        </div>
      </header>

      {settingsOpen && (
        <div className="settings-overlay" onClick={closeSettings}>
          <section className="settings-modal" onClick={(event) => event.stopPropagation()} aria-label="Settings panel">
            <div className="settings-modal__head">
              <h3>Ustawienia</h3>
              <button className="ghost-button ghost-button--sm" type="button" onClick={closeSettings}>
                Zamknij
              </button>
            </div>

            <div className="config-section">
              <label className="config-label">Ustawienia AI (token Hugging Face)</label>
              <div className="settings-row">
                <input
                  className="settings-input"
                  type="password"
                  placeholder="hf_..."
                  value={huggingfaceTokenInput}
                  onChange={(e) => {
                    setHuggingfaceTokenInput(e.target.value);
                    if (tokenSavedBanner) setTokenSavedBanner("");
                  }}
                />
                <button className="ghost-button" type="button" onClick={saveHuggingfaceToken}>
                  Zapisz token
                </button>
              </div>
              <p className="settings-help">
                Zapisany lokalnie w tej aplikacji — używany tylko do żądań generowania AI.
              </p>
              <p className="settings-help">
                Opcjonalnie: analysis-sidecar/.env z HUGGINGFACE_TOKEN.
              </p>
              {tokenSavedBanner && <p className="settings-help">{tokenSavedBanner}</p>}
            </div>
          </section>
        </div>
      )}

      {/* Main */}
      <main className="main">

        {/* STEP 1: LOAD */}
        {step === 1 && (
          <div className="view view--load">
            <div className="load-hero">
              <h1 className="load-headline">Stwórz swój<br /><em>extended mix</em></h1>
              <p className="load-sub">Wrzuć dowolny utwór DJ — automatycznie dodamy profesjonalne intro i outro.</p>
            </div>

            <div
              className={`dropzone ${dragOver ? "dropzone--over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="dropzone-icon">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="20" r="19" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 3" />
                  <path d="M20 12v16M13 19l7-7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="dropzone-label">Upuść utwór tutaj</p>
              <p className="dropzone-hint">WAV &middot; AIFF &middot; MP3 &nbsp;&mdash;&nbsp; do 320 kbps</p>
              <input ref={fileInputRef} type="file" accept=".wav,.aiff,.aif,.mp3" onChange={handleFileInput} style={{ display: "none" }} />
            </div>

            {sidecarOnline === false && (
              <div className="sidecar-warning">
                <strong>Sidecar nie działa</strong> - uruchom go przed wrzuceniem pliku:
                <code>wsl -d Ubuntu-22.04 -- bash -c "cd /mnt/c/Users/dawid/Desktop/PROJEKTY/DJextender/analysis-sidecar && .venv-wsl2/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8765"</code>
              </div>
            )}

            <div className="load-features">
              <div className="feature-card">
                <span className="feature-icon">AI</span>
                <strong>Analiza AI</strong>
                <p>BPM, tonacja, frazy — wykrywane automatycznie</p>
              </div>
              <div className="feature-card">
                <span className="feature-icon">S</span>
                <strong>Izolacja stemów</strong>
                <p>Demucs izoluje stemy dla czystego intro / outro</p>
              </div>
              <div className="feature-card">
                <span className="feature-icon">DL</span>
                <strong>3 formaty</strong>
                <p>Eksport w WAV 44.1 kHz, MP3 320 kbps i AIFF</p>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: ANALYZE */}
        {step === 2 && (
          <div className="view view--analyze">
            <div className="view-header">
              <h2>Analizuję utwór</h2>
              <p className="view-sub">{selectedFile?.name}</p>
            </div>

            {isAnalyzing && (
              <div className="analysis-progress">
                <p className="progress-label">
                  {analyzeProgress?.label ?? "Rozpoczynam analizę..."}
                  <span className="stage-sub">
                    {analyzeProgress ? ` ${analyzeProgress.step}/${analyzeProgress.total}` : ""}
                  </span>
                </p>
                <div className="progress-bar-wrap">
                  <div
                    className="progress-bar-fill"
                    style={{ width: analyzeProgress ? `${Math.round((analyzeProgress.step / analyzeProgress.total) * 100)}%` : "4%" }}
                  />
                  <span className="progress-bar-pct">
                    {analyzeProgress ? `${Math.round((analyzeProgress.step / analyzeProgress.total) * 100)}%` : "0%"}
                  </span>
                </div>
              </div>
            )}

            {!isAnalyzing && analysisResult && (
              <>
                <div className="analysis-result-grid">
                  <div className="result-tile result-tile--accent">
                    <span>BPM</span>
                    <strong>{analysisResult.bpm}</strong>
                  </div>
                  <div className="result-tile">
                    <span>Tonacja</span>
                    <strong>{analysisResult.musicalKey}</strong>
                  </div>
                  <div className="result-tile">
                    <span>Camelot</span>
                    <strong>{analysisResult.camelotKey || "—"}</strong>
                  </div>
                  <div className="result-tile">
                    <span>Frazy</span>
                    <strong>{analysisResult.phraseBars} bary</strong>
                  </div>
                  <div className="result-tile">
                    <span>Długość</span>
                    <strong>{formatSeconds(analysisResult.durationSeconds)}</strong>
                  </div>
                  <div className={`result-tile result-tile--status ${analysisResult.isProductionReady ? "result-tile--ok" : "result-tile--warn"}`}>
                    <span>Jakość</span>
                    <strong>{analysisResult.isProductionReady ? "Profesjonalny" : "Akceptowalny"}</strong>
                  </div>
                </div>

                {analysisResult.warnings.length > 0 && (
                  <ul className="analysis-warnings-list">
                    {analysisResult.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}

                <button className="cta-button" onClick={() => setStep(3)}>
                <div className="source-player">
                  <audio
                    ref={srcPlayerRef}
                    src={sourceBlobUrl}
                    preload="metadata"
                    onLoadedMetadata={(e) => setSrcDuration(e.currentTarget.duration)}
                    onTimeUpdate={(e) => setSrcTime(e.currentTarget.currentTime)}
                    onPlay={() => setSrcPlaying(true)}
                    onPause={() => setSrcPlaying(false)}
                    onEnded={() => { setSrcPlaying(false); setSrcTime(0); }}
                  />
                  <p className="source-player__label">Podgląd źródła &middot; weryfikuj siatkę beatów</p>
                  <canvas
                    ref={srcBeatgridRef}
                    className="player-markers"
                    height={36}
                    onClick={srcSeekFromCanvas}
                    title="Kliknij aby przewinac"
                  />
                  <div className="player-legend">
                    <span className="legend-dot legend-dot--downbeat" /> Takt
                    <span className="legend-dot legend-dot--phrase" /> Fraza
                    <span className="legend-dot" style={{background:"rgba(255,255,255,0.18)",width:"2px",height:"8px",borderRadius:"1px"}} /> Beat
                  </div>
                  <div className="player-controls">
                    <button className="play-btn" type="button" onClick={toggleSrcPlay}>
                      {srcPlaying ? (
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                          <rect x="3" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                          <rect x="11" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                          <path d="M4 2.5l12 6.5-12 6.5V2.5z" fill="currentColor"/>
                        </svg>
                      )}
                    </button>
                    <span className="player-time">{formatSeconds(srcTime)}</span>
                    <input
                      type="range"
                      className="player-seek"
                      min={0}
                      max={srcDuration || analysisResult.durationSeconds}
                      step={0.1}
                      value={srcTime}
                      onChange={srcSeek}
                    />
                    <span className="player-time player-time--dur">{formatSeconds(srcDuration || analysisResult.durationSeconds)}</span>
                  </div>
                </div>
                  Konfiguruj →
                </button>
              </>
            )}

            {!isAnalyzing && analysisError && (
              <div className="error-card">
                <p className="error-card__title">Analiza nie powiodła się</p>
                <p className="error-card__body">{analysisError}</p>
                <button className="ghost-button" onClick={() => { if (selectedFile) runAnalysis(selectedFile); }}>
                  Ponów
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 3: CONFIGURE */}
        {step === 3 && analysisResult && (
          <div className="view view--configure">
            <div className="view-header">
              <h2>Skonfiguruj swój miks</h2>
              <p className="view-sub">{selectedFile?.name} · {analysisResult.bpm} BPM · {analysisResult.musicalKey}</p>
            </div>

            <div className="config-grid">
              <div className="config-section">
                <label className="config-label">Co dodać</label>
                <PillGroup<OperationMode>
                  options={["intro_outro", "intro", "outro"]}
                  value={operationMode}
                  onChange={setOperationMode}
                  labels={{ intro_outro: "Intro + Outro", intro: "Tylko intro", outro: "Tylko outro" }}
                />
              </div>

              {(operationMode === "intro" || operationMode === "intro_outro") && (
                <div className="config-section">
                  <label className="config-label">Długość intro</label>
                  <PillGroup<string>
                    options={["16", "32", "48"]}
                    value={String(introBars)}
                    onChange={(v) => setIntroBars(Number(v))}
                    labels={{ "16": "16 barów (~30s)", "32": "32 bary (~1 min)", "48": "48 barów (~1.5 min)" }}
                  />
                </div>
              )}

              {(operationMode === "outro" || operationMode === "intro_outro") && (
                <div className="config-section">
                  <label className="config-label">Długość outro</label>
                  <PillGroup<string>
                    options={["16", "32", "48"]}
                    value={String(outroBars)}
                    onChange={(v) => setOutroBars(Number(v))}
                    labels={{ "16": "16 barów (~30s)", "32": "32 bary (~1 min)", "48": "48 barów (~1.5 min)" }}
                  />
                </div>
              )}

              <div className="config-section">
                <label className="config-label">Styl</label>
                <PillGroup<StylePreset>
                  options={["close_to_original", "cleaner_club_edit", "modern_deep_house_edit", "radio_to_club_extended"]}
                  value={stylePreset}
                  onChange={setStylePreset}
                  labels={STYLE_LABELS}
                />
              </div>

              <div className="config-section">
                <label className="config-label">Wokale w intro / outro</label>
                <PillGroup<VocalHandling>
                  options={["no_vocals", "vocal_chops_only", "keep_short_hook"]}
                  value={vocalHandling}
                  onChange={setVocalHandling}
                  labels={VOCAL_LABELS}
                />
              </div>

              <div className="config-section">
                <label className="config-label">Silnik generowania intro/outro</label>
                <PillGroup<AiIntroOutroMode>
                  options={["ai_assisted", "deterministic"]}
                  value={aiIntroOutroMode}
                  onChange={setAiIntroOutroMode}
                  labels={AI_MODE_LABELS}
                />
              </div>

              <div className="config-section">
                <label className="config-label">Nowe BPM (tempo bez zmiany tonacji)</label>
                <div className="transform-inline-row">
                  <input
                    className="settings-input transform-input"
                    type="number"
                    min={60}
                    max={200}
                    step={0.1}
                    value={Number.isFinite(targetBpm) ? targetBpm : analysisResult.bpm}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next)) setTargetBpm(next);
                    }}
                  />
                  <span className="transform-hint">
                    Tempo ratio: {(Math.max(1, targetBpm) / Math.max(analysisResult.bpm, 1)).toFixed(3)}x
                  </span>
                </div>
              </div>

              <div className="config-section">
                <label className="config-label">Zmiana tonacji (półtony, bez zmiany tempa)</label>
                <div className="transform-inline-row">
                  <input
                    className="transform-range"
                    type="range"
                    min={-6}
                    max={6}
                    step={1}
                    value={pitchSemitones}
                    onChange={(e) => setPitchSemitones(Number(e.target.value))}
                  />
                  <span className="transform-semitones">{pitchSemitones >= 0 ? `+${pitchSemitones}` : pitchSemitones} st</span>
                </div>
              </div>

              <div className="config-section">
                <label className="config-label">Docelowa tonacja (alternatywa dla suwaka)</label>
                <div className="transform-inline-row">
                  <select
                    className="settings-input transform-select"
                    value={targetMusicalKey}
                    onChange={(e) => applyTargetKey(e.target.value)}
                  >
                    {KEY_OPTIONS.map((keyOpt) => (
                      <option key={keyOpt} value={keyOpt}>{keyOpt}</option>
                    ))}
                  </select>
                  <span className="transform-hint">Auto ustawia półtony względem {analysisResult.musicalKey}</span>
                </div>
              </div>

            </div>

            <div className="transform-actions">
              <button
                className="ghost-button"
                onClick={handlePreviewTransform}
                disabled={!sidecarOnline || isGenerating || isPreviewingTransform}
              >
                {isPreviewingTransform ? "Generuję preview..." : "Preview 30 sekund"}
              </button>
              <button
                className="ghost-button"
                onClick={handleSaveTransformOnly}
                disabled={!sidecarOnline || isGenerating}
                title={!sidecarOnline ? "Sidecar offline — najpierw uruchom serwer analizy" : undefined}
              >
                Save (tylko transform)
              </button>
              <button
                className="cta-button cta-button--generate"
                onClick={handleGenerate}
                disabled={!sidecarOnline || isGenerating}
                title={!sidecarOnline ? "Sidecar offline — najpierw uruchom serwer analizy" : undefined}
              >
                <span className="cta-icon">?</span>
                Create Intro/Outro
              </button>
            </div>

            {transformPreview && (
              <div className="transform-preview-card">
                <p className="source-player__label">Preview transformacji (30s, Rubber Band)</p>
                <audio
                  ref={transformPreviewRef}
                  src={`${SIDECAR}/serve_file?path=${encodeURIComponent(transformPreview.previewPath)}`}
                  preload="metadata"
                  onLoadedMetadata={(e) => setTransformPreviewDuration(e.currentTarget.duration)}
                  onTimeUpdate={(e) => setTransformPreviewTime(e.currentTarget.currentTime)}
                  onPlay={() => setTransformPreviewPlaying(true)}
                  onPause={() => setTransformPreviewPlaying(false)}
                  onEnded={() => { setTransformPreviewPlaying(false); setTransformPreviewTime(0); }}
                />
                <div className="player-controls">
                  <button className="play-btn" type="button" onClick={toggleTransformPreviewPlay}>
                    {transformPreviewPlaying ? (
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                        <rect x="3" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                        <rect x="11" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                        <path d="M4 2.5l12 6.5-12 6.5V2.5z" fill="currentColor"/>
                      </svg>
                    )}
                  </button>
                  <span className="player-time">{formatSeconds(transformPreviewTime)}</span>
                  <input
                    type="range"
                    className="player-seek"
                    min={0}
                    max={transformPreviewDuration || transformPreview.durationSeconds}
                    step={0.1}
                    value={transformPreviewTime}
                    onChange={seekTransformPreview}
                  />
                  <span className="player-time player-time--dur">{formatSeconds(transformPreviewDuration || transformPreview.durationSeconds)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 4: GENERATE / RESULT */}
        {step === 4 && (
          <div className="view view--result">
            {isGenerating && (
              <div className="generate-progress">
                <div className="generate-spinner">
                  <div className="spinner spinner--large" />
                  <div className="spinner-ring" />
                </div>
                <h2 className="generate-title">Tworzę Twój extended mix...</h2>
                <p className="generate-stage">{sseProgress?.label || generateStage}</p>

                {/* Progress bar */}
                {sseProgress && sseProgress.total > 0 && (
                  <div className="progress-bar-wrap">
                    <div
                      className="progress-bar-fill"
                      style={{width: `${Math.round((sseProgress.step / sseProgress.total) * 100)}%`}}
                    />
                    <span className="progress-bar-pct">{Math.round((sseProgress.step / sseProgress.total) * 100)}%</span>
                  </div>
                )}

                {sseProgress?.elapsed_seconds != null && (
                  <p className="generate-timing">
                    Czas: {Math.floor((sseProgress.elapsed_seconds) / 60)}m {Math.round((sseProgress.elapsed_seconds) % 60)}s
                    {sseProgress.eta_seconds != null && sseProgress.eta_seconds > 0 && (
                      <> · ETA: ~{Math.ceil(sseProgress.eta_seconds / 60)}min</>
                    )}
                  </p>
                )}

                {renderStaleWarning && (
                  <div className="render-stale-warning">
                    ⚠️ {renderStaleWarning}
                    <button
                      className="stale-cancel-btn"
                      onClick={() => { renderAbortRef.current?.abort(); }}
                    >
                      Anuluj render
                    </button>
                  </div>
                )}

                <div className="stage-list">
                  {generationFlow === "transform" ? (
                    <>
                      <div className="stage-item stage-item--active">
                        <span className="stage-dot" />
                        <span>
                          Transformacja Rubber Band
                          {sseProgress && <em className="stage-sub"> — {sseProgress.label}</em>}
                        </span>
                      </div>
                      <div className={`stage-item ${sseProgress && sseProgress.step >= 2 ? "stage-item--done" : ""}`}>
                        <span className="stage-dot" />
                        Eksport formatów WAV/MP3/AIFF
                      </div>
                      <div className={`stage-item ${sseProgress && sseProgress.step >= 3 ? "stage-item--done" : ""}`}>
                        <span className="stage-dot" />
                        Gotowe
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={`stage-item ${generateStage.includes("Separuję") || generateStage.includes("Demucs") ? "stage-item--active" : generateStage && !generateStage.includes("Separuję") ? "stage-item--done" : ""}`}>
                        <span className="stage-dot" />
                        <span>
                          Separacja stemów (AI Demucs)
                          {(generateStage.includes("Separuję") || generateStage.includes("Demucs")) && sseProgress && (
                            <em className="stage-sub"> — {sseProgress.label}</em>
                          )}
                        </span>
                      </div>
                      <div className={`stage-item ${generateStage.includes("Buduję") ? "stage-item--active" : generateStage.includes("Renderuję") || renderResult ? "stage-item--done" : ""}`}>
                        <span className="stage-dot" />
                        Buduję plan aranżacji
                      </div>
                      <div className={`stage-item ${generateStage.includes("Renderuję") ? "stage-item--active" : renderResult ? "stage-item--done" : ""}`}>
                        <span className="stage-dot" />
                        <span>
                          Renderuję audio
                          {generateStage.includes("Renderuję") && sseProgress && (
                            <em className="stage-sub"> — {sseProgress.label}</em>
                          )}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {!isGenerating && generateError && (
              <div className="error-card">
                <p className="error-card__title">Generowanie nie powiodło się</p>
                <p className="error-card__body">{generateError}</p>
                <div className="error-actions">
                  <button className="ghost-button" onClick={() => setStep(3)}>← Powrót do konfiguracji</button>
                  <button className="ghost-button" onClick={handleGenerate}>Ponów</button>
                </div>
              </div>
            )}

            {!isGenerating && transformResult && !renderResult && (
              <div className="result-view">
                <div className="view-header">
                  <h2>Transformacja gotowa</h2>
                  <p className="view-sub">
                    {selectedFile?.name} · {formatSeconds(transformResult.durationSeconds)} · {transformResult.sampleRate / 1000} kHz
                  </p>
                </div>

                <div className="take-card">
                  <p className="take-name">Tempo/tonacja zmienione niezależnie (Rubber Band)</p>
                  <p className="take-meta">
                    Źródło: {analysisResult?.bpm ?? "-"} BPM → Cel: {Math.max(1, targetBpm).toFixed(1)} BPM · Pitch: {pitchSemitones >= 0 ? `+${pitchSemitones}` : pitchSemitones} st
                  </p>

                  <div className="download-grid">
                    <button className="download-btn download-btn--wav" onClick={() => openFile(transformResult.wavPath)}>
                      <span className="dl-icon">&#8659;</span>
                      <span className="dl-label">WAV</span>
                      <span className="dl-sub">44.1 kHz · 24-bit</span>
                    </button>
                    <button className="download-btn download-btn--mp3" onClick={() => openFile(transformResult.mp3Path)}>
                      <span className="dl-icon">&#8659;</span>
                      <span className="dl-label">MP3</span>
                      <span className="dl-sub">320 kbps</span>
                    </button>
                    <button className="download-btn download-btn--aiff" onClick={() => openFile(transformResult.aiffPath)}>
                      <span className="dl-icon">&#8659;</span>
                      <span className="dl-label">AIFF</span>
                      <span className="dl-sub">Lossless</span>
                    </button>
                  </div>

                  <div className="take-actions">
                    <button className="open-folder-btn" onClick={() => openFolder(transformResult.outputDirectory)}>
                      Otwórz folder wynikowy
                    </button>
                    <button className="ghost-button ghost-button--sm" onClick={() => setStep(3)}>
                      ← Wróć do konfiguracji
                    </button>
                  </div>

                  {transformResult.warnings.length > 0 && (
                    <ul className="analysis-warnings-list">
                      {transformResult.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {!isGenerating && renderResult && (
              <div className="result-view">
                <div className="view-header">
                  <h2>Twój extended mix jest gotowy</h2>
                  <p className="view-sub">{selectedFile?.name} · {renderResult.takes.length} take{renderResult.takes.length !== 1 ? "s" : ""} · {formatSeconds(renderResult.takes[0]?.durationSeconds ?? 0)}</p>
                </div>

                {renderResult.takes.length > 1 && (
                  <div className="take-tabs">
                    {renderResult.takes.map((take, i) => (
                      <button
                        key={take.takeIndex}
                        type="button"
                        className={`take-tab ${i === selectedTake ? "take-tab--active" : ""}`}
                        onClick={() => handleTakeChange(i)}
                      >
                        Take {take.takeIndex}
                        <span className="take-tab-sub">{take.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {currentTake && (
                  <div className="take-card">
                    <div className="take-info">
                      <p className="take-name">{currentTake.label}</p>
                      <p className="take-meta">{formatSeconds(currentTake.durationSeconds)} &middot; {currentTake.sampleRate / 1000} kHz &middot; -14 dBFS RMS</p>
                    </div>

                    {/* In-app player */}
                    <div className="take-player">
                      <audio
                        ref={playerRef}
                        src={playerSrc}
                        preload="metadata"
                        onLoadedMetadata={(e) => setPlayerDuration(e.currentTarget.duration)}
                        onTimeUpdate={(e) => {
                          const t = e.currentTarget.currentTime;
                          setPlayerTime(t);
                        }}
                        onPlay={() => {
                          setIsPlaying(true);
                        }}
                        onPause={() => {
                          setIsPlaying(false);
                        }}
                        onEnded={() => {
                          setIsPlaying(false);
                          setPlayerTime(0);
                        }}
                      />
                      {/* Marker track canvas */}
                      <canvas
                        ref={markerCanvasRef}
                        className="player-markers"
                        height={36}
                        onClick={seekFromCanvas}
                        title="Kliknij aby przewinac"
                      />
                      {/* Legenda markerow */}
                      <div className="player-legend">
                        <span className="legend-dot legend-dot--intro" /> Intro
                        <span className="legend-dot legend-dot--original" /> Oryginał
                        {operationMode !== "intro" && <><span className="legend-dot legend-dot--outro" /> Outro</>}
                        <span className="legend-dot legend-dot--phrase" /> Fraza
                        <span className="legend-dot legend-dot--downbeat" /> Takt
                      </div>
                      {/* Controls */}
                      <div className="player-controls">
                        <button className="play-btn" type="button" onClick={togglePlay}>
                          {isPlaying ? (
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                              <rect x="3" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                              <rect x="11" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                              <path d="M4 2.5l12 6.5-12 6.5V2.5z" fill="currentColor"/>
                            </svg>
                          )}
                        </button>
                        <span className="player-time">{formatSeconds(playerTime)}</span>
                        <input
                          type="range"
                          className="player-seek"
                          min={0}
                          max={playerDuration || currentTake.durationSeconds}
                          step={0.1}
                          value={playerTime}
                          onChange={seek}
                        />
                        <span className="player-time player-time--dur">{formatSeconds(playerDuration || currentTake.durationSeconds)}</span>
                      </div>
                    </div>
                    <div className="download-grid">
                      <button
                        className="download-btn download-btn--wav"
                        onClick={() => openFile(currentTake.wavPath)}
                      >
                        <span className="dl-icon">&#8659;</span>
                        <span className="dl-label">WAV</span>
                        <span className="dl-sub">44.1 kHz &middot; 24-bit</span>
                      </button>
                      <button
                        className="download-btn download-btn--mp3"
                        onClick={() => openFile(currentTake.mp3Path)}
                      >
                        <span className="dl-icon">&#8659;</span>
                        <span className="dl-label">MP3</span>
                        <span className="dl-sub">320 kbps</span>
                      </button>
                      <button
                        className="download-btn download-btn--aiff"
                        onClick={() => openFile(currentTake.aiffPath)}
                      >
                        <span className="dl-icon">&#8659;</span>
                        <span className="dl-label">AIFF</span>
                        <span className="dl-sub">Lossless</span>
                      </button>
                    </div>

                    <div className="take-actions">
                      <button
                        className="open-folder-btn"
                        onClick={() => openFolder(renderResult.outputDirectory)}
                      >
                        Otwórz folder wynikowy
                      </button>
                      <button
                        className="ghost-button ghost-button--sm"
                        onClick={exportMarkersJson}
                        title="Eksportuj JSON z siatką beatów i markerami fraz"
                      >
                        Eksportuj JSON markerów
                      </button>
                    </div>
                  </div>
                )}

                {renderResult.warnings.length > 0 && (
                  <ul className="analysis-warnings-list">
                    {renderResult.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                )}

                {/* Stem Player */}
                {stemPackageResult && stemPackageResult.stems && (
                  <div className="stem-player">
                    <p className="stem-player__title">Podgląd stemów</p>
                    <div className="stem-rows">
                      {([
                        { id: "drums", stemKey: "drums", label: "Perkusja" },
                        { id: "bass", stemKey: "bass", label: "Bas" },
                        { id: "melody", stemKey: "other", label: "Melodia" },
                        { id: "vocals", stemKey: "vocals", label: "Wokale" },
                      ] as const).map((layer) => {
                        const stemPath = stemPackageResult.stems.find((s) => s.stem === layer.stemKey)?.path ?? null;
                        const isEnabled = enabledStemLayers.has(layer.id);
                        return (
                          <div key={layer.id} className={`stem-row ${isEnabled ? "stem-row--enabled" : "stem-row--muted"}`}>
                            <div className="stem-row__header">
                              <span className="stem-row__label">{layer.label}</span>
                              <button
                                className={`stem-toggle ${isEnabled ? "stem-toggle--on" : "stem-toggle--off"}`}
                                onClick={() => toggleStemEnabled(layer.id)}
                                disabled={!stemPath}
                                title={isEnabled ? "Wycisz warstwę" : "Włącz warstwę"}
                              >
                                {isEnabled ? "ON" : "OFF"}
                              </button>
                            </div>
                            <canvas
                              className="stem-waveform"
                              height={48}
                              ref={(el) => { stemCanvasRefs.current[layer.id] = el; }}
                            />
                          </div>
                        );
                      })}
                    </div>
                    {/* Stem player controls — independent from main player */}
                    <div className="stem-controls">
                      <div className="player-controls">
                        <button
                          className="play-btn"
                          type="button"
                          onClick={() => { if (stemPlayerPlaying) stemPause(); else void stemPlay(); }}
                        >
                          {stemPlayerPlaying ? (
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                              <rect x="3" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                              <rect x="11" y="2" width="4" height="14" rx="1.5" fill="currentColor"/>
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                              <path d="M4 2.5l12 6.5-12 6.5V2.5z" fill="currentColor"/>
                            </svg>
                          )}
                        </button>
                        <button
                          className="play-btn play-btn--stop"
                          type="button"
                          onClick={stemStop}
                          title="Stop"
                        >
                          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                            <rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor"/>
                          </svg>
                        </button>
                        <span className="player-time">{formatSeconds(stemPlayerTime)}</span>
                        <input
                          type="range"
                          className="player-seek"
                          min={0}
                          max={stemPlayerDuration || 1}
                          step={0.1}
                          value={stemPlayerTime}
                          onChange={stemSeek}
                        />
                        <span className="player-time player-time--dur">{formatSeconds(stemPlayerDuration)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* QA Results panel */}
                {isQARunning && (
                  <div className="qa-panel">
                    <p className="qa-panel__title">Auto QA</p>
                    <div className="qa-running">
                      <span className="qa-running__dot" />
                      <span className="qa-running__dot qa-running__dot--2" />
                      <span className="qa-running__dot qa-running__dot--3" />
                      <span className="qa-running__label">Analizuję jakość&hellip;</span>
                    </div>
                  </div>
                )}
                {!isQARunning && qaResults.length > 0 && (
                  <div className="qa-panel">
                    <p className="qa-panel__title">Auto QA</p>
                    {qaResults.map((qa, i) => (
                      <div key={i} className={`qa-card ${qa.passed ? "qa-card--pass" : "qa-card--fail"}`}>
                        <div className="qa-card__header">
                          <span className={`qa-badge ${qa.passed ? "qa-badge--pass" : "qa-badge--fail"}`}>
                            {qa.passed ? "PASS" : "FAIL"}
                          </span>
                          <span className="qa-card__label">Take {i + 1}</span>
                          <span className="qa-card__score">{Math.round(qa.score * 100)}%</span>
                        </div>
                        <div className="qa-gates">
                          {qa.gates.map((g) => (
                            <div key={g.id} className={`qa-gate ${g.passed ? "qa-gate--pass" : "qa-gate--fail"}`}>
                              <span className="qa-gate__dot" />
                              <span className="qa-gate__label">{g.label}</span>
                              <span className="qa-gate__value">{g.value} {g.unit}</span>
                            </div>
                          ))}
                        </div>
                        {qa.warnings.length > 0 && (
                          <ul className="qa-warnings">
                            {qa.warnings.map((w) => <li key={w}>{w}</li>)}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <button className="ghost-button mt-24" onClick={resetToStart}>
                  ↩ Rozszerz kolejny utwór
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
