import { describe, expect, it } from "vitest";
import { FFT_SIZE, HOP_SIZE } from "./fft";
import {
  bandEnergy,
  createSuppressor,
  mix,
  sine,
  strength,
} from "./suppressor";

const RATE = 48_000;

function run(engine: ReturnType<typeof createSuppressor>, input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  const block = 128;
  for (let i = 0; i < input.length; i += block) {
    const end = Math.min(input.length, i + block);
    engine.process(input.subarray(i, end), output.subarray(i, end));
  }
  return output;
}

describe("suppressor", () => {
  it("reconstructs the input when strength is zero after the STFT delay", () => {
    const engine = createSuppressor({
      sampleRate: RATE,
      initialStrength: strength(0),
      calibrationSeconds: 0.05,
    });
    engine.setMonitor(true);
    const input = new Float32Array(RATE * 0.6);
    for (let i = 0; i < input.length; i++) {
      input[i] = Math.sin((2 * Math.PI * i * i) / (RATE * 200));
    }
    const output = run(engine, input);
    const delay = FFT_SIZE - HOP_SIZE;
    let err = 0;
    let count = 0;
    for (let i = delay + 4800; i < input.length - 128; i++) {
      const d = output[i] - input[i - delay];
      err += d * d;
      count += 1;
    }
    expect(Math.sqrt(err / count)).toBeLessThan(1e-6);
  });

  it("cuts a learned 120 Hz hum more than a 1 kHz tone", () => {
    const engine = createSuppressor({
      sampleRate: RATE,
      initialStrength: strength(0.85),
      calibrationSeconds: 0.4,
    });
    const hum = sine(120, RATE, 1.2);
    run(engine, hum);
    engine.setMonitor(true);
    const mixed = mix(sine(120, RATE, 1.2), sine(1000, RATE, 1.2));
    for (let i = 0; i < mixed.length; i++) {
      mixed[i] *= 0.5;
    }
    const output = run(engine, mixed);
    const tailIn = mixed.subarray(mixed.length - RATE);
    const tailOut = output.subarray(output.length - RATE);
    const humIn = bandEnergy(tailIn, RATE, 90, 150);
    const humOut = bandEnergy(tailOut, RATE, 90, 150);
    const toneIn = bandEnergy(tailIn, RATE, 900, 1100);
    const toneOut = bandEnergy(tailOut, RATE, 900, 1100);
    expect(humOut / humIn).toBeLessThan(0.35);
    expect(toneOut / toneIn).toBeGreaterThan(0.45);
    expect(humOut / humIn).toBeLessThan(toneOut / toneIn);
  });
});
