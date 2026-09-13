import { strength as clampStrength } from "../dsp/suppressor";
import {
  canSetSinkId,
  classify,
  missingCapabilities,
  openAudioHost,
  probeDeviceList,
  type AudioHost,
} from "../audio/host";
import type { EngineReport } from "../audio/protocol";
import {
  catalogLoopbacks,
  pickCaptureDevice,
  pickMeetingSink,
  type LoopbackSink,
} from "../audio/sinks";
import {
  epoch,
  IDLE,
  reduce,
  type AudioRoute,
  type MeterSnapshot,
  type RouteIntent,
  type Session,
  type SessionEpoch,
} from "./state";

function toMeters(report: Extract<EngineReport, { meters: unknown }>): MeterSnapshot {
  return {
    inputLevel: report.meters.inputLevel,
    outputLevel: report.meters.outputLevel,
    reductionDb: report.meters.reductionDb,
    inputBands: Float32Array.from(report.meters.inputBands),
    noiseBands: Float32Array.from(report.meters.noiseBands),
    guardMargin: report.meters.guardMargin,
  };
}

export type HushActions = {
  start: (intent: RouteIntent) => Promise<void>;
  chooseSink: (sink: LoopbackSink) => Promise<void>;
  stop: () => Promise<void>;
  recalibrate: () => void;
  setStrength: (value: number) => void;
  holdBypass: (held: boolean) => void;
  dismissGuard: () => void;
};

type Runtime = {
  session: Session;
  currentEpoch: number;
  host: AudioHost | null;
  captureDeviceId: string | null;
  starting: boolean;
  onChange: (session: Session) => void;
};

function publish(runtime: Runtime, next: Session) {
  runtime.session = next;
  runtime.onChange(runtime.session);
}

function dispatch(runtime: Runtime, event: Parameters<typeof reduce>[1]) {
  publish(runtime, reduce(runtime.session, event));
}

function isCurrent(runtime: Runtime, token: SessionEpoch): boolean {
  return runtime.currentEpoch === token;
}

function handleReport(runtime: Runtime, report: EngineReport) {
  const token = epoch(report.epoch);
  if (report.kind === "calibrating") {
    dispatch(runtime, {
      kind: "calibrating",
      epoch: token,
      progress: report.progress,
      meters: toMeters(report),
    });
    return;
  }
  if (report.kind === "calibrated") {
    dispatch(runtime, { kind: "calibrated", epoch: token, meters: toMeters(report) });
    runtime.host?.send({ kind: "set-monitor", open: true });
    return;
  }
  if (report.kind === "metered") {
    dispatch(runtime, { kind: "metered", epoch: token, meters: toMeters(report) });
    return;
  }
  dispatch(runtime, { kind: "guard-tripped", epoch: token, peakHz: report.peakHz });
  runtime.host?.send({ kind: "set-monitor", open: false });
}

async function abandonHost(runtime: Runtime) {
  const current = runtime.host;
  runtime.host = null;
  runtime.captureDeviceId = null;
  if (current) {
    await current.close();
  }
}

async function stop(runtime: Runtime) {
  runtime.currentEpoch += 1;
  runtime.starting = false;
  await abandonHost(runtime);
  dispatch(runtime, { kind: "stopped" });
}

async function connectAndCalibrate(
  runtime: Runtime,
  token: SessionEpoch,
  route: AudioRoute,
  inputDeviceId: string | undefined,
) {
  const host = await openAudioHost({
    sinkId: route.kind === "meeting" ? route.sink.deviceId : undefined,
    inputDeviceId,
    onReport: (report) => handleReport(runtime, report),
    onLost: () => {
      if (!isCurrent(runtime, token)) {
        return;
      }
      void stop(runtime);
    },
  });
  if (!isCurrent(runtime, token)) {
    await host.close();
    return;
  }
  runtime.host = host;
  dispatch(runtime, {
    kind: "host-opened",
    epoch: token,
    latencyMs: host.latencyMs,
    route,
  });
  if (!isCurrent(runtime, token) || !runtime.host) {
    return;
  }
  runtime.host.send({ kind: "calibrate", epoch: runtime.currentEpoch });
  runtime.host.send({ kind: "set-strength", value: 0.6 });
}

function isBusy(runtime: Runtime): boolean {
  return (
    runtime.starting ||
    runtime.session.kind === "calibrating" ||
    runtime.session.kind === "active" ||
    runtime.session.kind === "requesting" ||
    runtime.session.kind === "choosing-sink"
  );
}

function failHost(runtime: Runtime, token: SessionEpoch, intent: RouteIntent, error: unknown) {
  if (!isCurrent(runtime, token)) {
    return;
  }
  dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: classify(error), intent });
}

async function startMeeting(runtime: Runtime, token: SessionEpoch) {
  if (!canSetSinkId()) {
    dispatch(runtime, {
      kind: "host-failed",
      epoch: token,
      obstacle: { kind: "sink-unsupported" },
      intent: "meeting",
    });
    return;
  }
  const devices = await probeDeviceList();
  if (!isCurrent(runtime, token)) {
    return;
  }
  const capture = pickCaptureDevice(devices);
  if (capture.kind === "none") {
    dispatch(runtime, {
      kind: "host-failed",
      epoch: token,
      obstacle: { kind: "loopback-input" },
      intent: "meeting",
    });
    return;
  }
  runtime.captureDeviceId = capture.deviceId;
  const pick = pickMeetingSink(catalogLoopbacks(devices));
  if (pick.kind === "none") {
    runtime.captureDeviceId = null;
    dispatch(runtime, {
      kind: "host-failed",
      epoch: token,
      obstacle: { kind: "no-loopback" },
      intent: "meeting",
    });
    return;
  }
  if (pick.kind === "one") {
    await connectAndCalibrate(runtime, token, { kind: "meeting", sink: pick.sink }, capture.deviceId);
    return;
  }
  dispatch(runtime, { kind: "sink-choice-needed", epoch: token, sinks: pick.sinks });
}

async function start(runtime: Runtime, intent: RouteIntent) {
  if (isBusy(runtime)) {
    return;
  }
  const missing = missingCapabilities();
  if (missing.length > 0) {
    const [first, ...rest] = missing;
    dispatch(runtime, { kind: "unsupported", missing: [first, ...rest] });
    return;
  }
  runtime.starting = true;
  runtime.currentEpoch += 1;
  const token = epoch(runtime.currentEpoch);
  dispatch(runtime, { kind: "start-requested", epoch: token, intent });
  try {
    if (intent === "hear-through") {
      await connectAndCalibrate(runtime, token, { kind: "hear-through" }, undefined);
      return;
    }
    await startMeeting(runtime, token);
  } catch (error) {
    await abandonHost(runtime);
    failHost(runtime, token, intent, error);
  } finally {
    if (isCurrent(runtime, token)) {
      runtime.starting = false;
    }
  }
}

async function chooseSink(runtime: Runtime, sink: LoopbackSink) {
  if (runtime.starting || runtime.session.kind !== "choosing-sink") {
    return;
  }
  const token = runtime.session.epoch;
  const inputDeviceId = runtime.captureDeviceId;
  if (!inputDeviceId) {
    dispatch(runtime, {
      kind: "host-failed",
      epoch: token,
      obstacle: { kind: "loopback-input" },
      intent: "meeting",
    });
    return;
  }
  runtime.starting = true;
  dispatch(runtime, { kind: "sink-chosen", epoch: token });
  try {
    await connectAndCalibrate(runtime, token, { kind: "meeting", sink }, inputDeviceId);
  } catch (error) {
    await abandonHost(runtime);
    failHost(runtime, token, "meeting", error);
  } finally {
    if (isCurrent(runtime, token)) {
      runtime.starting = false;
    }
  }
}

function recalibrate(runtime: Runtime) {
  if (runtime.session.kind !== "active" || !runtime.host) {
    return;
  }
  runtime.currentEpoch += 1;
  const token = epoch(runtime.currentEpoch);
  runtime.host.send({ kind: "set-monitor", open: false });
  runtime.host.send({ kind: "calibrate", epoch: runtime.currentEpoch });
  dispatch(runtime, { kind: "recalibrate-requested", epoch: token });
}

export function createHushSession(onChange: (session: Session) => void): HushActions & {
  getSession: () => Session;
} {
  const runtime: Runtime = {
    session: IDLE,
    currentEpoch: 0,
    host: null,
    captureDeviceId: null,
    starting: false,
    onChange,
  };
  return {
    getSession() {
      return runtime.session;
    },
    start: (intent) => start(runtime, intent),
    chooseSink: (sink) => chooseSink(runtime, sink),
    stop: () => stop(runtime),
    recalibrate: () => recalibrate(runtime),
    setStrength(value) {
      const next = clampStrength(value);
      runtime.host?.send({ kind: "set-strength", value: next });
      dispatch(runtime, { kind: "strength-changed", value: next });
    },
    holdBypass(held) {
      runtime.host?.send({ kind: "set-bypass", held });
      dispatch(runtime, { kind: "bypass-held", held });
    },
    dismissGuard() {
      runtime.host?.send({ kind: "reset-guard" });
      dispatch(runtime, { kind: "guard-dismissed" });
    },
  };
}
