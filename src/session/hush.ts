import { strength as clampStrength } from "../dsp/suppressor";
import {
  canSetSinkId,
  classify,
  listSinkCatalog,
  missingCapabilities,
  openAudioHost,
  openInputStream,
  type AudioHost,
} from "../audio/host";
import type { EngineReport } from "../audio/protocol";
import { pickMeetingSink, type AudioRoute, type LoopbackSink, type RouteIntent } from "../audio/sinks";
import {
  epoch,
  IDLE,
  reduce,
  type MeterSnapshot,
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
  heldStream: MediaStream | null;
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

function dropHeldStream(runtime: Runtime) {
  const stream = runtime.heldStream;
  runtime.heldStream = null;
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function sinkIdOf(route: AudioRoute): string {
  return route.kind === "meeting" ? route.sink.deviceId : "";
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
  dropHeldStream(runtime);
  const current = runtime.host;
  runtime.host = null;
  if (current) {
    await current.close();
  }
}

async function stop(runtime: Runtime) {
  await abandonHost(runtime);
  dispatch(runtime, { kind: "stopped" });
}

async function connectAndCalibrate(
  runtime: Runtime,
  token: SessionEpoch,
  route: AudioRoute,
  stream: MediaStream | undefined,
) {
  runtime.host = await openAudioHost({
    sinkId: sinkIdOf(route),
    stream,
    onReport: (report) => handleReport(runtime, report),
    onLost: (obstacle) => {
      void stop(runtime);
      dispatch(runtime, { kind: "host-failed", epoch: token, obstacle });
    },
  });
  runtime.heldStream = null;
  dispatch(runtime, {
    kind: "host-opened",
    epoch: token,
    latencyMs: runtime.host.latencyMs,
    route,
  });
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

async function startMeeting(runtime: Runtime, token: SessionEpoch) {
  const stream = await openInputStream();
  runtime.heldStream = stream;
  const pick = pickMeetingSink(await listSinkCatalog());
  if (pick.kind === "none") {
    dropHeldStream(runtime);
    dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: { kind: "no-loopback" } });
    return;
  }
  if (pick.kind === "one") {
    await connectAndCalibrate(runtime, token, { kind: "meeting", sink: pick.sink }, stream);
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
  if (intent === "meeting" && !canSetSinkId()) {
    runtime.currentEpoch += 1;
    const token = epoch(runtime.currentEpoch);
    dispatch(runtime, { kind: "start-requested", epoch: token, intent });
    dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: { kind: "sink-unsupported" } });
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
    dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: classify(error) });
  } finally {
    runtime.starting = false;
  }
}

async function chooseSink(runtime: Runtime, sink: LoopbackSink) {
  if (runtime.starting || runtime.session.kind !== "choosing-sink") {
    return;
  }
  runtime.starting = true;
  const token = runtime.session.epoch;
  const stream = runtime.heldStream ?? undefined;
  try {
    await connectAndCalibrate(runtime, token, { kind: "meeting", sink }, stream);
  } catch (error) {
    await abandonHost(runtime);
    dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: classify(error) });
  } finally {
    runtime.starting = false;
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
    heldStream: null,
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
