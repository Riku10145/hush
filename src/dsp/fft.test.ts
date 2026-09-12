import { describe, expect, it } from "vitest";
import { createRealFft, FFT_SIZE, sqrtHannWindow } from "./fft";

describe("fft", () => {
  it("round-trips a sine frame", () => {
    const fft = createRealFft(FFT_SIZE);
    const frame = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      frame[i] = Math.sin((2 * Math.PI * 8 * i) / FFT_SIZE);
    }
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const back = new Float32Array(FFT_SIZE);
    fft.forward(frame, re, im);
    fft.inverse(re, im, back);
    let err = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const d = back[i] - frame[i];
      err += d * d;
    }
    expect(Math.sqrt(err / FFT_SIZE)).toBeLessThan(1e-6);
  });

  it("has a COLA constant near 2 for sqrt-Hann at 4x overlap", () => {
    const window = sqrtHannWindow(FFT_SIZE);
    const hop = 128;
    const acc = new Float32Array(FFT_SIZE);
    for (let start = 0; start < FFT_SIZE; start += hop) {
      for (let i = 0; i < FFT_SIZE; i++) {
        const idx = (start + i) % FFT_SIZE;
        acc[idx] += window[i] * window[i];
      }
    }
    const mid = acc[FFT_SIZE / 2];
    expect(mid).toBeGreaterThan(1.9);
    expect(mid).toBeLessThan(2.1);
  });
});
