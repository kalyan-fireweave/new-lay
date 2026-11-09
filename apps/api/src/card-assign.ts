import { fw } from "@fireweaveai/server-sdk/start";
import type { Telemetry } from "@keel/otel";

type Outcome = "assigned" | "rejected" | "failed";
type Poster = (body: string) => Promise<void>;

export async function cardAssignEnabled(userId: string): Promise<boolean> {
  // @fireweave-controlpoint card-assign
  return fw.controlPoints.getBooleanValue("card-assign", false, {
    targetingKey: userId,
  });
}

export async function recordAssign(telemetry: Telemetry, outcome: Outcome, status: number, runId?: string): Promise<void> {
  if (outcome === "assigned") await telemetry.record("keel.card.assigned", status, runId);
  else if (outcome === "rejected") await telemetry.record("keel.card.assign.rejected", status);
  else await telemetry.record("keel.card.assign.failed", status);
}

export function machineAssignBody(): string {
  const now = String(BigInt(Date.now()) * 1_000_000n);
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "keel-api" } },
            { key: "keel.signal", value: { stringValue: "infra" } },
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "keel.card.assign.machines",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      asInt: "1",
                      timeUnixNano: now,
                      attributes: [{ key: "keel.signal", value: { stringValue: "infra" } }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

const machines = {
  async record(name: "keel.card.assign.machines", body: string, post: Poster): Promise<void> {
    if (name !== "keel.card.assign.machines") return;
    await post(body);
  },
};

export async function postMachineAssign(body: string): Promise<void> {
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4418").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error("collector refused the machine assign");
}

export async function recordMachineAssign(post: Poster = postMachineAssign): Promise<void> {
  const body = machineAssignBody();
  await machines.record("keel.card.assign.machines", body, post);
}
