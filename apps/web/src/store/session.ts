import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api.ts";
import { forgetPerson, rememberPerson } from "../fireweave/identity.ts";

export type User = { id: string; email: string; name: string; role: "owner" | "member" | "viewer" };

export type Session =
  | { status: "unknown" }
  | { status: "anonymous" }
  | { status: "user"; user: User };

let session: Session = { status: "unknown" };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  try {
    const body = await api.session();
    session = { status: "user", user: body.user };
    rememberPerson(body.user.id, body.user.role);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) session = { status: "anonymous" };
    else throw error;
  }
  emit();
}

export const sessionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get(): Session {
    return session;
  },
  async bootstrap(): Promise<void> {
    if (session.status !== "unknown") return;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    await inflight;
  },
  setUser(user: User): void {
    session = { status: "user", user };
    rememberPerson(user.id, user.role);
    emit();
  },
  clear(): void {
    session = { status: "anonymous" };
    forgetPerson();
    emit();
  },
};

export function useSession(): Session {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
}
