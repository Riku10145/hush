export const FFT_SIZE = 512;
export const HOP_SIZE = 128;
export const BIN_COUNT = FFT_SIZE / 2 + 1;
export const OVERLAP = FFT_SIZE / HOP_SIZE;
export const COLA_GAIN = 2;

export type FftSize = typeof FFT_SIZE;

export function sqrtHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  }
  return window;
}

export function createRealFft(size: number): {
  size: number;
  forward: (frame: Float32Array, re: Float32Array, im: Float32Array) => void;
  inverse: (re: Float32Array, im: Float32Array, frame: Float32Array) => void;
} {
  const bits = Math.round(Math.log2(size));
  if (1 << bits !== size) {
    throw new Error(`FFT size must be a power of two, got ${size}`);
  }

  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = y;
  }

  const twiddleRe = new Float32Array(size / 2);
  const twiddleIm = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const angle = (-2 * Math.PI * i) / size;
    twiddleRe[i] = Math.cos(angle);
    twiddleIm[i] = Math.sin(angle);
  }

  const bitrevRe = new Float32Array(size);
  const bitrevIm = new Float32Array(size);
  const invRe = new Float32Array(size);
  const invIm = new Float32Array(size);

  function transform(re: Float32Array, im: Float32Array, inverse: boolean) {
    for (let i = 0; i < size; i++) {
      bitrevRe[i] = re[rev[i]];
      bitrevIm[i] = im[rev[i]];
    }
    re.set(bitrevRe);
    im.set(bitrevIm);

    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const stride = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const tIndex = k * stride;
          let wr = twiddleRe[tIndex];
          let wi = twiddleIm[tIndex];
          if (inverse) {
            wi = -wi;
          }
          const even = start + k;
          const odd = even + half;
          const tr = wr * re[odd] - wi * im[odd];
          const ti = wr * im[odd] + wi * re[odd];
          re[odd] = re[even] - tr;
          im[odd] = im[even] - ti;
          re[even] += tr;
          im[even] += ti;
        }
      }
    }

    if (inverse) {
      const scale = 1 / size;
      for (let i = 0; i < size; i++) {
        re[i] *= scale;
        im[i] *= scale;
      }
    }
  }

  return {
    size,
    forward(frame, re, im) {
      re.set(frame);
      im.fill(0);
      transform(re, im, false);
    },
    inverse(re, im, frame) {
      invRe.set(re);
      invIm.set(im);
      transform(invRe, invIm, true);
      frame.set(invRe);
    },
  };
}
