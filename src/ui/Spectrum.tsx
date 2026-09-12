import { cn } from "@/lib/utils";

type SpectrumProps = {
  readonly input: Float32Array;
  readonly noise: Float32Array;
};

function barHeight(db: number): number {
  const clamped = Math.min(0, Math.max(-80, db));
  return ((clamped + 80) / 80) * 100;
}

export function Spectrum({ input, noise }: SpectrumProps) {
  const n = Math.min(input.length, noise.length);
  return (
    <div className="flex h-28 items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="relative flex h-full min-w-0 flex-1 items-end">
          <span
            className={cn("w-full rounded-t-sm bg-primary/80")}
            style={{ height: `${barHeight(input[i] ?? -80)}%` }}
          />
          <span
            className="absolute bottom-0 w-full rounded-t-sm bg-destructive/50"
            style={{ height: `${barHeight(noise[i] ?? -80)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
