import { useSyncExternalStore } from "react";
import { fw } from "@fireweaveai/web-sdk/start";

export function teamSharedMovesEnabled(): boolean {
  // @fireweave-controlpoint team-shared-moves
  return fw.controlPoints.getBooleanValue("team-shared-moves", false);
}

function subscribe(listener: () => void): () => void {
  return fw.subscribe(() => listener());
}

export function useTeamSharedMoves(): boolean {
  return useSyncExternalStore(subscribe, teamSharedMovesEnabled, teamSharedMovesEnabled);
}
