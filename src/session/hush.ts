import { createSuppressor, type AdaptiveSuppressor } from '@/dsp/suppressor'
import type { Session } from '@/session/state'

const FFT_SIZE = 512
const HOP_SIZE = 128
const CALIBRATION_HOPS = 48
const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
}

export type SessionHandle = {
  start: () => Promise<void>
  stop: () => void
  recalibrate: () => void
  setStrength: (value: number) => void
  holdBypass: (held: boolean) => void
  dismissGuard: () => void
}

export type SessionEpoch = {
  session: Session
  handle: SessionHandle
}

export function createSession(): SessionEpoch {
  const engine = createEngine()
  return {
    session: engine.session,
    handle: {
      start: engine.start,
      stop: engine.stop,
      recalibrate: engine.recalibrate,
      setStrength: engine.setStrength,
      holdBypass: engine.holdBypass,
      dismissGuard: engine.dismissGuard,
    },
  }
}

function createEngine() {
  const session: Session = {
    kind: 'idle',
    strength: 0.7,
  }

  let context: AudioContext | null = null
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  let suppressor: AdaptiveSuppressor | null = null
  let hopBuffer = new Float32Array(HOP_SIZE)
  let hopFill = 0
  let hopCount = 0
  let bypassHeld = false
  let bypassLatched = false
  let guardDismissed = false

  const start = async () => {
    if (session.kind === 'requesting' || session.kind === 'calibrating' || session.kind === 'active') {
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      session.kind = 'unsupported'
      return
    }
    session.kind = 'requesting'
    try {
      stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS)
      context = new AudioContext({ latencyHint: 'interactive' })
      await context.audioWorklet.addModule('/hush-processor.js')
      source = context.createMediaStreamSource(stream)
      worklet = new AudioWorkletNode(context, 'hush-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { fftSize: FFT_SIZE, hopSize: HOP_SIZE },
      })
      suppressor = createSuppressor({
        fftSize: FFT_SIZE,
        hopSize: HOP_SIZE,
        sampleRate: context.sampleRate,
      })
      suppressor.setStrength(session.strength)
      hopFill = 0
      hopCount = 0
      bypassHeld = false
      bypassLatched = false
      guardDismissed = false
      worklet.port.onmessage = (event: MessageEvent) => {
        onWorkletMessage(event.data)
      }
      source.connect(worklet)
      worklet.connect(context.destination)
      await context.resume()
      session.kind = 'calibrating'
      session.progress = 0
    } catch {
      stopTracks()
      session.kind = 'blocked'
    }
  }

  const onWorkletMessage = (data: unknown) => {
    if (!suppressor || !worklet || typeof data !== 'object' || data === null) {
      return
    }
    if (!('type' in data) || data.type !== 'capture' || !('samples' in data)) {
      return
    }
    const samples = data.samples
    if (!(samples instanceof Float32Array)) {
      return
    }
    feedCapture(samples)
  }

  const feedCapture = (samples: Float32Array) => {
    if (!suppressor) {
      return
    }
    for (let i = 0; i < samples.length; i += 1) {
      hopBuffer[hopFill] = samples[i] ?? 0
      hopFill += 1
      if (hopFill < HOP_SIZE) {
        continue
      }
      hopFill = 0
      hopCount += 1
      if (session.kind === 'calibrating') {
        suppressor.observe(hopBuffer)
        session.progress = Math.min(1, hopCount / CALIBRATION_HOPS)
        if (hopCount >= CALIBRATION_HOPS) {
          session.kind = 'active'
          session.bypass = false
          session.guard = false
        }
        continue
      }
      if (session.kind !== 'active') {
        continue
      }
      const result = suppressor.process(hopBuffer)
      const bypass = bypassHeld || bypassLatched
      session.bypass = bypass
      session.guard = result.guard && !guardDismissed
      worklet?.port.postMessage({
        type: 'playback',
        samples: bypass ? hopBuffer : result.output,
      })
    }
  }

  const stop = () => {
    if (worklet) {
      worklet.port.onmessage = null
      worklet.disconnect()
    }
    source?.disconnect()
    void context?.close()
    stopTracks()
    context = null
    source = null
    worklet = null
    suppressor = null
    hopFill = 0
    hopCount = 0
    if (session.kind === 'unsupported') {
      return
    }
    session.kind = 'idle'
    session.strength = session.strength
  }

  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  const recalibrate = () => {
    if (session.kind !== 'active' && session.kind !== 'calibrating') {
      return
    }
    suppressor?.resetNoise()
    hopCount = 0
    guardDismissed = false
    session.kind = 'calibrating'
    session.progress = 0
  }

  const setStrength = (value: number) => {
    const next = Math.min(1, Math.max(0, value))
    session.strength = next
    suppressor?.setStrength(next)
  }

  const holdBypass = (held: boolean) => {
    bypassHeld = held
    if (held) {
      bypassLatched = !bypassLatched
    }
    if (session.kind === 'active') {
      session.bypass = bypassHeld || bypassLatched
    }
  }

  const dismissGuard = () => {
    guardDismissed = true
    if (session.kind === 'active') {
      session.guard = false
    }
  }

  return { session, start, stop, recalibrate, setStrength, holdBypass, dismissGuard }
}
