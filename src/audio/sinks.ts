export type LoopbackSink = {
  readonly deviceId: string;
  readonly label: string;
};

export type SinkCatalog = {
  readonly loopbacks: readonly LoopbackSink[];
  readonly outputs: readonly LoopbackSink[];
};

export type MeetingSinkPick =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly sink: LoopbackSink }
  | { readonly kind: "many"; readonly sinks: readonly LoopbackSink[] };

export type AudioRoute =
  | { readonly kind: "hear-through" }
  | { readonly kind: "meeting"; readonly sink: LoopbackSink };

export type DeviceListing = {
  readonly kind: string;
  readonly deviceId: string;
  readonly label: string;
};

const PREFERRED_LOOPBACK = /blackhole\s*2\s*ch/i;

export function isLoopbackLabel(label: string): boolean {
  const name = label.trim().toLowerCase();
  if (name.length === 0) {
    return false;
  }
  if (name.includes("blackhole")) {
    return true;
  }
  if (name.includes("vb-cable") || name.includes("vb cable") || name.includes("vb-audio")) {
    return true;
  }
  if (name.includes("soundflower")) {
    return true;
  }
  return /(?:^|[\s(])loopback(?:[\s)]|$)/.test(name) || name.includes("loopback audio");
}

export function catalogSinks(devices: readonly DeviceListing[]): SinkCatalog {
  const outputs: LoopbackSink[] = [];
  const loopbacks: LoopbackSink[] = [];
  for (const device of devices) {
    if (device.kind !== "audiooutput" || device.deviceId.length === 0) {
      continue;
    }
    const sink = { deviceId: device.deviceId, label: device.label.trim() || device.deviceId };
    outputs.push(sink);
    if (isLoopbackLabel(sink.label)) {
      loopbacks.push(sink);
    }
  }
  return { loopbacks, outputs };
}

export function pickMeetingSink(catalog: SinkCatalog): MeetingSinkPick {
  const { loopbacks } = catalog;
  if (loopbacks.length === 0) {
    return { kind: "none" };
  }
  if (loopbacks.length === 1) {
    return { kind: "one", sink: loopbacks[0] };
  }
  const preferred = loopbacks.find((sink) => PREFERRED_LOOPBACK.test(sink.label));
  if (preferred) {
    return { kind: "one", sink: preferred };
  }
  return { kind: "many", sinks: loopbacks };
}
