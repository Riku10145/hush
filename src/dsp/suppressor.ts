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
const GAIN_SMOOTH = 0.72;
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

export function createSuppressor(config: EngineConfig): Suppressor {
  const fft = createRealFft(FFT_SIZE);
  const window = sqrtHannWindow(FFT_SIZE);
  const framesNeeded = Math.max(
    8,
    Math.round((config.sampleRate * config.calibrationSeconds) / HOP_SIZE),
  );

  const hopIn = new Float32Array(HOP_SIZE);
  let hopFill = 0;
  const history = new Float32Array(FFT_SIZE);
  const ola = new Float32Array(FFT_SIZE);
  const frame = new Float32Array(FFT_SIZE);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const mag = new Float32Array(BIN_COUNT);
  const noiseSum = new Float32Array(BIN_COUNT);
  const noise = new Float32Array(BIN_COUNT);
  const prevGain = new Float32Array(BIN_COUNT);
  prevGain.fill(1);
  const hopOut = new Float32Array(HOP_SIZE);
  const pendingOut = new Float32Array(HOP_SIZE * 4);
  let pendingLen = 0;
  const lastInputBands = new Float32Array(BAND_COUNT);
  const lastNoiseBands = new Float32Array(BAND_COUNT);

  let phase: "calibrating" | "suppressing" = "calibrating";
  let seeded = 0;
  let currentStrength = config.initialStrength;
  let bypassMix = 0;
  let wantBypass = false;
  let monitorOpen = false;
  let howlCount = 0;
  let lastReport: FrameReport = {
    kind: "calibrating",
    framesSeeded: 0,
    framesNeeded,
    inputLevel: 0,
  };

  function fillBands(source: Float32Array, dest: Float32Array) {
    dest.fill(-90);
    const nyquist = config.sampleRate / 2;
    for (let band = 0; band < BAND_COUNT; band++) {
      const lo = Math.pow(nyquist, band / BAND_COUNT);
      const hi = Math.pow(nyquist, (band + 1) / BAND_COUNT);
      let acc = 0;
      let count = 0;
      for (let bin = 1; bin < BIN_COUNT; bin++) {
        const freq = (bin * config.sampleRate) / FFT_SIZE;
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

  function mirrorHermitian() {
    for (let i = 1; i < FFT_SIZE / 2; i++) {
      re[FFT_SIZE - i] = re[i];
      im[FFT_SIZE - i] = -im[i];
    }
    im[0] = 0;
    im[FFT_SIZE / 2] = 0;
  }

  function processHop(): FrameReport {
    history.copyWithin(0, HOP_SIZE);
    history.set(hopIn, FFT_SIZE - HOP_SIZE);

    for (let i = 0; i < FFT_SIZE; i++) {
      frame[i] = history[i] * window[i];
    }
    fft.forward(frame, re, im);

    for (let bin = 0; bin < BIN_COUNT; bin++) {
      mag[bin] = Math.hypot(re[bin], im[bin]);
    }
    fillBands(mag, lastInputBands);

    const inputLevel = rms(hopIn);
    bypassMix += ((wantBypass ? 1 : 0) - bypassMix) * BYPASS_SLEW;

    if (phase === "calibrating") {
      for (let bin = 0; bin < BIN_COUNT; bin++) {
        noiseSum[bin] += mag[bin];
      }
      seeded += 1;
      hopOut.fill(0);
      if (seeded >= framesNeeded) {
        for (let bin = 0; bin < BIN_COUNT; bin++) {
          noise[bin] = noiseSum[bin] / seeded;
        }
        fillBands(noise, lastNoiseBands);
        phase = "suppressing";
        prevGain.fill(1);
      }
      return {
        kind: "calibrating",
        framesSeeded: seeded,
        framesNeeded,
        inputLevel,
      };
    }

    const oversub = 1 + currentStrength * 2.4;
    const floor = 0.06 * (1 - 0.75 * currentStrength);
    const wet = currentStrength * (1 - bypassMix);
    let gainAcc = 0;

    for (let bin = 0; bin < BIN_COUNT; bin++) {
      const noisy = mag[bin];
      const subtracted = (noisy - oversub * noise[bin]) / Math.max(noisy, EPS);
      const suppressed = Math.min(1, Math.max(floor, subtracted));
      const instant = suppressed * wet + (1 - wet);
      const smoothed = GAIN_SMOOTH * prevGain[bin] + (1 - GAIN_SMOOTH) * instant;
      prevGain[bin] = smoothed;
      gainAcc += smoothed;
      re[bin] *= smoothed;
      im[bin] *= smoothed;
    }

    mirrorHermitian();
    fft.inverse(re, im, frame);

    for (let i = 0; i < FFT_SIZE; i++) {
      ola[i] += (frame[i] * window[i]) / COLA_GAIN;
    }
    hopOut.set(ola.subarray(0, HOP_SIZE));
    ola.copyWithin(0, HOP_SIZE);
    ola.fill(0, FFT_SIZE - HOP_SIZE);

    if (!monitorOpen) {
      hopOut.fill(0);
    }

    const outputLevel = rms(hopOut);
    const meanGain = gainAcc / BIN_COUNT;
    const reductionDb = -dbFromRms(Math.max(meanGain, 1e-6));

    let peakBin = 1;
    let peak = mag[1];
    let magSum = 0;
    for (let bin = 1; bin < BIN_COUNT; bin++) {
      magSum += mag[bin];
      if (mag[bin] > peak) {
        peak = mag[bin];
        peakBin = bin;
      }
    }
    const dominant = peak / Math.max(magSum, EPS);
    const howling =
      monitorOpen &&
      !wantBypass &&
      inputLevel > 0.02 &&
      outputLevel > inputLevel * HOWL_RATIO &&
      dominant > 0.35;

    if (howling) {
      howlCount += 1;
    } else {
      howlCount = Math.max(0, howlCount - 1);
    }

    const howl: HowlVerdict =
      howlCount >= HOWL_FRAMES
        ? { kind: "trip", peakHz: (peakBin * config.sampleRate) / FFT_SIZE }
        : { kind: "clear", margin: 1 - howlCount / HOWL_FRAMES };

    if (howl.kind === "trip") {
      hopOut.fill(0);
    }

    return {
      kind: "suppressing",
      inputLevel,
      outputLevel,
      reductionDb,
      howl,
    };
  }

  function drain(output: Float32Array) {
    const take = Math.min(pendingLen, output.length);
    output.set(pendingOut.subarray(0, take), 0);
    if (take < output.length) {
      output.fill(0, take);
    }
    pendingOut.copyWithin(0, take);
    pendingLen -= take;
  }

  return {
    hopSize: HOP_SIZE,
    latencySamples: FFT_SIZE - HOP_SIZE,
    process(input, output) {
      let offset = 0;
      while (offset < input.length) {
        const room = HOP_SIZE - hopFill;
        const take = Math.min(room, input.length - offset);
        hopIn.set(input.subarray(offset, offset + take), hopFill);
        hopFill += take;
        offset += take;
        if (hopFill === HOP_SIZE) {
          lastReport = processHop();
          if (pendingLen + HOP_SIZE > pendingOut.length) {
            pendingOut.copyWithin(0, HOP_SIZE);
            pendingLen = Math.max(0, pendingLen - HOP_SIZE);
          }
          pendingOut.set(hopOut, pendingLen);
          pendingLen += HOP_SIZE;
          hopFill = 0;
        }
      }
      drain(output);
      return lastReport;
    },
    calibrate() {
      phase = "calibrating";
      seeded = 0;
      noiseSum.fill(0);
      hopFill = 0;
      history.fill(0);
      ola.fill(0);
      pendingLen = 0;
      howlCount = 0;
      lastReport = {
        kind: "calibrating",
        framesSeeded: 0,
        framesNeeded,
        inputLevel: 0,
      };
    },
    setStrength(value) {
      currentStrength = value;
    },
    setBypass(held) {
      wantBypass = held;
    },
    setMonitor(open) {
      monitorOpen = open;
    },
    bands(which, out) {
      const source = which === "input" ? lastInputBands : lastNoiseBands;
      const n = Math.min(out.length, source.length);
      out.set(source.subarray(0, n));
    },
    profile() {
      if (phase !== "suppressing") {
        return null;
      }
      let acc = 0;
      for (let bin = 0; bin < BIN_COUNT; bin++) {
        acc += noise[bin] * noise[bin];
      }
      return { floorRms: Math.sqrt(acc / BIN_COUNT), frames: seeded };
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

export function bandEnergy(
  samples: Float32Array,
  sampleRate: number,
  lowHz: number,
  highHz: number,
): number {
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
