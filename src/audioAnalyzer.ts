import { fft } from "fft-js";

type PhraseBars = 4 | 8 | 16;

export type StructureSection = {
  startSeconds: number;
  endSeconds: number;
  bars: number;
  energy: "low" | "mid" | "high";
};

export type AnalysisGate = {
  id: string;
  label: string;
  value: number;
  threshold: number;
  passed: boolean;
};

export type TimelineMarkerType = "beat" | "downbeat" | "phrase_start";

export type TimelineMarker = {
  type: TimelineMarkerType;
  seconds: number;
  beatIndex: number;
  barIndex: number;
  beatInBar: number;
  phraseIndex: number;
};

export type AudioAnalysisResult = {
  bpm: number;
  bpmSecondary: number;
  bpmConfidence: number;
  musicalKey: string;
  camelotKey: string;
  keyConfidence: number;
  phraseBars: PhraseBars;
  phraseConfidence: number;
  beatIntervalSeconds: number;
  beatCount: number;
  downbeatOffsetSeconds: number;
  downbeatConfidence: number;
  structureSections: StructureSection[];
  beatTimestampsSeconds: number[];
  downbeatTimestampsSeconds: number[];
  phraseBoundarySeconds: number[];
  timelineMarkers: TimelineMarker[];
  overallScore: number;
  isProductionReady: boolean;
  gates: AnalysisGate[];
  durationSeconds: number;
  sampleRate: number;
  warnings: string[];
  analyzerEngine?: "local-dsp" | "pro-sidecar";
};

const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

const KRUMHANSL_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];

const KRUMHANSL_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

const CAMELOT_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const CAMELOT_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];

function hanningWindow(length: number): Float32Array {
  const window = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
  }

  return window;
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values.map((value) => Math.abs(value)), 1e-8);
  return values.map((value) => value / max);
}

function downmixAndDecimate(
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
): { signal: Float32Array; sampleRate: number } {
  const sourceRate = audioBuffer.sampleRate;
  const ratio = Math.max(1, Math.floor(sourceRate / targetSampleRate));
  const sourceLength = audioBuffer.length;
  const targetLength = Math.floor(sourceLength / ratio);
  const signal = new Float32Array(targetLength);
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) =>
    audioBuffer.getChannelData(i),
  );

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index * ratio;
    let sum = 0;

    for (let channel = 0; channel < channels.length; channel += 1) {
      sum += channels[channel][sourceIndex] ?? 0;
    }

    signal[index] = sum / channels.length;
  }

  return { signal, sampleRate: sourceRate / ratio };
}

function computeSpectralFlux(
  signal: Float32Array,
  sampleRate: number,
): { flux: number[]; envelopeRate: number } {
  const frameSize = 1024;
  const hopSize = 256;
  const window = hanningWindow(frameSize);

  const frameCount = Math.max(0, Math.floor((signal.length - frameSize) / hopSize));
  const flux: number[] = [];
  let previousMagnitudes = new Array(frameSize / 2).fill(0);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    const frameBuffer = new Array<number>(frameSize);

    for (let sample = 0; sample < frameSize; sample += 1) {
      frameBuffer[sample] = (signal[start + sample] ?? 0) * window[sample];
    }

    const spectrum = fft(frameBuffer) as Array<[number, number]>;
    const magnitudes = new Array<number>(frameSize / 2).fill(0);

    for (let bin = 0; bin < frameSize / 2; bin += 1) {
      const [real, imag] = spectrum[bin];
      magnitudes[bin] = Math.sqrt(real * real + imag * imag);
    }

    let fluxValue = 0;
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      const delta = magnitudes[bin] - previousMagnitudes[bin];
      if (delta > 0) {
        fluxValue += delta;
      }
    }

    flux.push(fluxValue);
    previousMagnitudes = magnitudes;
  }

  const normalized = normalize(flux);
  return { flux: normalized, envelopeRate: sampleRate / hopSize };
}

function computeAutocorrelation(values: number[], maxLag: number): number[] {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const centered = values.map((value) => value - mean);
  const autocorrelation = new Array(maxLag + 1).fill(0);

  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0;
    let norm = 0;

    for (let index = 0; index + lag < centered.length; index += 1) {
      const a = centered[index];
      const b = centered[index + lag];
      sum += a * b;
      norm += a * a;
    }

    autocorrelation[lag] = norm > 0 ? sum / norm : 0;
  }

  return autocorrelation;
}

function detectBpm(flux: number[], envelopeRate: number): { bpm: number; confidence: number } {
  const minBpm = 70;
  const maxBpm = 180;
  const maxLag = Math.ceil((envelopeRate * 60) / minBpm) * 2;
  const autocorrelation = computeAutocorrelation(flux, maxLag);

  let bestBpm = 120;
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let bpm = minBpm; bpm <= maxBpm; bpm += 1) {
    const lag = Math.round((envelopeRate * 60) / bpm);
    const lag2 = lag * 2;
    const lag3 = lag * 3;

    const score =
      (autocorrelation[lag] ?? 0) +
      0.5 * (autocorrelation[lag2] ?? 0) +
      0.25 * (autocorrelation[lag3] ?? 0);

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestBpm = bpm;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const confidence =
    bestScore <= 0 ? 0 : Math.min(1, Math.max(0, 0.5 + (bestScore - secondScore) * 2));

  return { bpm: bestBpm, confidence };
}

function detectBpmByPeakIntervals(
  peaks: number[],
  envelopeRate: number,
): { bpm: number; confidence: number } {
  if (peaks.length < 2) {
    return { bpm: 120, confidence: 0 };
  }

  const histogram = new Map<number, number>();
  const minBpm = 70;
  const maxBpm = 180;

  for (let index = 1; index < peaks.length; index += 1) {
    const intervalFrames = peaks[index] - peaks[index - 1];
    if (intervalFrames <= 0) {
      continue;
    }

    let bpm = (60 * envelopeRate) / intervalFrames;
    while (bpm < minBpm) {
      bpm *= 2;
    }
    while (bpm > maxBpm) {
      bpm /= 2;
    }

    const rounded = Math.round(bpm);
    histogram.set(rounded, (histogram.get(rounded) ?? 0) + 1);
  }

  if (histogram.size === 0) {
    return { bpm: 120, confidence: 0 };
  }

  const ordered = [...histogram.entries()].sort((left, right) => right[1] - left[1]);
  const [bestBpm, bestVotes] = ordered[0];
  const secondVotes = ordered[1]?.[1] ?? 0;
  const confidence = Math.min(1, Math.max(0, 0.4 + (bestVotes - secondVotes) / Math.max(bestVotes, 1)));

  return { bpm: bestBpm, confidence };
}

function rotate(values: number[], amount: number): number[] {
  const length = values.length;
  const result = new Array(length).fill(0);

  for (let index = 0; index < length; index += 1) {
    result[index] = values[(index + amount) % length];
  }

  return result;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (denominator === 0) {
    return 0;
  }

  return dot / denominator;
}

function detectKey(signal: Float32Array, sampleRate: number): { key: string; confidence: number } {
  const frameSize = 4096;
  const hopSize = 1024;
  const window = hanningWindow(frameSize);
  const chroma = new Array(12).fill(0);

  const frameCount = Math.max(0, Math.floor((signal.length - frameSize) / hopSize));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSize;
    const frameBuffer = new Array<number>(frameSize);

    for (let sample = 0; sample < frameSize; sample += 1) {
      frameBuffer[sample] = (signal[start + sample] ?? 0) * window[sample];
    }

    const spectrum = fft(frameBuffer) as Array<[number, number]>;

    for (let bin = 1; bin < frameSize / 2; bin += 1) {
      const [real, imag] = spectrum[bin];
      const magnitude = Math.sqrt(real * real + imag * imag);
      const frequency = (bin * sampleRate) / frameSize;

      if (frequency < 50 || frequency > 5000 || magnitude < 1e-6) {
        continue;
      }

      const midi = 69 + 12 * Math.log2(frequency / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pitchClass] += magnitude;
    }
  }

  const normalizedChroma = normalize(chroma);

  let bestLabel = "C major";
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let keyIndex = 0; keyIndex < 12; keyIndex += 1) {
    const majorScore = cosineSimilarity(normalizedChroma, rotate(KRUMHANSL_MAJOR, keyIndex));
    const minorScore = cosineSimilarity(normalizedChroma, rotate(KRUMHANSL_MINOR, keyIndex));

    const candidates: Array<{ label: string; score: number }> = [
      { label: `${NOTE_NAMES[keyIndex]} major`, score: majorScore },
      { label: `${NOTE_NAMES[keyIndex]} minor`, score: minorScore },
    ];

    for (const candidate of candidates) {
      if (candidate.score > bestScore) {
        secondScore = bestScore;
        bestScore = candidate.score;
        bestLabel = candidate.label;
      } else if (candidate.score > secondScore) {
        secondScore = candidate.score;
      }
    }
  }

  const confidence =
    bestScore <= 0 ? 0 : Math.min(1, Math.max(0, 0.5 + (bestScore - secondScore) * 2));

  return { key: bestLabel, confidence };
}

function toCamelot(musicalKey: string): string {
  const [noteRaw, modeRaw] = musicalKey.split(" ");
  const mode = (modeRaw ?? "").toLowerCase();
  const noteIndex = NOTE_NAMES.findIndex((name) => name.toLowerCase() === noteRaw.toLowerCase());

  if (noteIndex < 0) {
    return "Unknown";
  }

  if (mode === "minor") {
    return CAMELOT_MINOR[noteIndex];
  }

  if (mode === "major") {
    return CAMELOT_MAJOR[noteIndex];
  }

  return "Unknown";
}

function detectPhraseBars(
  flux: number[],
  envelopeRate: number,
  bpm: number,
): { phraseBars: PhraseBars; confidence: number } {
  const candidates: PhraseBars[] = [4, 8, 16];
  const barSeconds = 240 / bpm;
  const barFrames = Math.max(1, Math.round(barSeconds * envelopeRate));
  let bestCandidate: PhraseBars = 8;
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (const candidate of candidates) {
    const phraseFrames = candidate * barFrames;
    let contrastSum = 0;
    let count = 0;

    for (let boundary = phraseFrames; boundary < flux.length - phraseFrames; boundary += phraseFrames) {
      const previous = flux.slice(boundary - barFrames, boundary);
      const next = flux.slice(boundary, boundary + barFrames);

      const previousMean =
        previous.reduce((sum, value) => sum + value, 0) / Math.max(previous.length, 1);
      const nextMean = next.reduce((sum, value) => sum + value, 0) / Math.max(next.length, 1);
      contrastSum += Math.abs(nextMean - previousMean);
      count += 1;
    }

    const score = count > 0 ? contrastSum / count : 0;

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestCandidate = candidate;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const confidence =
    bestScore <= 0 ? 0 : Math.min(1, Math.max(0, 0.5 + (bestScore - secondScore) * 8));

  return { phraseBars: bestCandidate, confidence };
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

function detectLocalPeaks(flux: number[]): number[] {
  const peaks: number[] = [];
  if (flux.length < 3) {
    return peaks;
  }

  const sorted = [...flux].sort((left, right) => right - left);
  const threshold = sorted[Math.floor(sorted.length * 0.75)] ?? 0.2;

  for (let index = 1; index < flux.length - 1; index += 1) {
    const current = flux[index];
    if (current < threshold) {
      continue;
    }

    if (current >= flux[index - 1] && current >= flux[index + 1]) {
      peaks.push(index);
    }
  }

  return peaks;
}

function energyAtFrame(flux: number[], frame: number): number {
  const center = clamp(Math.round(frame), 0, flux.length - 1);
  const left = clamp(center - 1, 0, flux.length - 1);
  const right = clamp(center + 1, 0, flux.length - 1);
  return (flux[left] + flux[center] + flux[right]) / 3;
}

function detectBeatGrid(
  flux: number[],
  envelopeRate: number,
  bpm: number,
): { beatFrames: number[]; beatIntervalFrames: number; confidence: number } {
  const beatIntervalFrames = Math.max(1, (envelopeRate * 60) / bpm);
  const roundedInterval = Math.max(1, Math.round(beatIntervalFrames));
  const peaks = detectLocalPeaks(flux);

  if (peaks.length === 0) {
    return { beatFrames: [], beatIntervalFrames, confidence: 0 };
  }

  let bestPhase = 0;
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let phase = 0; phase < roundedInterval; phase += 1) {
    let score = 0;
    let samples = 0;

    for (let frame = phase; frame < flux.length; frame += beatIntervalFrames) {
      score += energyAtFrame(flux, frame);
      samples += 1;
    }

    const normalizedScore = samples > 0 ? score / samples : 0;
    if (normalizedScore > bestScore) {
      secondScore = bestScore;
      bestScore = normalizedScore;
      bestPhase = phase;
    } else if (normalizedScore > secondScore) {
      secondScore = normalizedScore;
    }
  }

  const beatFrames: number[] = [];
  for (let frame = bestPhase; frame < flux.length; frame += beatIntervalFrames) {
    beatFrames.push(frame);
  }

  const confidence =
    bestScore <= 0 ? 0 : Math.min(1, Math.max(0, 0.45 + (bestScore - secondScore) * 5));

  return { beatFrames, beatIntervalFrames, confidence };
}

function detectDownbeat(
  flux: number[],
  beatFrames: number[],
): { downbeatOffset: number; downbeatConfidence: number } {
  if (beatFrames.length < 8) {
    return { downbeatOffset: 0, downbeatConfidence: 0 };
  }

  let bestOffset = 0;
  let bestScore = -Infinity;
  let secondScore = -Infinity;

  for (let offset = 0; offset < 4; offset += 1) {
    let downbeatEnergy = 0;
    let otherEnergy = 0;
    let downbeatCount = 0;
    let otherCount = 0;

    for (let index = 0; index < beatFrames.length; index += 1) {
      const energy = energyAtFrame(flux, beatFrames[index]);
      if (index % 4 === offset) {
        downbeatEnergy += energy;
        downbeatCount += 1;
      } else {
        otherEnergy += energy;
        otherCount += 1;
      }
    }

    const score =
      (downbeatEnergy / Math.max(downbeatCount, 1)) -
      (otherEnergy / Math.max(otherCount, 1));

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestOffset = offset;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const downbeatConfidence =
    bestScore <= 0 ? 0 : Math.min(1, Math.max(0, 0.45 + (bestScore - secondScore) * 4));

  return { downbeatOffset: bestOffset, downbeatConfidence };
}

function classifyEnergy(value: number): "low" | "mid" | "high" {
  if (value < 0.33) {
    return "low";
  }

  if (value < 0.66) {
    return "mid";
  }

  return "high";
}

function buildStructureSections(
  flux: number[],
  envelopeRate: number,
  beatFrames: number[],
  downbeatOffset: number,
  phraseBars: PhraseBars,
): StructureSection[] {
  const beatsPerPhrase = phraseBars * 4;
  const sections: StructureSection[] = [];

  if (beatFrames.length < beatsPerPhrase + downbeatOffset) {
    return sections;
  }

  const startIndex = downbeatOffset;
  const sectionScores: number[] = [];

  for (let beatIndex = startIndex; beatIndex + beatsPerPhrase < beatFrames.length; beatIndex += beatsPerPhrase) {
    const sectionStartFrame = beatFrames[beatIndex];
    const sectionEndFrame = beatFrames[beatIndex + beatsPerPhrase];

    const fluxStart = clamp(Math.floor(sectionStartFrame), 0, flux.length - 1);
    const fluxEnd = clamp(Math.floor(sectionEndFrame), fluxStart + 1, flux.length - 1);
    const window = flux.slice(fluxStart, fluxEnd);
    const meanEnergy =
      window.reduce((sum, value) => sum + value, 0) / Math.max(window.length, 1);

    sectionScores.push(meanEnergy);
    sections.push({
      startSeconds: sectionStartFrame / envelopeRate,
      endSeconds: sectionEndFrame / envelopeRate,
      bars: phraseBars,
      energy: "mid",
    });
  }

  if (sections.length === 0) {
    return sections;
  }

  const normalizedScores = normalize(sectionScores);
  for (let index = 0; index < sections.length; index += 1) {
    sections[index].energy = classifyEnergy((normalizedScores[index] + 1) / 2);
  }

  return sections;
}

function buildTimelineMarkers(
  beatFrames: number[],
  envelopeRate: number,
  downbeatOffset: number,
  phraseBars: PhraseBars,
): {
  beatTimestampsSeconds: number[];
  downbeatTimestampsSeconds: number[];
  phraseBoundarySeconds: number[];
  timelineMarkers: TimelineMarker[];
} {
  const beatTimestampsSeconds: number[] = [];
  const downbeatTimestampsSeconds: number[] = [];
  const phraseBoundarySeconds: number[] = [];
  const timelineMarkers: TimelineMarker[] = [];

  for (let index = 0; index < beatFrames.length; index += 1) {
    const seconds = beatFrames[index] / envelopeRate;
    const relativeBeat = index - downbeatOffset;
    const isAligned = relativeBeat >= 0;
    const beatInBar = isAligned ? (relativeBeat % 4) + 1 : ((relativeBeat % 4) + 4) % 4 + 1;
    const barIndex = isAligned ? Math.floor(relativeBeat / 4) + 1 : 0;
    const phraseIndex = barIndex > 0 ? Math.floor((barIndex - 1) / phraseBars) + 1 : 0;

    beatTimestampsSeconds.push(seconds);
    timelineMarkers.push({
      type: "beat",
      seconds,
      beatIndex: index + 1,
      barIndex,
      beatInBar,
      phraseIndex,
    });

    if (isAligned && relativeBeat % 4 === 0) {
      downbeatTimestampsSeconds.push(seconds);
      timelineMarkers.push({
        type: "downbeat",
        seconds,
        beatIndex: index + 1,
        barIndex,
        beatInBar,
        phraseIndex,
      });

      const barsFromStart = barIndex - 1;
      if (barsFromStart % phraseBars === 0) {
        phraseBoundarySeconds.push(seconds);
        timelineMarkers.push({
          type: "phrase_start",
          seconds,
          beatIndex: index + 1,
          barIndex,
          beatInBar,
          phraseIndex,
        });
      }
    }
  }

  return {
    beatTimestampsSeconds,
    downbeatTimestampsSeconds,
    phraseBoundarySeconds,
    timelineMarkers,
  };
}

export async function analyzeAudioFile(file: File): Promise<AudioAnalysisResult> {
  const audioContext = new AudioContext();

  try {
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const durationSeconds = audioBuffer.duration;

    const targetSampleRate = 11025;
    const { signal, sampleRate } = downmixAndDecimate(audioBuffer, targetSampleRate);
    const { flux, envelopeRate } = computeSpectralFlux(signal, sampleRate);
    const peaks = detectLocalPeaks(flux);
    const bpmPrimary = detectBpm(flux, envelopeRate);
    const bpmSecondary = detectBpmByPeakIntervals(peaks, envelopeRate);
    const bpmAgreement = Math.abs(bpmPrimary.bpm - bpmSecondary.bpm);
    const bpm = bpmAgreement <= 3
      ? Math.round((bpmPrimary.bpm + bpmSecondary.bpm) / 2)
      : bpmPrimary.bpm;
    const bpmConfidenceBase =
      bpmAgreement <= 3
        ? (bpmPrimary.confidence + bpmSecondary.confidence) / 2
        : bpmPrimary.confidence * 0.82;
    const bpmConfidence = Math.max(0, Math.min(1, bpmConfidenceBase));

    const beatGrid = detectBeatGrid(flux, envelopeRate, bpm);
    const { downbeatOffset, downbeatConfidence } = detectDownbeat(flux, beatGrid.beatFrames);
    const { key, confidence: keyConfidence } = detectKey(signal, sampleRate);
    const camelotKey = toCamelot(key);
    const { phraseBars, confidence: phraseConfidence } = detectPhraseBars(
      flux,
      envelopeRate,
      bpm,
    );
    const structureSections = buildStructureSections(
      flux,
      envelopeRate,
      beatGrid.beatFrames,
      downbeatOffset,
      phraseBars,
    );
    const downbeatBeatIndex = beatGrid.beatFrames.length > downbeatOffset ? downbeatOffset : 0;
    const downbeatOffsetSeconds =
      beatGrid.beatFrames.length > 0
        ? beatGrid.beatFrames[downbeatBeatIndex] / envelopeRate
        : 0;
    const beatIntervalSeconds = beatGrid.beatIntervalFrames / envelopeRate;
    const timeline = buildTimelineMarkers(
      beatGrid.beatFrames,
      envelopeRate,
      downbeatOffset,
      phraseBars,
    );

    const gates: AnalysisGate[] = [
      {
        id: "bpm_consensus",
        label: "BPM consensus confidence",
        value: bpmConfidence,
        threshold: 0.72,
        passed: bpmConfidence >= 0.72,
      },
      {
        id: "key_confidence",
        label: "Harmonic key confidence",
        value: keyConfidence,
        threshold: 0.65,
        passed: keyConfidence >= 0.65,
      },
      {
        id: "phrase_confidence",
        label: "Phrase segmentation confidence",
        value: phraseConfidence,
        threshold: 0.7,
        passed: phraseConfidence >= 0.7,
      },
      {
        id: "downbeat_confidence",
        label: "Downbeat lock confidence",
        value: downbeatConfidence,
        threshold: 0.7,
        passed: downbeatConfidence >= 0.7,
      },
      {
        id: "structure_density",
        label: "Minimum phrase sections",
        value: Math.min(1, structureSections.length / 6),
        threshold: 0.5,
        passed: structureSections.length >= 3,
      },
    ];

    const overallScore =
      gates.reduce((sum, gate) => sum + gate.value, 0) / Math.max(gates.length, 1);
    const isProductionReady = gates.every((gate) => gate.passed);

    const warnings: string[] = [];
    if (bpmConfidence < 0.6) {
      warnings.push("Low BPM confidence. Consider manual verification against beatgrid.");
    }

    if (keyConfidence < 0.6) {
      warnings.push("Low key confidence. Harmonic profile may contain modal ambiguity.");
    }

    if (phraseConfidence < 0.6) {
      warnings.push("Low phrase confidence. Verify phrase boundaries before render.");
    }

    if (beatGrid.confidence < 0.6) {
      warnings.push("Low beatgrid confidence. Verify kick alignment before export.");
    }

    if (downbeatConfidence < 0.55) {
      warnings.push("Low downbeat confidence. Confirm bar-1 location manually.");
    }

    if (!isProductionReady) {
      for (const gate of gates) {
        if (!gate.passed) {
          warnings.push(
            `Quality gate failed: ${gate.label} (${Math.round(gate.value * 100)}% < ${Math.round(
              gate.threshold * 100,
            )}%).`,
          );
        }
      }
    }

    return {
      bpm,
      bpmSecondary: bpmSecondary.bpm,
      bpmConfidence,
      musicalKey: key,
      camelotKey,
      keyConfidence,
      phraseBars,
      phraseConfidence,
      beatIntervalSeconds,
      beatCount: beatGrid.beatFrames.length,
      downbeatOffsetSeconds,
      downbeatConfidence,
      structureSections,
      beatTimestampsSeconds: timeline.beatTimestampsSeconds,
      downbeatTimestampsSeconds: timeline.downbeatTimestampsSeconds,
      phraseBoundarySeconds: timeline.phraseBoundarySeconds,
      timelineMarkers: timeline.timelineMarkers,
      overallScore,
      isProductionReady,
      gates,
      durationSeconds,
      sampleRate,
      warnings,
      analyzerEngine: "local-dsp",
    };
  } finally {
    await audioContext.close();
  }
}
