export type Session =
  | { kind: 'unsupported' }
  | { kind: 'idle'; strength: number }
  | { kind: 'requesting'; strength: number }
  | { kind: 'blocked'; strength: number }
  | { kind: 'calibrating'; strength: number; progress: number }
  | {
      kind: 'active'
      strength: number
      bypass: boolean
      guard: boolean
    }

export type Action =
  | { type: 'poll' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'recalibrate' }
  | { type: 'strength'; value: number }
  | { type: 'bypass'; held: boolean }
  | { type: 'dismiss-guard' }

export function reduce(session: Session, action: Action, handle: Handle): Session {
  dispatch(session, action, handle)
  return { ...session }
}

function dispatch(session: Session, action: Action, handle: Handle) {
  switch (action.type) {
    case 'start':
      void handle.start()
      return
    case 'stop':
      handle.stop()
      return
    case 'recalibrate':
      handle.recalibrate()
      return
    case 'strength':
      handle.setStrength(action.value)
      return
    case 'bypass':
      handle.holdBypass(action.held)
      return
    case 'dismiss-guard':
      handle.dismissGuard()
      return
    case 'poll':
      return
  }
}

type Handle = {
  start: () => Promise<void>
  stop: () => void
  recalibrate: () => void
  setStrength: (value: number) => void
  holdBypass: (held: boolean) => void
  dismissGuard: () => void
}
