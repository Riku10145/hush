export function fft(buffer: Float32Array) {
  const n = buffer.length / 2
  bitReverse(buffer, n)
  butterfly(buffer, n)
}

function bitReverse(buffer: Float32Array, n: number) {
  let j = 0
  for (let i = 0; i < n; i += 1) {
    if (i < j) {
      swapBin(buffer, i, j)
    }
    let k = n >> 1
    while (k >= 1 && j >= k) {
      j -= k
      k >>= 1
    }
    j += k
  }
}

function butterfly(buffer: Float32Array, n: number) {
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    const step = Math.PI / half
    for (let group = 0; group < n; group += size) {
      butterflyGroup(buffer, group, half, step)
    }
  }
}

function butterflyGroup(buffer: Float32Array, group: number, half: number, step: number) {
  for (let pair = 0; pair < half; pair += 1) {
    const angle = -step * pair
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    const even = group + pair
    const odd = even + half
    const er = buffer[even * 2] ?? 0
    const ei = buffer[even * 2 + 1] ?? 0
    const or = buffer[odd * 2] ?? 0
    const oi = buffer[odd * 2 + 1] ?? 0
    buffer[even * 2] = er + wr * or - wi * oi
    buffer[even * 2 + 1] = ei + wr * oi + wi * or
    buffer[odd * 2] = er - (wr * or - wi * oi)
    buffer[odd * 2 + 1] = ei - (wr * oi + wi * or)
  }
}

function swapBin(buffer: Float32Array, a: number, b: number) {
  const ar = buffer[a * 2] ?? 0
  const ai = buffer[a * 2 + 1] ?? 0
  buffer[a * 2] = buffer[b * 2] ?? 0
  buffer[a * 2 + 1] = buffer[b * 2 + 1] ?? 0
  buffer[b * 2] = ar
  buffer[b * 2 + 1] = ai
}

export function ifft(buffer: Float32Array) {
  conjugate(buffer)
  fft(buffer)
  conjugate(buffer)
  const n = buffer.length / 2
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = (buffer[i] ?? 0) / n
  }
}

function conjugate(buffer: Float32Array) {
  for (let i = 1; i < buffer.length; i += 2) {
    buffer[i] = -(buffer[i] ?? 0)
  }
}
