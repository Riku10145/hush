import type { EngineCommand, EngineReport } from "./protocol";
import { isEngineReport } from "./protocol";
import { type DeviceListing } from "./sinks";
import type { Obstacle } from "../session/state";
import { FFT_SIZE, HOP_SIZE } from "../dsp/fft";

export type AudioHost = {
  readonly latencyMs: number;
  send: (command: EngineCommand) => void;
  close: () => Promise<void>;
};

export type AudioHostOptions = {
  readonly onReport: (report: EngineReport) => void;
  readonly onLost: (obstacle: Obstacle) => void;
  readonly sinkId?: string;
  readonly inputDeviceId?: string;
};

type AudioContextWithSink = AudioContext & {
  setSinkId: (sinkId: string) => Promise<void>;
};

class SinkFailedError extends Error {
  override readonly name = "SinkFailedError";
}

function inputConstraints(inputDeviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
    },
    video: false,
  };
}

function classify(error: unknown): Obstacle {
  if (error instanceof SinkFailedError) {
    return { kind: "sink-failed", detail: error.message };
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return { kind: "permission-denied" };
    }
    if (error.name === "NotFoundError") {
      return { kind: "no-input-device" };
    }
    if (error.name === "NotReadableError" || error.name === "AbortError") {
      return { kind: "device-in-use" };
    }
  }
  return { kind: "engine-failed", detail: error instanceof Error ? error.message : "unknown" };
}

export function canSetSinkId(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

export function missingCapabilities(): Array<"audio-context" | "audio-worklet" | "get-user-media"> {
  const missing: Array<"audio-context" | "audio-worklet" | "get-user-media"> = [];
  if (typeof AudioContext === "undefined") {
    missing.push("audio-context");
  }
  if (typeof AudioWorkletNode === "undefined") {
    missing.push("audio-worklet");
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    missing.push("get-user-media");
  }
  return missing;
}

export async function probeDeviceList(): Promise<readonly DeviceListing[]> {
  const probe = await navigator.mediaDevices.getUserMedia(inputConstraints());
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.map((device) => ({
      kind: device.kind,
      deviceId: device.deviceId,
      label: device.label,
    }));
  } finally {
    probe.getTracks().forEach((track) => track.stop());
  }
}

async function setContextSinkId(context: AudioContext, sinkId: string): Promise<void> {
  const withSink = context as AudioContextWithSink;
  try {
    await withSink.setSinkId(sinkId);
  } catch (error) {
    throw new SinkFailedError(error instanceof Error ? error.message : "sink");
  }
}

function attachProcessor(
  context: AudioContext,
  stream: MediaStream,
  options: AudioHostOptions,
): AudioHost {
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "hush-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    if (isEngineReport(event.data)) {
      options.onReport(event.data);
    }
  };
  node.onprocessorerror = () => {
    options.onLost({ kind: "engine-failed", detail: "worklet" });
  };
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      options.onLost({ kind: "no-input-device" });
    });
  });
  source.connect(node);
  node.connect(context.destination);
  const ioMs = ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000;
  const algoMs = ((FFT_SIZE - HOP_SIZE) / context.sampleRate) * 1000;
  return {
    latencyMs: algoMs + ioMs,
    send(command) {
      node.port.postMessage(command);
    },
    async close() {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    },
  };
}

export async function openAudioHost(options: AudioHostOptions): Promise<AudioHost> {
  const stream = await navigator.mediaDevices.getUserMedia(inputConstraints(options.inputDeviceId));
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    if (options.sinkId) {
      await setContextSinkId(context, options.sinkId);
    }
    await context.resume();
    const processorUrl = `${import.meta.env.BASE_URL}hush-processor.js`;
    await context.audioWorklet.addModule(processorUrl);
    return attachProcessor(context, stream, options);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (context) {
      await context.close().catch(() => undefined);
    }
    throw error;
  }
}

export { classify };
