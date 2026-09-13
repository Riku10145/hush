export type LoopbackSink = {
  readonly deviceId: string;
  readonly label: string;
};

export type MeetingSinkPick =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly sink: LoopbackSink }
  | { readonly kind: "many"; readonly sinks: readonly LoopbackSink[] };

export type CapturePick =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly deviceId: string };

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

function labeledDevice(device: DeviceListing): LoopbackSink {
  return { deviceId: device.deviceId, label: device.label.trim() || device.deviceId };
}

export function catalogLoopbacks(devices: readonly DeviceListing[]): readonly LoopbackSink[] {
  const loopbacks: LoopbackSink[] = [];
  for (const device of devices) {
    if (device.kind !== "audiooutput" || device.deviceId.length === 0) {
      continue;
    }
    const sink = labeledDevice(device);
    if (isLoopbackLabel(sink.label)) {
      loopbacks.push(sink);
    }
  }
  return loopbacks;
}

export function pickMeetingSink(loopbacks: readonly LoopbackSink[]): MeetingSinkPick {
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

export function pickCaptureDevice(devices: readonly DeviceListing[]): CapturePick {
  for (const device of devices) {
    if (device.kind !== "audioinput" || device.deviceId.length === 0) {
      continue;
    }
    if (isLoopbackLabel(device.label)) {
      continue;
    }
    return { kind: "one", deviceId: device.deviceId };
  }
  return { kind: "none" };
}
