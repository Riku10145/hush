export const FFT_SIZE = 512;
export const HOP_SIZE = 128;
export const BIN_COUNT = FFT_SIZE / 2 + 1;
export const COLA_GAIN = 2;

export function sqrtHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  }
  return window;
}

function bitReverseTable(size: number, bits: number): Uint32Array {
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
  return rev;
}

function twiddleTables(size: number): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(size / 2);
  const im = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const angle = (-2 * Math.PI * i) / size;
    re[i] = Math.cos(angle);
    im[i] = Math.sin(angle);
  }
  return { re, im };
}

function permute(re: Float32Array, im: Float32Array, rev: Uint32Array, scratchRe: Float32Array, scratchIm: Float32Array) {
  const size = re.length;
  for (let i = 0; i < size; i++) {
    scratchRe[i] = re[rev[i]];
    scratchIm[i] = im[rev[i]];
  }
  re.set(scratchRe);
  im.set(scratchIm);
}

function butterflies(
  re: Float32Array,
  im: Float32Array,
  twiddleRe: Float32Array,
  twiddleIm: Float32Array,
  inverse: boolean,
) {
  const size = re.length;
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const stride = size / len;
    for (let start = 0; start < size; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = twiddleRe[k * stride];
        const wi = inverse ? -twiddleIm[k * stride] : twiddleIm[k * stride];
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
}

function transform(
  re: Float32Array,
  im: Float32Array,
  rev: Uint32Array,
  twiddleRe: Float32Array,
  twiddleIm: Float32Array,
  scratchRe: Float32Array,
  scratchIm: Float32Array,
  inverse: boolean,
) {
  permute(re, im, rev, scratchRe, scratchIm);
  butterflies(re, im, twiddleRe, twiddleIm, inverse);
  if (!inverse) {
    return;
  }
  const scale = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= scale;
    im[i] *= scale;
  }
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
  const rev = bitReverseTable(size, bits);
  const twiddle = twiddleTables(size);
  const bitrevRe = new Float32Array(size);
  const bitrevIm = new Float32Array(size);
  const invRe = new Float32Array(size);
  const invIm = new Float32Array(size);
  return {
    size,
    forward(frame, re, im) {
      re.set(frame);
      im.fill(0);
      transform(re, im, rev, twiddle.re, twiddle.im, bitrevRe, bitrevIm, false);
    },
    inverse(re, im, frame) {
      invRe.set(re);
      invIm.set(im);
      transform(invRe, invIm, rev, twiddle.re, twiddle.im, bitrevRe, bitrevIm, true);
      frame.set(invRe);
    },
  };
}
