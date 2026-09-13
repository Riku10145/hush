import { describe, expect, it } from "vitest";
import { measureAccuracy } from "./accuracy";

describe("accuracy harness", () => {
  it("is deterministic and separates strength 0 from default strength", () => {
    const off = measureAccuracy(0);
    const on = measureAccuracy(0.6);
    const again = measureAccuracy(0.6);
    expect(off.reconstructionRms).toBeLessThan(1e-6);
    expect(on.reconstructionRms).toBeLessThan(1e-6);
    expect(on.siSdr).toBe(again.siSdr);
    expect(on.sepDb).toBe(again.sepDb);
    expect(on.siSdr).toBeGreaterThan(off.siSdr + 1);
    expect(on.noiseResid).toBeLessThan(off.noiseResid);
    expect(on.signalKeep).toBeGreaterThan(0.4);
  });

  it("prints the frozen metric", () => {
    const report = measureAccuracy();
    console.log(JSON.stringify(report, null, 2));
    expect(report.scenes).toHaveLength(5);
  });
});
