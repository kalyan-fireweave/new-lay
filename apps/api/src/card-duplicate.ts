import { fw } from "@fireweaveai/server-sdk/start";
import type { Telemetry } from "@keel/otel";

export async function cardDuplicateEnabled(userId: string): Promise<boolean> {
  // @fireweave-controlpoint card-duplicate
  return fw.controlPoints.getBooleanValue("card-duplicate", false, { targetingKey: userId });
}

export async function recordDuplicate(
  telemetry: Telemetry,
  outcome: "duplicated" | "rejected" | "failed",
  status: number,
): Promise<void> {
  if (outcome === "duplicated") await telemetry.record("keel.card.duplicated", status);
  else if (outcome === "rejected") await telemetry.record("keel.card.duplicate.rejected", status);
  else await telemetry.record("keel.card.duplicate.failed", status);
}
