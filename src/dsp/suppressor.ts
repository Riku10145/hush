import {
  BIN_COUNT,
  COLA_GAIN,
  createRealFft,
  FFT_SIZE,
  HOP_SIZE,
  sqrtHannWindow,
} from "./fft";

export type Strength = number & { readonly __brand: "Strength" };

export function strength(value: number): Strength {
  if (!Number.isFinite(value)) {
    return 0 as Strength;
  }
  return Math.min(1, Math.max(0, value)) as Strength;
}

export type HowlVerdict =
  | { readonly kind: "clear"; readonly margin: number }
  | { readonly kind: "trip"; readonly peakHz: number };

export type FrameReport =
  | {
      readonly kind: "calibrating";
      readonly framesSeeded: number;
      readonly framesNeeded: number;
      readonly inputLevel: number;
    }
  | {
      readonly kind: "suppressing";
      readonly inputLevel: number;
      readonly outputLevel: number;
      readonly reductionDb: number;
      readonly howl: HowlVerdict;
    };

export type BandLevels = Float32Array;

export const BAND_COUNT = 24;

export interface ProfileSummary {
  readonly floorRms: number;
  readonly frames: number;
}

export interface EngineConfig {
  readonly sampleRate: number;
  readonly initialStrength: Strength;
  readonly calibrationSeconds: number;
}

export interface Suppressor {
  readonly hopSize: number;
  readonly latencySamples: number;
  process(input: Float32Array, output: Float32Array): FrameReport;
  calibrate(): void;
  setStrength(value: Strength): void;
  setBypass(held: boolean): void;
  setMonitor(open: boolean): void;
  bands(which: "input" | "noise", out: BandLevels): void;
  profile(): ProfileSummary | null;
}

const EPS = 1e-12;
const GAIN_SMOOTH = 0.85;
const BYPASS_SLEW = 0.12;
const HOWL_FRAMES = 14;
const HOWL_RATIO = 6;

function rms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i++) {
    sum += block[i] * block[i];
  }
  return Math.sqrt(sum / Math.max(block.length, 1));
}

function dbFromRms(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-9));
}

function fillBands(sampleRate: number, source: Float32Array, dest: Float32Array) {
  dest.fill(-90);
  const nyquist = sampleRate / 2;
  for (let band = 0; band < BAND_COUNT; band++) {
    const lo = Math.pow(nyquist, band / BAND_COUNT);
    const hi = Math.pow(nyquist, (band + 1) / BAND_COUNT);
    let acc = 0;
    let count = 0;
    for (let bin = 1; bin < BIN_COUNT; bin++) {
      const freq = (bin * sampleRate) / FFT_SIZE;
      if (freq < lo || freq >= hi) {
        continue;
      }
      acc += source[bin];
      count += 1;
    }
    if (count > 0) {
      dest[band] = dbFromRms(acc / count);
    }
  }
}

type Engine = {
  config: EngineConfig;
  fft: ReturnType<typeof createRealFft>;
  window: Float32Array;
  framesNeeded: number;
  hopIn: Float32Array;
  hopFill: number;
  history: Float32Array;
  ola: Float32Array;
  frame: Float32Array;
  re: Float32Array;
  im: Float32Array;
  mag: Float32Array;
  noiseSum: Float32Array;
  noise: Float32Array;
  prevGain: Float32Array;
  hopOut: Float32Array;
  pendingOut: Float32Array;
  pendingLen: number;
  lastInputBands: Float32Array;
  lastNoiseBands: Float32Array;
  phase: "calibrating" | "suppressing";
  seeded: number;
  currentStrength: Strength;
  bypassMix: number;
  wantBypass: boolean;
  monitorOpen: boolean;
  howlCount: number;
  lastReport: FrameReport;
  hopRmsEma: number;
  onsetHold: number;
};

function allocate(config: EngineConfig): Engine {
  const prevGain = new Float32Array(BIN_COUNT);
  prevGain.fill(1);
  const framesNeeded = Math.max(8, Math.round((config.sampleRate * config.calibrationSeconds) / HOP_SIZE));
  return {
    config,
    fft: createRealFft(FFT_SIZE),
    window: sqrtHannWindow(FFT_SIZE),
    framesNeeded,
    hopIn: new Float32Array(HOP_SIZE),
    hopFill: 0,
    history: new Float32Array(FFT_SIZE),
    ola: new Float32Array(FFT_SIZE),
    frame: new Float32Array(FFT_SIZE),
    re: new Float32Array(FFT_SIZE),
    im: new Float32Array(FFT_SIZE),
    mag: new Float32Array(BIN_COUNT),
    noiseSum: new Float32Array(BIN_COUNT),
    noise: new Float32Array(BIN_COUNT),
    prevGain,
    hopOut: new Float32Array(HOP_SIZE),
    pendingOut: new Float32Array(HOP_SIZE * 4),
    pendingLen: 0,
    lastInputBands: new Float32Array(BAND_COUNT),
    lastNoiseBands: new Float32Array(BAND_COUNT),
    phase: "calibrating",
    seeded: 0,
    currentStrength: config.initialStrength,
    bypassMix: 0,
    wantBypass: false,
    monitorOpen: false,
    howlCount: 0,
    lastReport: { kind: "calibrating", framesSeeded: 0, framesNeeded, inputLevel: 0 },
    hopRmsEma: 0,
    onsetHold: 0,
  };
}

function analyzeHop(engine: Engine) {
  engine.history.copyWithin(0, HOP_SIZE);
  engine.history.set(engine.hopIn, FFT_SIZE - HOP_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    engine.frame[i] = engine.history[i] * engine.window[i];
  }
  engine.fft.forward(engine.frame, engine.re, engine.im);
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    engine.mag[bin] = Math.hypot(engine.re[bin], engine.im[bin]);
  }
  fillBands(engine.config.sampleRate, engine.mag, engine.lastInputBands);
  engine.bypassMix += ((engine.wantBypass ? 1 : 0) - engine.bypassMix) * BYPASS_SLEW;
  const hopRms = rms(engine.hopIn);
  const floor = Math.max(engine.hopRmsEma, 1e-4);
  if (engine.phase === "suppressing" && hopRms > floor * 2.4 && hopRms > 0.02) {
    engine.onsetHold = 5;
  } else if (engine.onsetHold > 0) {
    engine.onsetHold -= 1;
  }
  engine.hopRmsEma = engine.hopRmsEma * 0.96 + hopRms * 0.04;
}

function seedNoise(engine: Engine, inputLevel: number): FrameReport {
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    engine.noiseSum[bin] += engine.mag[bin];
  }
  engine.seeded += 1;
  engine.hopOut.fill(0);
  if (engine.seeded >= engine.framesNeeded) {
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      engine.noise[bin] = engine.noiseSum[bin] / engine.seeded;
    }
    fillBands(engine.config.sampleRate, engine.noise, engine.lastNoiseBands);
    engine.phase = "suppressing";
    engine.prevGain.fill(1);
  }
  return { kind: "calibrating", framesSeeded: engine.seeded, framesNeeded: engine.framesNeeded, inputLevel };
}

function snrMask(noisy: number, noise: number): number {
  return Math.min(1, Math.max(0, (noisy / Math.max(noise, EPS) - 1) / 4));
}

function instantGain(suppressed: number, wet: number, mask: number): number {
  const blended = suppressed * wet + (1 - wet);
  if (wet <= 0) {
    return blended;
  }
  return suppressed * (1 - mask) + blended * mask;
}

function applyGains(engine: Engine): number {
  const oversub = 1 + engine.currentStrength * 2.4;
  const floor = 0.06 * (1 - 0.75 * engine.currentStrength);
  const wet = engine.currentStrength * (1 - engine.bypassMix);
  let gainAcc = 0;
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    const noisy = engine.mag[bin];
    const subtracted = (noisy - oversub * engine.noise[bin]) / Math.max(noisy, EPS);
    const suppressed = Math.min(1, Math.max(floor, subtracted));
    const instant =
      engine.onsetHold > 0 ? 1 : instantGain(suppressed, wet, snrMask(noisy, engine.noise[bin]));
    const smoothed =
      engine.onsetHold > 0 ? 1 : GAIN_SMOOTH * engine.prevGain[bin] + (1 - GAIN_SMOOTH) * instant;
    engine.prevGain[bin] = smoothed;
    gainAcc += smoothed;
    engine.re[bin] *= smoothed;
    engine.im[bin] *= smoothed;
  }
  return gainAcc;
}

function overlapAdd(engine: Engine) {
  for (let i = 1; i < FFT_SIZE / 2; i++) {
    engine.re[FFT_SIZE - i] = engine.re[i];
    engine.im[FFT_SIZE - i] = -engine.im[i];
  }
  engine.im[0] = 0;
  engine.im[FFT_SIZE / 2] = 0;
  engine.fft.inverse(engine.re, engine.im, engine.frame);
  for (let i = 0; i < FFT_SIZE; i++) {
    engine.ola[i] += (engine.frame[i] * engine.window[i]) / COLA_GAIN;
  }
  engine.hopOut.set(engine.ola.subarray(0, HOP_SIZE));
  engine.ola.copyWithin(0, HOP_SIZE);
  engine.ola.fill(0, FFT_SIZE - HOP_SIZE);
  if (!engine.monitorOpen) {
    engine.hopOut.fill(0);
  }
}

function howlVerdict(engine: Engine, inputLevel: number, outputLevel: number): HowlVerdict {
  let peakBin = 1;
  let peak = engine.mag[1];
  let magSum = 0;
  for (let bin = 1; bin < BIN_COUNT; bin++) {
    magSum += engine.mag[bin];
    if (engine.mag[bin] > peak) {
      peak = engine.mag[bin];
      peakBin = bin;
    }
  }
  const dominant = peak / Math.max(magSum, EPS);
  const howling =
    engine.monitorOpen &&
    !engine.wantBypass &&
    inputLevel > 0.02 &&
    outputLevel > inputLevel * HOWL_RATIO &&
    dominant > 0.35;
  engine.howlCount = howling ? engine.howlCount + 1 : Math.max(0, engine.howlCount - 1);
  if (engine.howlCount >= HOWL_FRAMES) {
    engine.hopOut.fill(0);
    return { kind: "trip", peakHz: (peakBin * engine.config.sampleRate) / FFT_SIZE };
  }
  return { kind: "clear", margin: 1 - engine.howlCount / HOWL_FRAMES };
}

function processHop(engine: Engine): FrameReport {
  analyzeHop(engine);
  const inputLevel = rms(engine.hopIn);
  if (engine.phase === "calibrating") {
    return seedNoise(engine, inputLevel);
  }
  const gainAcc = applyGains(engine);
  overlapAdd(engine);
  const outputLevel = rms(engine.hopOut);
  const howl = howlVerdict(engine, inputLevel, outputLevel);
  return {
    kind: "suppressing",
    inputLevel,
    outputLevel,
    reductionDb: -dbFromRms(Math.max(gainAcc / BIN_COUNT, 1e-6)),
    howl,
  };
}

function drain(engine: Engine, output: Float32Array) {
  const take = Math.min(engine.pendingLen, output.length);
  output.set(engine.pendingOut.subarray(0, take), 0);
  if (take < output.length) {
    output.fill(0, take);
  }
  engine.pendingOut.copyWithin(0, take);
  engine.pendingLen -= take;
}

function ingest(engine: Engine, input: Float32Array, output: Float32Array): FrameReport {
  let offset = 0;
  while (offset < input.length) {
    const take = Math.min(HOP_SIZE - engine.hopFill, input.length - offset);
    engine.hopIn.set(input.subarray(offset, offset + take), engine.hopFill);
    engine.hopFill += take;
    offset += take;
    if (engine.hopFill === HOP_SIZE) {
      engine.lastReport = processHop(engine);
      if (engine.pendingLen + HOP_SIZE > engine.pendingOut.length) {
        engine.pendingOut.copyWithin(0, HOP_SIZE);
        engine.pendingLen = Math.max(0, engine.pendingLen - HOP_SIZE);
      }
      engine.pendingOut.set(engine.hopOut, engine.pendingLen);
      engine.pendingLen += HOP_SIZE;
      engine.hopFill = 0;
    }
  }
  drain(engine, output);
  return engine.lastReport;
}

function resetCalibration(engine: Engine) {
  engine.phase = "calibrating";
  engine.seeded = 0;
  engine.noiseSum.fill(0);
  engine.hopFill = 0;
  engine.history.fill(0);
  engine.ola.fill(0);
  engine.pendingLen = 0;
  engine.howlCount = 0;
  engine.lastReport = {
    kind: "calibrating",
    framesSeeded: 0,
    framesNeeded: engine.framesNeeded,
    inputLevel: 0,
  };
  engine.hopRmsEma = 0;
  engine.onsetHold = 0;
}

export function createSuppressor(config: EngineConfig): Suppressor {
  const engine = allocate(config);
  return {
    hopSize: HOP_SIZE,
    latencySamples: FFT_SIZE - HOP_SIZE,
    process(input, output) {
      return ingest(engine, input, output);
    },
    calibrate() {
      resetCalibration(engine);
    },
    setStrength(value) {
      engine.currentStrength = value;
    },
    setBypass(held) {
      engine.wantBypass = held;
    },
    setMonitor(open) {
      engine.monitorOpen = open;
    },
    bands(which, out) {
      const source = which === "input" ? engine.lastInputBands : engine.lastNoiseBands;
      out.set(source.subarray(0, Math.min(out.length, source.length)));
    },
    profile() {
      if (engine.phase !== "suppressing") {
        return null;
      }
      let acc = 0;
      for (let bin = 0; bin < BIN_COUNT; bin++) {
        acc += engine.noise[bin] * engine.noise[bin];
      }
      return { floorRms: Math.sqrt(acc / BIN_COUNT), frames: engine.seeded };
    },
  };
}

export function defaultEngineConfig(sampleRate: number): EngineConfig {
  return {
    sampleRate,
    initialStrength: strength(0.6),
    calibrationSeconds: 3,
  };
}

export function sine(freq: number, sampleRate: number, seconds: number): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  const step = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(step * i);
  }
  return out;
}

export function mix(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.min(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = a[i] + b[i];
  }
  return out;
}

export function bandEnergy(samples: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
  const size = 2048;
  const fft = createRealFft(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const start = Math.max(0, samples.length - size);
  const frame = new Float32Array(size);
  frame.set(samples.subarray(start, start + size));
  fft.forward(frame, re, im);
  let acc = 0;
  for (let bin = 0; bin < size / 2 + 1; bin++) {
    const freq = (bin * sampleRate) / size;
    if (freq < lowHz || freq > highHz) {
      continue;
    }
    acc += re[bin] * re[bin] + im[bin] * im[bin];
  }
  return acc;
}
