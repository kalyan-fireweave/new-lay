import { fw } from "@fireweaveai/server-sdk/start";
import type { Telemetry } from "@keel/otel";

type Outcome = "recorded" | "rejected" | "failed";
type Poster = (body: string) => Promise<void>;

export async function boardPulseEnabled(userId: string): Promise<boolean> {
  // @fireweave-controlpoint board-pulse
  return fw.controlPoints.getBooleanValue("board-pulse", false, {
    targetingKey: userId,
  });
}

export async function recordPulse(telemetry: Telemetry, outcome: Outcome, status: number, runId?: string): Promise<void> {
  if (outcome === "recorded") await telemetry.record("keel.pulse.recorded", status, runId);
  else if (outcome === "rejected") await telemetry.record("keel.pulse.rejected", status);
  else await telemetry.record("keel.pulse.failed", status);
}

export function machinePulseBody(): string {
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
                name: "keel.pulse.machines",
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
  async record(name: "keel.pulse.machines", body: string, post: Poster): Promise<void> {
    if (name !== "keel.pulse.machines") return;
    await post(body);
  },
};

export async function postMachinePulse(body: string): Promise<void> {
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4418").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error("collector refused the machine pulse");
}

export async function recordMachinePulse(post: Poster = postMachinePulse): Promise<void> {
  const body = machinePulseBody();
  await machines.record("keel.pulse.machines", body, post);
}
