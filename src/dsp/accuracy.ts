import { FFT_SIZE, HOP_SIZE } from "./fft";
import {
  bandEnergy,
  createSuppressor,
  mix,
  sine,
  strength,
  type Suppressor,
} from "./suppressor";

const ACCURACY_RATE = 48_000;
const ACCURACY_STRENGTH = 0.6;
const ACCURACY_CAL_SECONDS = 0.5;
const ACCURACY_MIX_SECONDS = 1.2;
const SETTLE_SECONDS = 0.15;
const RECONSTRUCT_SKIP_SECONDS = 0.1;

type SceneScore = {
  readonly name: string;
  readonly noiseResid: number;
  readonly signalKeep: number;
  readonly sepDb: number;
  readonly siSdr: number;
};

type AccuracyReport = {
  readonly reconstructionRms: number;
  readonly sepDb: number;
  readonly siSdr: number;
  readonly noiseResid: number;
  readonly signalKeep: number;
  readonly scenes: readonly SceneScore[];
};

type Scene = {
  readonly name: string;
  readonly cal: Float32Array;
  readonly mix: Float32Array;
  readonly clean: Float32Array;
  readonly noiseLo: number;
  readonly noiseHi: number;
  readonly signalLo: number;
  readonly signalHi: number;
};

function processAll(engine: Suppressor, input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  const block = engine.hopSize;
  for (let i = 0; i < input.length; i += block) {
    const end = Math.min(input.length, i + block);
    engine.process(input.subarray(i, end), output.subarray(i, end));
  }
  return output;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scaleToRms(samples: Float32Array, target: number): Float32Array {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    acc += samples[i] * samples[i];
  }
  const current = Math.sqrt(acc / Math.max(samples.length, 1));
  const gain = current > 1e-12 ? target / current : 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * gain;
  }
  return out;
}

function brown(n: number, seed: number): Float32Array {
  const rand = mulberry(seed);
  const out = new Float32Array(n);
  let x = 0;
  for (let i = 0; i < n; i++) {
    x += (rand() * 2 - 1) * 0.02;
    x *= 0.997;
    out[i] = x;
  }
  return scaleToRms(out, 0.04);
}

function harmonics(n: number, rate: number, f0: number, amps: readonly number[]): Float32Array {
  const out = new Float32Array(n);
  for (let h = 0; h < amps.length; h++) {
    const step = (2 * Math.PI * f0 * (h + 1)) / rate;
    const amp = amps[h];
    for (let i = 0; i < n; i++) {
      out[i] += amp * Math.sin(step * i);
    }
  }
  return out;
}

function clicks(n: number, rate: number): Float32Array {
  const out = new Float32Array(n);
  const period = Math.floor(rate * 0.35);
  const width = Math.floor(rate * 0.008);
  for (let start = Math.floor(rate * 0.08); start + width < n; start += period) {
    for (let i = 0; i < width; i++) {
      const w = Math.sin((Math.PI * i) / width);
      out[start + i] = w * w * 0.9;
    }
  }
  return out;
}

function mean(values: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
  }
  return acc / Math.max(values.length, 1);
}

function dbRatio(num: number, den: number): number {
  return 10 * Math.log10(Math.max(num, 1e-20) / Math.max(den, 1e-20));
}

function siSdr(estimate: Float32Array, reference: Float32Array): number {
  const n = Math.min(estimate.length, reference.length);
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    dot += estimate[i] * reference[i];
    energy += reference[i] * reference[i];
  }
  const scale = energy > 1e-20 ? dot / energy : 0;
  let tgt = 0;
  let err = 0;
  for (let i = 0; i < n; i++) {
    const t = scale * reference[i];
    const e = estimate[i] - t;
    tgt += t * t;
    err += e * e;
  }
  return dbRatio(tgt, err);
}

function alignedTail(output: Float32Array, source: Float32Array, delay: number): {
  est: Float32Array;
  ref: Float32Array;
} {
  const start = delay + Math.round(ACCURACY_RATE * SETTLE_SECONDS);
  const end = Math.min(output.length, source.length + delay) - HOP_SIZE;
  const n = Math.max(0, end - start);
  const est = new Float32Array(n);
  const ref = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    est[i] = output[start + i];
    ref[i] = source[start + i - delay];
  }
  return { est, ref };
}

function scoreScene(engine: Suppressor, scene: Scene): SceneScore {
  processAll(engine, scene.cal);
  engine.setMonitor(true);
  const output = processAll(engine, scene.mix);
  const delay = engine.latencySamples;
  const mixTail = alignedTail(output, scene.mix, delay);
  const cleanTail = alignedTail(output, scene.clean, delay);
  const noiseResid =
    bandEnergy(mixTail.est, ACCURACY_RATE, scene.noiseLo, scene.noiseHi) /
    Math.max(bandEnergy(mixTail.ref, ACCURACY_RATE, scene.noiseLo, scene.noiseHi), 1e-20);
  const signalKeep =
    bandEnergy(mixTail.est, ACCURACY_RATE, scene.signalLo, scene.signalHi) /
    Math.max(bandEnergy(mixTail.ref, ACCURACY_RATE, scene.signalLo, scene.signalHi), 1e-20);
  return {
    name: scene.name,
    noiseResid,
    signalKeep,
    sepDb: dbRatio(signalKeep, noiseResid),
    siSdr: siSdr(cleanTail.est, cleanTail.ref),
  };
}

function makeEngine(value: number, calSeconds: number): Suppressor {
  return createSuppressor({
    sampleRate: ACCURACY_RATE,
    initialStrength: strength(value),
    calibrationSeconds: calSeconds,
  });
}

function sceneHumTone(): Scene {
  const mixN = Math.floor(ACCURACY_RATE * ACCURACY_MIX_SECONDS);
  const noise = scaleToRms(sine(120, ACCURACY_RATE, ACCURACY_MIX_SECONDS), 0.04);
  const clean = scaleToRms(sine(1000, ACCURACY_RATE, ACCURACY_MIX_SECONDS), 0.05);
  return {
    name: "hum120-tone1k",
    cal: scaleToRms(sine(120, ACCURACY_RATE, ACCURACY_CAL_SECONDS), 0.04),
    mix: mix(noise, clean).subarray(0, mixN),
    clean,
    noiseLo: 90,
    noiseHi: 150,
    signalLo: 900,
    signalHi: 1100,
  };
}

function sceneBrownHarmonics(): Scene {
  const calN = Math.floor(ACCURACY_RATE * ACCURACY_CAL_SECONDS);
  const mixN = Math.floor(ACCURACY_RATE * ACCURACY_MIX_SECONDS);
  const noise = brown(mixN, 7);
  const clean = scaleToRms(
    harmonics(mixN, ACCURACY_RATE, 140, [0.6, 0.45, 0.25, 0.18, 0.12, 0.08, 0.05]),
    0.05,
  );
  return {
    name: "brown-harmonics",
    cal: brown(calN, 7),
    mix: mix(noise, clean),
    clean,
    noiseLo: 40,
    noiseHi: 180,
    signalLo: 700,
    signalHi: 2800,
  };
}

function sceneBrownClick(): Scene {
  const calN = Math.floor(ACCURACY_RATE * ACCURACY_CAL_SECONDS);
  const mixN = Math.floor(ACCURACY_RATE * ACCURACY_MIX_SECONDS);
  const noise = brown(mixN, 11);
  const clean = clicks(mixN, ACCURACY_RATE);
  return {
    name: "brown-click",
    cal: brown(calN, 11),
    mix: mix(noise, clean),
    clean,
    noiseLo: 40,
    noiseHi: 180,
    signalLo: 800,
    signalHi: 6000,
  };
}

function sceneFanVowel(): Scene {
  const calN = Math.floor(ACCURACY_RATE * ACCURACY_CAL_SECONDS);
  const mixN = Math.floor(ACCURACY_RATE * ACCURACY_MIX_SECONDS);
  const noise = scaleToRms(mix(brown(mixN, 19), sine(60, ACCURACY_RATE, ACCURACY_MIX_SECONDS)), 0.045);
  const calNoise = scaleToRms(
    mix(brown(calN, 19), sine(60, ACCURACY_RATE, ACCURACY_CAL_SECONDS)),
    0.045,
  );
  const vowel = harmonics(mixN, ACCURACY_RATE, 180, [0.35, 0.7, 0.4, 0.22, 0.1]);
  for (let i = 0; i < vowel.length; i++) {
    vowel[i] *= 0.7 + 0.3 * Math.sin((2 * Math.PI * 4 * i) / ACCURACY_RATE);
  }
  const clean = scaleToRms(vowel, 0.05);
  return {
    name: "fan-vowel",
    cal: calNoise,
    mix: mix(noise, clean),
    clean,
    noiseLo: 40,
    noiseHi: 90,
    signalLo: 500,
    signalHi: 2500,
  };
}

function sceneOfficeStack(): Scene {
  const calN = Math.floor(ACCURACY_RATE * ACCURACY_CAL_SECONDS);
  const mixN = Math.floor(ACCURACY_RATE * ACCURACY_MIX_SECONDS);
  const hum = mix(
    mix(sine(60, ACCURACY_RATE, ACCURACY_MIX_SECONDS), sine(120, ACCURACY_RATE, ACCURACY_MIX_SECONDS)),
    sine(240, ACCURACY_RATE, ACCURACY_MIX_SECONDS),
  );
  const noise = scaleToRms(mix(scaleToRms(hum, 0.03), brown(mixN, 23)), 0.045);
  const calHum = mix(
    mix(sine(60, ACCURACY_RATE, ACCURACY_CAL_SECONDS), sine(120, ACCURACY_RATE, ACCURACY_CAL_SECONDS)),
    sine(240, ACCURACY_RATE, ACCURACY_CAL_SECONDS),
  );
  const clean = scaleToRms(sine(1500, ACCURACY_RATE, ACCURACY_MIX_SECONDS), 0.05);
  return {
    name: "office-tone",
    cal: scaleToRms(mix(scaleToRms(calHum, 0.03), brown(calN, 23)), 0.045),
    mix: mix(noise, clean),
    clean,
    noiseLo: 50,
    noiseHi: 270,
    signalLo: 1400,
    signalHi: 1600,
  };
}

function scenes(): readonly Scene[] {
  return [sceneHumTone(), sceneBrownHarmonics(), sceneBrownClick(), sceneFanVowel(), sceneOfficeStack()];
}

function reconstructionRms(): number {
  const engine = makeEngine(0, 0.05);
  engine.setMonitor(true);
  const input = new Float32Array(Math.floor(ACCURACY_RATE * 0.6));
  for (let i = 0; i < input.length; i++) {
    input[i] = Math.sin((2 * Math.PI * i * i) / (ACCURACY_RATE * 200));
  }
  const output = processAll(engine, input);
  const delay = FFT_SIZE - HOP_SIZE;
  const skip = Math.round(ACCURACY_RATE * RECONSTRUCT_SKIP_SECONDS);
  let err = 0;
  let count = 0;
  for (let i = delay + skip; i < input.length - HOP_SIZE; i++) {
    const d = output[i] - input[i - delay];
    err += d * d;
    count += 1;
  }
  return Math.sqrt(err / Math.max(count, 1));
}

export function measureAccuracy(value: number = ACCURACY_STRENGTH): AccuracyReport {
  const scored = scenes().map((scene) => scoreScene(makeEngine(value, ACCURACY_CAL_SECONDS), scene));
  return {
    reconstructionRms: reconstructionRms(),
    sepDb: mean(scored.map((row) => row.sepDb)),
    siSdr: mean(scored.map((row) => row.siSdr)),
    noiseResid: mean(scored.map((row) => row.noiseResid)),
    signalKeep: mean(scored.map((row) => row.signalKeep)),
    scenes: scored,
  };
}
