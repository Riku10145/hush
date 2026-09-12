import { describe, expect, it } from "vitest";
import { catalogSinks, isLoopbackLabel, pickMeetingSink } from "./sinks";

describe("isLoopbackLabel", () => {
  it("accepts known virtual devices and rejects speakers", () => {
    expect(isLoopbackLabel("BlackHole 2ch")).toBe(true);
    expect(isLoopbackLabel("BlackHole 16ch")).toBe(true);
    expect(isLoopbackLabel("Loopback Audio")).toBe(true);
    expect(isLoopbackLabel("VB-Cable")).toBe(true);
    expect(isLoopbackLabel("Soundflower (2ch)")).toBe(true);
    expect(isLoopbackLabel("MacBook Pro Speakers")).toBe(false);
    expect(isLoopbackLabel("Multi-Output Device")).toBe(false);
    expect(isLoopbackLabel("")).toBe(false);
  });
});

describe("catalogSinks", () => {
  it("keeps audio outputs and splits loopbacks", () => {
    const catalog = catalogSinks([
      { kind: "audioinput", deviceId: "mic", label: "Built-in Microphone" },
      { kind: "audiooutput", deviceId: "", label: "empty" },
      { kind: "audiooutput", deviceId: "spk", label: "MacBook Pro Speakers" },
      { kind: "audiooutput", deviceId: "bh", label: "BlackHole 2ch" },
    ]);
    expect(catalog.outputs.map((sink) => sink.deviceId)).toEqual(["spk", "bh"]);
    expect(catalog.loopbacks).toEqual([{ deviceId: "bh", label: "BlackHole 2ch" }]);
  });
});

describe("pickMeetingSink", () => {
  it("returns none, one, preferred BlackHole 2ch, or many", () => {
    expect(pickMeetingSink({ loopbacks: [], outputs: [] })).toEqual({ kind: "none" });
    expect(
      pickMeetingSink({
        loopbacks: [{ deviceId: "bh", label: "BlackHole 16ch" }],
        outputs: [],
      }),
    ).toEqual({ kind: "one", sink: { deviceId: "bh", label: "BlackHole 16ch" } });
    expect(
      pickMeetingSink({
        loopbacks: [
          { deviceId: "bh16", label: "BlackHole 16ch" },
          { deviceId: "bh2", label: "BlackHole 2ch" },
        ],
        outputs: [],
      }),
    ).toEqual({ kind: "one", sink: { deviceId: "bh2", label: "BlackHole 2ch" } });
    expect(
      pickMeetingSink({
        loopbacks: [
          { deviceId: "a", label: "VB-Cable" },
          { deviceId: "b", label: "Soundflower (2ch)" },
        ],
        outputs: [],
      }),
    ).toEqual({
      kind: "many",
      sinks: [
        { deviceId: "a", label: "VB-Cable" },
        { deviceId: "b", label: "Soundflower (2ch)" },
      ],
    });
  });
});
