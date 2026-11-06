import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import type { Telemetry } from "@keel/otel";
import { currentUser } from "../auth.ts";
import { boardPulseEnabled, recordMachinePulse, recordPulse } from "../pulse.ts";

const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const FORBIDDEN = { error: { code: "forbidden", message: "You cannot record a pulse." } };
const NOT_FOUND = { error: { code: "not_found", message: "Not found." } };
const FAILED = { error: { code: "internal", message: "The pulse failed." } };

function badOrigin(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  const allowed = [process.env.KEEL_WEB_ORIGIN, process.env.KEEL_STUDIO_ORIGIN];
  if (allowed.includes(origin)) return null;
  return c.json({ error: { code: "forbidden", message: "Origin is not allowed." } }, 403);
}

export function pulseRoutes(pool: pg.Pool, telemetry: Telemetry): Hono {
  const app = new Hono();
  app.post("/pulse", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const origin = badOrigin(c);
    if (origin) return origin;
    if (!(await boardPulseEnabled(user.id))) return c.json(NOT_FOUND, 404);
    if (user.role === "viewer") {
      await recordPulse(telemetry, "rejected", 403);
      return c.json(FORBIDDEN, 403);
    }
    const runId = c.req.header("x-keel-run-id")?.trim();
    try {
      await recordMachinePulse();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      await recordPulse(telemetry, "failed", 502);
      return c.json(FAILED, 502);
    }
    await recordPulse(telemetry, "recorded", 201, runId || undefined);
    return c.json({ recorded: true }, 201);
  });
  return app;
}
