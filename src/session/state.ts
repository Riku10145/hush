export type SessionEpoch = number & { readonly __brand: "SessionEpoch" };

export function epoch(value: number): SessionEpoch {
  return value as SessionEpoch;
}

export type Obstacle =
  | { readonly kind: "permission-denied" }
  | { readonly kind: "no-input-device" }
  | { readonly kind: "device-in-use" }
  | { readonly kind: "context-blocked" }
  | { readonly kind: "engine-failed"; readonly detail: string };

export type Capability = "audio-context" | "audio-worklet" | "get-user-media";

export type MonitorState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly bypassHeld: boolean }
  | { readonly kind: "held-by-guard"; readonly peakHz: number };

export type MeterSnapshot = {
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly reductionDb: number;
  readonly inputBands: Float32Array;
  readonly noiseBands: Float32Array;
  readonly guardMargin: number;
};

export const SILENT_METERS: MeterSnapshot = {
  inputLevel: 0,
  outputLevel: 0,
  reductionDb: 0,
  inputBands: new Float32Array(24),
  noiseBands: new Float32Array(24),
  guardMargin: 1,
};

export type Session =
  | { readonly kind: "unsupported"; readonly missing: readonly [Capability, ...Capability[]] }
  | { readonly kind: "idle" }
  | { readonly kind: "requesting"; readonly epoch: SessionEpoch }
  | { readonly kind: "blocked"; readonly obstacle: Obstacle }
  | {
      readonly kind: "calibrating";
      readonly epoch: SessionEpoch;
      readonly strength: number;
      readonly progress: number;
      readonly meters: MeterSnapshot;
      readonly replacing: boolean;
      readonly latencyMs: number;
    }
  | {
      readonly kind: "active";
      readonly epoch: SessionEpoch;
      readonly strength: number;
      readonly monitor: MonitorState;
      readonly meters: MeterSnapshot;
      readonly latencyMs: number;
    };

export type SessionEvent =
  | { readonly kind: "unsupported"; readonly missing: readonly [Capability, ...Capability[]] }
  | { readonly kind: "start-requested"; readonly epoch: SessionEpoch }
  | { readonly kind: "host-opened"; readonly epoch: SessionEpoch; readonly latencyMs: number }
  | { readonly kind: "host-failed"; readonly epoch: SessionEpoch; readonly obstacle: Obstacle }
  | { readonly kind: "calibrating"; readonly epoch: SessionEpoch; readonly progress: number; readonly meters: MeterSnapshot }
  | { readonly kind: "calibrated"; readonly epoch: SessionEpoch; readonly meters: MeterSnapshot }
  | { readonly kind: "metered"; readonly epoch: SessionEpoch; readonly meters: MeterSnapshot }
  | { readonly kind: "guard-tripped"; readonly epoch: SessionEpoch; readonly peakHz: number }
  | { readonly kind: "strength-changed"; readonly value: number }
  | { readonly kind: "bypass-held"; readonly held: boolean }
  | { readonly kind: "recalibrate-requested"; readonly epoch: SessionEpoch }
  | { readonly kind: "guard-dismissed" }
  | { readonly kind: "stopped" };

export const IDLE: Session = { kind: "idle" };

function sameEpoch(session: Session, next: SessionEpoch): boolean {
  return (
    (session.kind === "requesting" ||
      session.kind === "calibrating" ||
      session.kind === "active") &&
    session.epoch === next
  );
}

export function reduce(session: Session, event: SessionEvent): Session {
  switch (event.kind) {
    case "unsupported":
      return { kind: "unsupported", missing: event.missing };
    case "start-requested":
      if (session.kind === "requesting" || session.kind === "calibrating" || session.kind === "active") {
        return session;
      }
      return { kind: "requesting", epoch: event.epoch };
    case "host-opened":
      if (!sameEpoch(session, event.epoch)) {
        return session;
      }
      return {
        kind: "calibrating",
        epoch: event.epoch,
        strength: session.kind === "active" || session.kind === "calibrating" ? session.strength : 0.6,
        progress: 0,
        meters: SILENT_METERS,
        replacing: session.kind === "active",
        latencyMs: event.latencyMs,
      };
    case "host-failed":
      if (session.kind === "requesting" && session.epoch !== event.epoch) {
        return session;
      }
      return { kind: "blocked", obstacle: event.obstacle };
    case "calibrating":
      if (session.kind !== "calibrating" || session.epoch !== event.epoch) {
        return session;
      }
      return { ...session, progress: event.progress, meters: event.meters };
    case "calibrated":
      if (session.kind !== "calibrating" || session.epoch !== event.epoch) {
        return session;
      }
      return {
        kind: "active",
        epoch: session.epoch,
        strength: session.strength,
        monitor: { kind: "open", bypassHeld: false },
        meters: event.meters,
        latencyMs: session.latencyMs,
      };
    case "metered":
      if (session.kind !== "active" || session.epoch !== event.epoch) {
        return session;
      }
      return { ...session, meters: event.meters };
    case "guard-tripped":
      if (session.kind !== "active" || session.epoch !== event.epoch) {
        return session;
      }
      return {
        ...session,
        monitor: { kind: "held-by-guard", peakHz: event.peakHz },
      };
    case "strength-changed":
      if (session.kind === "active" || session.kind === "calibrating") {
        return { ...session, strength: event.value };
      }
      return session;
    case "bypass-held":
      if (session.kind !== "active" || session.monitor.kind !== "open") {
        return session;
      }
      return { ...session, monitor: { kind: "open", bypassHeld: event.held } };
    case "recalibrate-requested":
      if (session.kind !== "active") {
        return session;
      }
      return {
        kind: "calibrating",
        epoch: event.epoch,
        strength: session.strength,
        progress: 0,
        meters: SILENT_METERS,
        replacing: true,
        latencyMs: session.latencyMs,
      };
    case "guard-dismissed":
      if (session.kind !== "active" || session.monitor.kind !== "held-by-guard") {
        return session;
      }
      return { ...session, monitor: { kind: "open", bypassHeld: false } };
    case "stopped":
      return IDLE;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
