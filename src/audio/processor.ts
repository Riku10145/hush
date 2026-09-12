import { BAND_COUNT, createSuppressor, defaultEngineConfig, strength } from "../dsp/suppressor";
import type { EngineCommand, EngineReport } from "./protocol";
import { isEngineCommand } from "./protocol";

const inputBands = new Float32Array(BAND_COUNT);
const noiseBands = new Float32Array(BAND_COUNT);

class HushProcessor extends AudioWorkletProcessor {
  private engine = createSuppressor(defaultEngineConfig(sampleRate));
  private hops = 0;
  private wasCalibrating = true;
  private tripped = false;
  private epoch = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (!isEngineCommand(event.data)) {
        return;
      }
      this.handle(event.data);
    };
  }

  handle(command: EngineCommand) {
    switch (command.kind) {
      case "calibrate":
        this.epoch = command.epoch;
        this.engine.calibrate();
        this.wasCalibrating = true;
        this.tripped = false;
        return;
      case "set-strength":
        this.engine.setStrength(strength(command.value));
        return;
      case "set-monitor":
        this.engine.setMonitor(command.open);
        return;
      case "set-bypass":
        this.engine.setBypass(command.held);
        return;
      case "reset-guard":
        this.tripped = false;
        this.engine.setMonitor(true);
        return;
    }
  }

  meters(guardMargin: number) {
    this.engine.bands("input", inputBands);
    this.engine.bands("noise", noiseBands);
    return {
      inputLevel: 0,
      outputLevel: 0,
      reductionDb: 0,
      inputBands: Array.from(inputBands),
      noiseBands: Array.from(noiseBands),
      guardMargin,
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) {
      return true;
    }
    const report = this.engine.process(input, output);
    this.hops += 1;

    if (report.kind === "calibrating") {
      this.wasCalibrating = true;
      if (this.hops % 8 === 0) {
        const meters = this.meters(1);
        meters.inputLevel = report.inputLevel;
        const payload: EngineReport = {
          kind: "calibrating",
          epoch: this.epoch,
          progress: report.framesSeeded / report.framesNeeded,
          meters,
        };
        this.port.postMessage(payload);
      }
      return true;
    }

    if (this.wasCalibrating) {
      this.wasCalibrating = false;
      const meters = this.meters(1);
      meters.inputLevel = report.inputLevel;
      meters.outputLevel = report.outputLevel;
      meters.reductionDb = report.reductionDb;
      const payload: EngineReport = { kind: "calibrated", epoch: this.epoch, meters };
      this.port.postMessage(payload);
      this.engine.setMonitor(true);
    }

    if (report.howl.kind === "trip" && !this.tripped) {
      this.tripped = true;
      const payload: EngineReport = { kind: "guard-tripped", epoch: this.epoch, peakHz: report.howl.peakHz };
      this.port.postMessage(payload);
    }

    if (this.hops % 8 === 0) {
      const meters = this.meters(report.howl.kind === "clear" ? report.howl.margin : 0);
      meters.inputLevel = report.inputLevel;
      meters.outputLevel = report.outputLevel;
      meters.reductionDb = report.reductionDb;
      const payload: EngineReport = { kind: "metered", epoch: this.epoch, meters };
      this.port.postMessage(payload);
    }

    return true;
  }
}

registerProcessor("hush-processor", HushProcessor);
