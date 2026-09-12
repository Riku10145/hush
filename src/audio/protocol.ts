export type EngineCommand =
  | { readonly kind: "calibrate"; readonly epoch: number }
  | { readonly kind: "set-strength"; readonly value: number }
  | { readonly kind: "set-monitor"; readonly open: boolean }
  | { readonly kind: "set-bypass"; readonly held: boolean }
  | { readonly kind: "reset-guard" };

export type EngineReport =
  | {
      readonly kind: "calibrating";
      readonly epoch: number;
      readonly progress: number;
      readonly meters: {
        inputLevel: number;
        outputLevel: number;
        reductionDb: number;
        inputBands: number[];
        noiseBands: number[];
        guardMargin: number;
      };
    }
  | {
      readonly kind: "calibrated";
      readonly epoch: number;
      readonly meters: {
        inputLevel: number;
        outputLevel: number;
        reductionDb: number;
        inputBands: number[];
        noiseBands: number[];
        guardMargin: number;
      };
    }
  | {
      readonly kind: "metered";
      readonly epoch: number;
      readonly meters: {
        inputLevel: number;
        outputLevel: number;
        reductionDb: number;
        inputBands: number[];
        noiseBands: number[];
        guardMargin: number;
      };
    }
  | { readonly kind: "guard-tripped"; readonly epoch: number; readonly peakHz: number };

export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const kind = (value as { kind: unknown }).kind;
  return (
    kind === "calibrate" ||
    kind === "set-strength" ||
    kind === "set-monitor" ||
    kind === "set-bypass" ||
    kind === "reset-guard"
  );
}

export function isEngineReport(value: unknown): value is EngineReport {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const kind = (value as { kind: unknown }).kind;
  return (
    kind === "calibrating" ||
    kind === "calibrated" ||
    kind === "metered" ||
    kind === "guard-tripped"
  );
}
