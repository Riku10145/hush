import type { ReactNode } from "react";
import { Headphones, Pause, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { COPY, latencyCopy, missingLabel, obstacleCopy } from "@/ui/copy";
import { Spectrum } from "@/ui/Spectrum";
import { useHushSession } from "@/session/useHushSession";
import type { Session } from "@/session/state";

function Shell({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col justify-center px-4 py-8">
      <Card className="border-border/80 shadow-sm">
        <CardHeader className="gap-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Hush</p>
          <CardTitle className="text-2xl text-pretty md:text-3xl">{title}</CardTitle>
          <CardDescription className="text-base leading-relaxed text-pretty">{body}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">{children}</CardContent>
      </Card>
    </main>
  );
}

function StartPanel({ onStart }: { onStart: () => void }) {
  const copy = COPY.idle;
  return (
    <Shell title={copy.title} body={copy.body}>
      <Button size="lg" className="h-12 min-h-11 w-full text-base md:w-auto" onClick={onStart}>
        <Headphones />
        {copy.primary}
      </Button>
    </Shell>
  );
}

function RequestingPanel() {
  const copy = COPY.requesting;
  return (
    <Shell title={copy.title} body={copy.body}>
      <p className="text-sm text-muted-foreground">許可ダイアログが表示されないときは、アドレスバーのマイクアイコンを確認してください。</p>
    </Shell>
  );
}

function ObstaclePanel({
  session,
  onRetry,
}: {
  session: Extract<Session, { kind: "blocked" }>;
  onRetry: () => void;
}) {
  const copy = obstacleCopy(session.obstacle);
  return (
    <Shell title={copy.title} body={copy.body}>
      <Button size="lg" className="h-12 min-h-11 w-full md:w-auto" onClick={onRetry}>
        {copy.primary}
      </Button>
    </Shell>
  );
}

function UnsupportedPanel({ session }: { session: Extract<Session, { kind: "unsupported" }> }) {
  const copy = COPY.unsupported;
  return (
    <Shell title={copy.title} body={copy.body}>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        {session.missing.map((item) => (
          <li key={item}>{missingLabel(item)}</li>
        ))}
      </ul>
    </Shell>
  );
}

function CalibrationPanel({
  session,
  onCancel,
}: {
  session: Extract<Session, { kind: "calibrating" }>;
  onCancel: () => void;
}) {
  const copy = COPY.calibrating;
  const percent = Math.round(Math.min(1, Math.max(0, session.progress)) * 100);
  return (
    <Shell title={copy.title} body={copy.body}>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">{percent}%</p>
      <Button variant="outline" className="min-h-11" onClick={onCancel}>
        {copy.primary}
      </Button>
    </Shell>
  );
}

function HowlBanner({ peakHz, onDismiss }: { peakHz: number; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <ShieldAlert className="size-4" />
        音が戻ってきました
      </p>
      <p className="text-sm text-muted-foreground">
        ピークは約 {Math.round(peakHz)} Hz です。ヘッドホンをつけてから再開してください。
      </p>
      <Button className="min-h-11" onClick={onDismiss}>
        ヘッドホンをつけて再開
      </Button>
    </div>
  );
}

function StrengthControl({
  strength,
  onChange,
}: {
  strength: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-3">
      <span className="text-sm font-medium">抑える強さ {Math.round(strength * 100)}%</span>
      <Slider
        min={0}
        max={1}
        step={0.01}
        value={[strength]}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? value[0] : value;
          if (typeof next === "number") {
            onChange(next);
          }
        }}
      />
    </label>
  );
}

function MonitorControls({
  guarded,
  stopLabel,
  actions,
}: {
  guarded: boolean;
  stopLabel: string;
  actions: ReturnType<typeof useHushSession>["actions"];
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 flex-1"
        disabled={guarded}
        onPointerDown={() => actions.holdBypass(true)}
        onPointerUp={() => actions.holdBypass(false)}
        onPointerLeave={() => actions.holdBypass(false)}
        onPointerCancel={() => actions.holdBypass(false)}
      >
        押している間は原音
      </Button>
      <Button variant="outline" className="min-h-11" disabled={guarded} onClick={actions.recalibrate}>
        測り直す
      </Button>
      <Button variant="outline" className="min-h-11" onClick={() => void actions.stop()}>
        <Pause />
        {stopLabel}
      </Button>
    </div>
  );
}

function ActivePanel({
  session,
  actions,
}: {
  session: Extract<Session, { kind: "active" }>;
  actions: ReturnType<typeof useHushSession>["actions"];
}) {
  const copy = COPY.active;
  const guarded = session.monitor.kind === "held-by-guard";
  return (
    <Shell title={copy.title} body={`${copy.body} ${latencyCopy(session.latencyMs)}`}>
      {guarded ? <HowlBanner peakHz={session.monitor.peakHz} onDismiss={actions.dismissGuard} /> : null}
      <Spectrum input={session.meters.inputBands} noise={session.meters.noiseBands} />
      <StrengthControl strength={session.strength} onChange={actions.setStrength} />
      <MonitorControls guarded={guarded} stopLabel={copy.primary ?? "停止"} actions={actions} />
    </Shell>
  );
}

function App() {
  const { session, actions } = useHushSession();

  switch (session.kind) {
    case "unsupported":
      return <UnsupportedPanel session={session} />;
    case "idle":
      return <StartPanel onStart={() => void actions.start()} />;
    case "requesting":
      return <RequestingPanel />;
    case "blocked":
      return <ObstaclePanel session={session} onRetry={() => void actions.start()} />;
    case "calibrating":
      return <CalibrationPanel session={session} onCancel={() => void actions.stop()} />;
    case "active":
      return <ActivePanel session={session} actions={actions} />;
    default: {
      const _exhaustive: never = session;
      return _exhaustive;
    }
  }
}

export default App;
