import { useEffect, useReducer, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { createSession, type SessionHandle } from '@/session/hush'
import { reduce, type Session } from '@/session/state'

const STRENGTH_LABELS = ['off', 'soft', 'medium', 'strong'] as const

export default function App() {
  const epoch = useRef(createSession())
  const [session, dispatch] = useReducer(
    (current: Session, action: Parameters<typeof reduce>[1]) =>
      reduce(current, action, epoch.current.handle),
    epoch.current.session,
  )

  useEffect(() => {
    const id = window.setInterval(() => dispatch({ type: 'poll' }), 80)
    return () => {
      window.clearInterval(id)
      epoch.current.handle.stop()
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <header className="space-y-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Hush</p>
        <h1 className="text-3xl font-semibold tracking-tight">Hear the room. Cut the drone.</h1>
        <p className="text-muted-foreground text-pretty">
          Put on headphones. Hush listens through the microphone, learns the steady noise in the
          room, and plays back what is left — voices, a knock, a kettle click. It does not cancel
          sound at your eardrum. It is hear-through with the drone carved out.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{titleFor(session)}</CardTitle>
          <CardDescription>{copyFor(session)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Panel session={session} handle={epoch.current.handle} dispatch={dispatch} />
        </CardContent>
      </Card>
    </main>
  )
}

type Dispatch = (action: Parameters<typeof reduce>[1]) => void

function Panel({
  session,
  handle,
  dispatch,
}: {
  session: Session
  handle: SessionHandle
  dispatch: Dispatch
}) {
  if (session.kind === 'unsupported') {
    return <UnsupportedNote />
  }
  if (session.kind === 'blocked') {
    return <BlockedActions dispatch={dispatch} />
  }
  if (session.kind === 'idle' || session.kind === 'requesting') {
    return <IdleActions session={session} dispatch={dispatch} />
  }
  return <ActivePanel session={session} handle={handle} dispatch={dispatch} />
}

function UnsupportedNote() {
  return (
    <p className="text-sm">This browser cannot open the microphone. Use Chrome or Edge on a Mac.</p>
  )
}

function BlockedActions({ dispatch }: { dispatch: Dispatch }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => dispatch({ type: 'start' })}>Try again</Button>
    </div>
  )
}

function IdleActions({
  session,
  dispatch,
}: {
  session: Session
  handle?: SessionHandle
  dispatch: Dispatch
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => dispatch({ type: 'start' })} disabled={session.kind === 'requesting'}>
        {session.kind === 'requesting' ? 'Waiting for permission…' : 'Start listening'}
      </Button>
    </div>
  )
}

function ActivePanel({
  session,
  handle,
  dispatch,
}: {
  session: Session & { kind: 'calibrating' | 'active' }
  handle: SessionHandle
  dispatch: Dispatch
}) {
  return (
    <>
      <StrengthControl session={session} dispatch={dispatch} />
      <LiveActions session={session} handle={handle} dispatch={dispatch} />
      {session.kind === 'calibrating' ? <CalibrationMeter progress={session.progress} /> : null}
      {session.kind === 'active' && session.guard ? <GuardNote dispatch={dispatch} /> : null}
    </>
  )
}

function StrengthControl({
  session,
  dispatch,
}: {
  session: Session & { kind: 'calibrating' | 'active' }
  dispatch: Dispatch
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span>Suppression</span>
        <span className="text-muted-foreground">{labelFor(session.strength)}</span>
      </div>
      <Slider
        max={1}
        min={0}
        step={0.01}
        value={[session.strength]}
        onValueChange={(value) => dispatch({ type: 'strength', value: value[0] ?? 0 })}
      />
    </div>
  )
}

function LiveActions({
  session,
  handle,
  dispatch,
}: {
  session: Session & { kind: 'calibrating' | 'active' }
  handle: SessionHandle
  dispatch: Dispatch
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant={session.kind === 'active' && session.bypass ? 'default' : 'outline'}
        onPointerDown={() => handle.holdBypass(true)}
        onPointerUp={() => handle.holdBypass(false)}
        onPointerCancel={() => handle.holdBypass(false)}
      >
        {session.kind === 'active' && session.bypass ? 'Bypass on' : 'Hold to hear raw'}
      </Button>
      <Button variant="outline" onClick={() => dispatch({ type: 'recalibrate' })}>
        Recalibrate
      </Button>
      <Button variant="outline" onClick={() => dispatch({ type: 'stop' })}>
        Stop
      </Button>
    </div>
  )
}

function CalibrationMeter({ progress }: { progress: number }) {
  return (
    <p className="text-sm text-muted-foreground">
      Learning the room… {Math.round(progress * 100)}%
    </p>
  )
}

function GuardNote({ dispatch }: { dispatch: Dispatch }) {
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      Playback jumped in level. The room may have changed.{' '}
      <button className="underline" type="button" onClick={() => dispatch({ type: 'dismiss-guard' })}>
        Dismiss
      </button>
    </p>
  )
}

function titleFor(session: Session) {
  switch (session.kind) {
    case 'unsupported':
      return 'Microphone unavailable'
    case 'idle':
      return 'Ready'
    case 'requesting':
      return 'Permission needed'
    case 'blocked':
      return 'Microphone blocked'
    case 'calibrating':
      return 'Learning the room'
    case 'active':
      return session.bypass ? 'Bypass' : 'Listening'
  }
}

function copyFor(session: Session) {
  switch (session.kind) {
    case 'unsupported':
      return 'getUserMedia is missing. This page cannot open an audio session.'
    case 'idle':
      return 'Start, then keep still for a second while Hush measures the steady noise.'
    case 'requesting':
      return 'The browser is asking for the microphone. Allow it to continue.'
    case 'blocked':
      return 'Permission was denied or the device is in use. Allow the microphone and try again.'
    case 'calibrating':
      return 'Hold still. Voices and sudden sounds during this moment become part of the noise floor.'
    case 'active':
      return session.bypass
        ? 'Raw microphone is playing. Release or tap again to return to suppressed playback.'
        : 'Steady noise is being pulled down. Transient sounds should still come through.'
  }
}

function labelFor(strength: number) {
  const index = Math.min(STRENGTH_LABELS.length - 1, Math.round(strength * (STRENGTH_LABELS.length - 1)))
  return STRENGTH_LABELS[index]
}
