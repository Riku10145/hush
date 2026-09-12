import { useSyncExternalStore } from "react";
import { createHushSession, type HushActions } from "../session/hush";
import { IDLE, type Session } from "../session/state";

let session: Session = IDLE;
const listeners = new Set<() => void>();
const hush = createHushSession((next) => {
  session = next;
  listeners.forEach((listener) => listener());
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Session {
  return session;
}

export function useHushSession(): { session: Session; actions: HushActions } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { session: current, actions: hush };
}
