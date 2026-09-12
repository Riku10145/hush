import { describe, expect, it } from "vitest";
import { epoch, IDLE, reduce, SILENT_METERS } from "./state";

describe("reduce", () => {
  it("keeps the monitor shut until calibration finishes", () => {
    const e = epoch(1);
    const requesting = reduce(IDLE, { kind: "start-requested", epoch: e });
    const calibrating = reduce(requesting, { kind: "host-opened", epoch: e, latencyMs: 20 });
    expect(calibrating.kind).toBe("calibrating");
    const active = reduce(calibrating, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    expect(active.kind === "active" && active.monitor.kind === "open").toBe(true);
  });

  it("ignores a stale calibration from an older epoch", () => {
    const first = epoch(1);
    const second = epoch(2);
    let session = reduce(IDLE, { kind: "start-requested", epoch: first });
    session = reduce(session, { kind: "host-opened", epoch: first, latencyMs: 20 });
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
    let session = reduce(IDLE, { kind: "start-requested", epoch: e });
    session = reduce(session, { kind: "host-opened", epoch: e, latencyMs: 20 });
    session = reduce(session, { kind: "calibrated", epoch: e, meters: SILENT_METERS });
    session = reduce(session, { kind: "guard-tripped", epoch: e, peakHz: 1000 });
    expect(session.kind === "active" && session.monitor.kind === "held-by-guard").toBe(true);
    session = reduce(session, { kind: "guard-dismissed" });
    expect(session.kind === "active" && session.monitor.kind === "open").toBe(true);
  });
});
