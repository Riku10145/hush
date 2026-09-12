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

export function createHushSession(onChange: (session: Session) => void): HushActions & {
  getSession: () => Session;
} {
  let session: Session = IDLE;
  let currentEpoch = 0;
  let host: AudioHost | null = null;
  let starting = false;

  function publish(next: Session) {
    session = next;
    onChange(session);
  }

  function dispatch(event: Parameters<typeof reduce>[1]) {
    publish(reduce(session, event));
  }

  function handleReport(report: EngineReport) {
    const token = epoch(report.epoch);
    if (report.kind === "calibrating") {
      dispatch({
        kind: "calibrating",
        epoch: token,
        progress: report.progress,
        meters: toMeters(report),
      });
      return;
    }
    if (report.kind === "calibrated") {
      dispatch({ kind: "calibrated", epoch: token, meters: toMeters(report) });
      host?.send({ kind: "set-monitor", open: true });
      return;
    }
    if (report.kind === "metered") {
      dispatch({ kind: "metered", epoch: token, meters: toMeters(report) });
      return;
    }
    dispatch({ kind: "guard-tripped", epoch: token, peakHz: report.peakHz });
    host?.send({ kind: "set-monitor", open: false });
  }

  async function stop() {
    const current = host;
    host = null;
    if (current) {
      await current.close();
    }
    dispatch({ kind: "stopped" });
  }

  return {
    getSession() {
      return session;
    },
    async start() {
      if (starting || session.kind === "calibrating" || session.kind === "active" || session.kind === "requesting") {
        return;
      }
      const missing = missingCapabilities();
      if (missing.length > 0) {
        const [first, ...rest] = missing;
        dispatch({ kind: "unsupported", missing: [first, ...rest] });
        return;
      }
      starting = true;
      currentEpoch += 1;
      const token = epoch(currentEpoch);
      dispatch({ kind: "start-requested", epoch: token });
      try {
        host = await openAudioHost({
          onReport: handleReport,
          onLost: (obstacle) => {
            void stop();
            dispatch({ kind: "host-failed", epoch: token, obstacle });
          },
        });
        dispatch({ kind: "host-opened", epoch: token, latencyMs: host.latencyMs });
        host.send({ kind: "calibrate", epoch: currentEpoch });
        host.send({ kind: "set-strength", value: 0.6 });
      } catch (error) {
        dispatch({ kind: "host-failed", epoch: token, obstacle: classify(error) });
        host = null;
      } finally {
        starting = false;
      }
    },
    stop,
    recalibrate() {
      if (session.kind !== "active" || !host) {
        return;
      }
      currentEpoch += 1;
      const token = epoch(currentEpoch);
      host.send({ kind: "set-monitor", open: false });
      host.send({ kind: "calibrate", epoch: currentEpoch });
      dispatch({ kind: "recalibrate-requested", epoch: token });
    },
    setStrength(value) {
      const next = clampStrength(value);
      host?.send({ kind: "set-strength", value: next });
      dispatch({ kind: "strength-changed", value: next });
    },
    holdBypass(held) {
      host?.send({ kind: "set-bypass", held });
      dispatch({ kind: "bypass-held", held });
    },
    dismissGuard() {
      host?.send({ kind: "reset-guard" });
      dispatch({ kind: "guard-dismissed" });
    },
  };
}
