# Hush

Hush is a browser app for macOS that reduces steady room noise on a live microphone and plays the result to your headphones. It does not cancel sound that reaches your ears directly. Round-trip latency on a Mac is tens of milliseconds, so an inverted-ambient loop would not cancel broadband noise and can howl. Hush learns a noise profile for a few seconds, then subtracts that stationary spectrum.

There is no account, no cloud, and no paid API. After `npm install`, it runs offline.

## Run it

You need Node.js 22 or later.

```bash
npm install
npm test
npm run check:licenses
npm run dev
```

Open http://127.0.0.1:43147. Wear headphones. Click **ヘッドホンを着用して開始** and allow the microphone. Stay quiet for 3 seconds. Then you hear a quieter version of the room. Hold **押している間は原音** to compare. **測り直す** learns the room again without tearing the graph down.

Safari and Chrome on macOS are the supported browsers. Speakers can feed the microphone and trip the howl guard.

## What it does not do

It does not replace headphone ANC. It does not clean another app's microphone. It does not install a virtual audio device.

## License

Original code is MIT. See `LICENSE`. `npm run check:licenses` fails if a GPL runtime appears in `package-lock.json`. Permissive SPDX ids plus MIT-0, MPL-2.0, and CC-BY-4.0 are allowed. MPL-2.0 shows up through Tailwind's Lightning CSS compiler at build time, not in the DSP. The FFT and spectral subtraction in `src/dsp/` are original TypeScript. There is no RNNoise and no WASM denoiser.
