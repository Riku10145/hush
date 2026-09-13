import { describe, expect, it } from "vitest";
import { epoch, IDLE, reduce, SILENT_METERS } from "./state";

const HEAR_THROUGH = { kind: "hear-through" } as const;
const MEETING_SINK = { deviceId: "bh", label: "BlackHole 2ch" } as const;
const MEETING_ROUTE = { kind: "meeting", sink: MEETING_SINK } as const;

describe("reduce", () => {
  it("keeps the monitor shut until calibration finishes", () => {
    const e = epoch(1);
    const requesting = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "hear-through" });
    const calibrating = reduce(requesting, {
      kind: "host-opened",
      epoch: e,
      latencyMs: 20,
      route: HEAR_THROUGH,
    });
    expect(calibrating.kind).toBe("calibrating");
    const active = reduce(calibrating, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    expect(active.kind === "active" && active.monitor.kind === "open").toBe(true);
  });

  it("ignores a stale calibration from an older epoch", () => {
    const first = epoch(1);
    const second = epoch(2);
    let session = reduce(IDLE, { kind: "start-requested", epoch: first, intent: "hear-through" });
    session = reduce(session, { kind: "host-opened", epoch: first, latencyMs: 20, route: HEAR_THROUGH });
    session = reduce(session, { kind: "calibrated", epoch: first, meters: SILENT_METERS });
    session = reduce(session, { kind: "recalibrate-requested", epoch: second });
    session = reduce(session, { kind: "calibrated", epoch: first, meters: SILENT_METERS });
    expect(session.kind).toBe("calibrating");
    if (session.kind === "calibrating") {
      expect(session.epoch).toBe(second);
    }
  });

  it("holds the monitor after howl until the user dismisses it", () => {
    const e = epoch(1);
    let session = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "hear-through" });
    session = reduce(session, { kind: "host-opened", epoch: e, latencyMs: 20, route: HEAR_THROUGH });
    session = reduce(session, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    session = reduce(session, { kind: "guard-tripped", epoch: e, peakHz: 1000 });
    expect(session.kind === "active" && session.monitor.kind === "held-by-guard").toBe(true);
    session = reduce(session, { kind: "guard-dismissed" });
    expect(session.kind === "active" && session.monitor.kind === "open").toBe(true);
  });

  it("stores a meeting route when the host opens", () => {
    const e = epoch(1);
    let session = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "meeting" });
    session = reduce(session, { kind: "host-opened", epoch: e, latencyMs: 20, route: MEETING_ROUTE });
    expect(session).toEqual({
      kind: "calibrating",
      epoch: e,
      strength: 0.6,
      progress: 0,
      meters: SILENT_METERS,
      replacing: false,
      latencyMs: 20,
      route: MEETING_ROUTE,
    });
    session = reduce(session, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    expect(session).toEqual({
      kind: "active",
      epoch: e,
      strength: 0.6,
      monitor: { kind: "open", bypassHeld: false },
      meters: SILENT_METERS,
      latencyMs: 20,
      route: MEETING_ROUTE,
    });
  });

  it("enters choosing-sink from sink-choice-needed", () => {
    const e = epoch(1);
    const sinks = [
      { deviceId: "a", label: "VB-Cable" },
      { deviceId: "b", label: "Soundflower (2ch)" },
    ];
    let session = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "meeting" });
    session = reduce(session, { kind: "sink-choice-needed", epoch: e, sinks });
    expect(session).toEqual({ kind: "choosing-sink", epoch: e, sinks });
    session = reduce(session, { kind: "sink-chosen", epoch: e });
    expect(session).toEqual({ kind: "requesting", epoch: e, intent: "meeting" });
    session = reduce(session, {
      kind: "host-opened",
      epoch: e,
      latencyMs: 18,
      route: { kind: "meeting", sink: sinks[0] },
    });
    expect(session.kind === "calibrating" && session.route).toEqual({
      kind: "meeting",
      sink: sinks[0],
    });
  });

  it("ignores sink-choice-needed and host-opened from a stale epoch", () => {
    const first = epoch(1);
    const second = epoch(2);
    let session = reduce(IDLE, { kind: "start-requested", epoch: first, intent: "meeting" });
    session = reduce(session, {
      kind: "sink-choice-needed",
      epoch: second,
      sinks: [MEETING_SINK],
    });
    expect(session).toEqual({ kind: "requesting", epoch: first, intent: "meeting" });
    session = reduce(session, {
      kind: "host-opened",
      epoch: second,
      latencyMs: 20,
      route: MEETING_ROUTE,
    });
    expect(session).toEqual({ kind: "requesting", epoch: first, intent: "meeting" });
  });

  it("stores a hear-through route from host-opened", () => {
    const e = epoch(1);
    let session = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "hear-through" });
    session = reduce(session, { kind: "host-opened", epoch: e, latencyMs: 20, route: HEAR_THROUGH });
    expect(session.kind === "calibrating" && session.route).toEqual(HEAR_THROUGH);
    session = reduce(session, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    expect(session.kind === "active" && session.route).toEqual(HEAR_THROUGH);
  });

  it("preserves route and strength across recalibrate", () => {
    const first = epoch(1);
    const second = epoch(2);
    let session = reduce(IDLE, { kind: "start-requested", epoch: first, intent: "meeting" });
    session = reduce(session, { kind: "host-opened", epoch: first, latencyMs: 20, route: MEETING_ROUTE });
    session = reduce(session, { kind: "calibrated", epoch: first, meters: SILENT_METERS });
    session = reduce(session, { kind: "strength-changed", value: 0.4 });
    session = reduce(session, { kind: "recalibrate-requested", epoch: second });
    expect(session).toEqual({
      kind: "calibrating",
      epoch: second,
      strength: 0.4,
      progress: 0,
      meters: SILENT_METERS,
      replacing: true,
      latencyMs: 20,
      route: MEETING_ROUTE,
    });
  });

  it("keeps idle when host-failed arrives after stop", () => {
    const e = epoch(1);
    const idle = reduce(IDLE, {
      kind: "host-failed",
      epoch: e,
      obstacle: { kind: "sink-failed", detail: "gone" },
      intent: "meeting",
    });
    expect(idle).toEqual(IDLE);
  });

  it("stores host-failed intent from the event", () => {
    const e = epoch(1);
    let session = reduce(IDLE, { kind: "start-requested", epoch: e, intent: "meeting" });
    session = reduce(session, {
      kind: "host-failed",
      epoch: e,
      obstacle: { kind: "no-loopback" },
      intent: "meeting",
    });
    expect(session).toEqual({
      kind: "blocked",
      obstacle: { kind: "no-loopback" },
      intent: "meeting",
    });
  });
});
