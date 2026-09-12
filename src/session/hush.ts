import { strength as clampStrength } from "../dsp/suppressor";
import { classify, missingCapabilities, openAudioHost, type AudioHost } from "../audio/host";
import type { EngineReport } from "../audio/protocol";
import {
  epoch,
  IDLE,
  reduce,
  type MeterSnapshot,
  type Session,
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
  start: () => Promise<void>;
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

async function stop(runtime: Runtime) {
  const current = runtime.host;
  runtime.host = null;
  if (current) {
    await current.close();
  }
  dispatch(runtime, { kind: "stopped" });
}

async function start(runtime: Runtime) {
  const busy =
    runtime.starting ||
    runtime.session.kind === "calibrating" ||
    runtime.session.kind === "active" ||
    runtime.session.kind === "requesting";
  if (busy) {
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
  dispatch(runtime, { kind: "start-requested", epoch: token });
  try {
    runtime.host = await openAudioHost({
      onReport: (report) => handleReport(runtime, report),
      onLost: (obstacle) => {
        void stop(runtime);
        dispatch(runtime, { kind: "host-failed", epoch: token, obstacle });
      },
    });
    dispatch(runtime, { kind: "host-opened", epoch: token, latencyMs: runtime.host.latencyMs });
    runtime.host.send({ kind: "calibrate", epoch: runtime.currentEpoch });
    runtime.host.send({ kind: "set-strength", value: 0.6 });
  } catch (error) {
    dispatch(runtime, { kind: "host-failed", epoch: token, obstacle: classify(error) });
    runtime.host = null;
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
    starting: false,
    onChange,
  };
  return {
    getSession() {
      return runtime.session;
    },
    start: () => start(runtime),
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
