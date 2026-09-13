import type { LoopbackSink } from "../audio/sinks";

export type SessionEpoch = number & { readonly __brand: "SessionEpoch" };

export type RouteIntent = "hear-through" | "meeting";

export type AudioRoute =
  | { readonly kind: "hear-through" }
  | { readonly kind: "meeting"; readonly sink: LoopbackSink };

export function epoch(value: number): SessionEpoch {
  return value as SessionEpoch;
}

export type Obstacle =
  | { readonly kind: "permission-denied" }
  | { readonly kind: "no-input-device" }
  | { readonly kind: "device-in-use" }
  | { readonly kind: "context-blocked" }
  | { readonly kind: "engine-failed"; readonly detail: string }
  | { readonly kind: "no-loopback" }
  | { readonly kind: "loopback-input" }
  | { readonly kind: "sink-unsupported" }
  | { readonly kind: "sink-failed"; readonly detail: string };

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
  | { readonly kind: "requesting"; readonly epoch: SessionEpoch; readonly intent: RouteIntent }
  | { readonly kind: "choosing-sink"; readonly epoch: SessionEpoch; readonly sinks: readonly LoopbackSink[] }
  | { readonly kind: "blocked"; readonly obstacle: Obstacle; readonly intent: RouteIntent }
  | {
      readonly kind: "calibrating";
      readonly epoch: SessionEpoch;
      readonly strength: number;
      readonly progress: number;
      readonly meters: MeterSnapshot;
      readonly replacing: boolean;
      readonly latencyMs: number;
      readonly route: AudioRoute;
    }
  | {
      readonly kind: "active";
      readonly epoch: SessionEpoch;
      readonly strength: number;
      readonly monitor: MonitorState;
      readonly meters: MeterSnapshot;
      readonly latencyMs: number;
      readonly route: AudioRoute;
    };

export type SessionEvent =
  | { readonly kind: "unsupported"; readonly missing: readonly [Capability, ...Capability[]] }
  | { readonly kind: "start-requested"; readonly epoch: SessionEpoch; readonly intent: RouteIntent }
  | {
      readonly kind: "sink-choice-needed";
      readonly epoch: SessionEpoch;
      readonly sinks: readonly LoopbackSink[];
    }
  | { readonly kind: "sink-chosen"; readonly epoch: SessionEpoch }
  | { readonly kind: "host-opened"; readonly epoch: SessionEpoch; readonly latencyMs: number; readonly route: AudioRoute }
  | {
      readonly kind: "host-failed";
      readonly epoch: SessionEpoch;
      readonly obstacle: Obstacle;
      readonly intent: RouteIntent;
    }
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
      session.kind === "choosing-sink" ||
      session.kind === "calibrating" ||
      session.kind === "active") &&
    session.epoch === next
  );
}

function onStartRequested(session: Session, event: Extract<SessionEvent, { kind: "start-requested" }>): Session {
  if (
    session.kind === "requesting" ||
    session.kind === "choosing-sink" ||
    session.kind === "calibrating" ||
    session.kind === "active"
  ) {
    return session;
  }
  return { kind: "requesting", epoch: event.epoch, intent: event.intent };
}

function onSinkChoiceNeeded(
  session: Session,
  event: Extract<SessionEvent, { kind: "sink-choice-needed" }>,
): Session {
  if (session.kind !== "requesting" || session.epoch !== event.epoch) {
    return session;
  }
  return { kind: "choosing-sink", epoch: event.epoch, sinks: event.sinks };
}

function onSinkChosen(session: Session, event: Extract<SessionEvent, { kind: "sink-chosen" }>): Session {
  if (session.kind !== "choosing-sink" || session.epoch !== event.epoch) {
    return session;
  }
  return { kind: "requesting", epoch: event.epoch, intent: "meeting" };
}

function onHostOpened(session: Session, event: Extract<SessionEvent, { kind: "host-opened" }>): Session {
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
    route: event.route,
  };
}

function onHostFailed(session: Session, event: Extract<SessionEvent, { kind: "host-failed" }>): Session {
  if (session.kind === "idle" || session.kind === "unsupported") {
    return session;
  }
  if (
    (session.kind === "requesting" || session.kind === "choosing-sink") &&
    session.epoch !== event.epoch
  ) {
    return session;
  }
  return { kind: "blocked", obstacle: event.obstacle, intent: event.intent };
}

function onCalibrating(session: Session, event: Extract<SessionEvent, { kind: "calibrating" }>): Session {
  if (session.kind !== "calibrating" || session.epoch !== event.epoch) {
    return session;
  }
  return { ...session, progress: event.progress, meters: event.meters };
}

function onCalibrated(session: Session, event: Extract<SessionEvent, { kind: "calibrated" }>): Session {
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
    route: session.route,
  };
}

function onMetered(session: Session, event: Extract<SessionEvent, { kind: "metered" }>): Session {
  if (session.kind !== "active" || session.epoch !== event.epoch) {
    return session;
  }
  return { ...session, meters: event.meters };
}

function onGuardTripped(session: Session, event: Extract<SessionEvent, { kind: "guard-tripped" }>): Session {
  if (session.kind !== "active" || session.epoch !== event.epoch) {
    return session;
  }
  return { ...session, monitor: { kind: "held-by-guard", peakHz: event.peakHz } };
}

function onStrengthChanged(session: Session, event: Extract<SessionEvent, { kind: "strength-changed" }>): Session {
  if (session.kind === "active" || session.kind === "calibrating") {
    return { ...session, strength: event.value };
  }
  return session;
}

function onBypassHeld(session: Session, event: Extract<SessionEvent, { kind: "bypass-held" }>): Session {
  if (session.kind !== "active" || session.monitor.kind !== "open") {
    return session;
  }
  return { ...session, monitor: { kind: "open", bypassHeld: event.held } };
}

function onRecalibrate(session: Session, event: Extract<SessionEvent, { kind: "recalibrate-requested" }>): Session {
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
    route: session.route,
  };
}

function onGuardDismissed(session: Session): Session {
  if (session.kind !== "active" || session.monitor.kind !== "held-by-guard") {
    return session;
  }
  return { ...session, monitor: { kind: "open", bypassHeld: false } };
}

export function reduce(session: Session, event: SessionEvent): Session {
  switch (event.kind) {
    case "unsupported":
      return { kind: "unsupported", missing: event.missing };
    case "start-requested":
      return onStartRequested(session, event);
    case "sink-choice-needed":
      return onSinkChoiceNeeded(session, event);
    case "sink-chosen":
      return onSinkChosen(session, event);
    case "host-opened":
      return onHostOpened(session, event);
    case "host-failed":
      return onHostFailed(session, event);
    case "calibrating":
      return onCalibrating(session, event);
    case "calibrated":
      return onCalibrated(session, event);
    case "metered":
      return onMetered(session, event);
    case "guard-tripped":
      return onGuardTripped(session, event);
    case "strength-changed":
      return onStrengthChanged(session, event);
    case "bypass-held":
      return onBypassHeld(session, event);
    case "recalibrate-requested":
      return onRecalibrate(session, event);
    case "guard-dismissed":
      return onGuardDismissed(session);
    case "stopped":
      return IDLE;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
