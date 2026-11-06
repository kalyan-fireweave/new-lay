import { useSyncExternalStore } from "react";
import { api, type Team } from "./api.ts";

type Status = "idle" | "ready" | "closed";

type Snapshot = {
  status: Status;
  teams: Team[];
};

let snapshot: Snapshot = { status: "idle", teams: [] };
let request = 0;
const listeners = new Set<() => void>();

function emit(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshTeamDirectory(): void {
  const token = ++request;
  void api.teams().then((body) => {
    if (token !== request) return;
    emit({ status: "ready", teams: body.teams });
  }).catch(() => {
    if (token !== request) return;
    emit({ status: "closed", teams: [] });
  });
}

export function clearTeamDirectory(): void {
  request += 1;
  emit({ status: "idle", teams: [] });
}

export function useTeamDirectory(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
