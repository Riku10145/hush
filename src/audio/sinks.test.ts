import { describe, expect, it } from "vitest";
import { catalogLoopbacks, isLoopbackLabel, pickCaptureDevice, pickMeetingSink } from "./sinks";

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

describe("catalogLoopbacks", () => {
  it("keeps only loopback outputs", () => {
    const loopbacks = catalogLoopbacks([
      { kind: "audioinput", deviceId: "mic", label: "Built-in Microphone" },
      { kind: "audiooutput", deviceId: "", label: "empty" },
      { kind: "audiooutput", deviceId: "spk", label: "MacBook Pro Speakers" },
      { kind: "audiooutput", deviceId: "bh", label: "BlackHole 2ch" },
    ]);
    expect(loopbacks).toEqual([{ deviceId: "bh", label: "BlackHole 2ch" }]);
  });
});

describe("pickMeetingSink", () => {
  it("returns none, one, preferred BlackHole 2ch, or many", () => {
    expect(pickMeetingSink([])).toEqual({ kind: "none" });
    expect(pickMeetingSink([{ deviceId: "bh", label: "BlackHole 16ch" }])).toEqual({
      kind: "one",
      sink: { deviceId: "bh", label: "BlackHole 16ch" },
    });
    expect(
      pickMeetingSink([
        { deviceId: "bh16", label: "BlackHole 16ch" },
        { deviceId: "bh2", label: "BlackHole 2ch" },
      ]),
    ).toEqual({ kind: "one", sink: { deviceId: "bh2", label: "BlackHole 2ch" } });
    expect(
      pickMeetingSink([
        { deviceId: "a", label: "VB-Cable" },
        { deviceId: "b", label: "Soundflower (2ch)" },
      ]),
    ).toEqual({
      kind: "many",
      sinks: [
        { deviceId: "a", label: "VB-Cable" },
        { deviceId: "b", label: "Soundflower (2ch)" },
      ],
    });
  });
});

describe("pickCaptureDevice", () => {
  it("skips loopback inputs and empty ids", () => {
    expect(
      pickCaptureDevice([
        { kind: "audioinput", deviceId: "bh", label: "BlackHole 2ch" },
        { kind: "audiooutput", deviceId: "spk", label: "Speakers" },
      ]),
    ).toEqual({ kind: "none" });
    expect(
      pickCaptureDevice([
        { kind: "audioinput", deviceId: "bh", label: "BlackHole 2ch" },
        { kind: "audioinput", deviceId: "mic", label: "MacBook Pro Microphone" },
      ]),
    ).toEqual({ kind: "one", deviceId: "mic" });
  });
});
