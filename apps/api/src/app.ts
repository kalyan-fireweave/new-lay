import "./fireweave/start.ts"; // FireWeave: must stay the first import
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { startTelemetry, type Telemetry } from "@keel/otel";
import { databaseUrl, loadEnv } from "./db/env.ts";
import { migrate } from "./db/migrate.ts";
import { seed } from "./db/seed.ts";
import { observe } from "./observe.ts";
import { boardRoutes } from "./routes/boards.ts";
import { cardRoutes } from "./routes/cards.ts";
import { healthRoutes } from "./routes/health.ts";
import { otelRoutes } from "./routes/otel.ts";
import { sessionRoutes } from "./routes/session.ts";
import { teamRoutes } from "./routes/teams.ts";

export function createApp(pool: pg.Pool, telemetry: Telemetry = startTelemetry()): Hono {
  const app = new Hono();
  app.use("*", observe(telemetry));
  app.route("/", healthRoutes(pool));
  app.route("/", otelRoutes());
  app.route("/", sessionRoutes(pool));
  app.route("/", boardRoutes(pool));
  app.route("/", cardRoutes(pool, telemetry));
  app.route("/", teamRoutes(pool));
  app.onError((error, c) => {
    console.error(error instanceof Error ? error.message : error);
    return c.json({ error: { code: "internal", message: "The request failed." } }, 500);
  });
  return app;
}

async function listen(): Promise<void> {
  loadEnv();
  const origin = process.env.KEEL_API_ORIGIN ?? "http://127.0.0.1:4101";
  const url = new URL(origin);
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  const client = await pool.connect();
  try {
    await migrate(client);
    if (process.env.KEEL_SEED === "1") {
      const password = process.env.KEEL_SEED_PASSWORD ?? "";
      if (!password) throw new Error("KEEL_SEED_PASSWORD is empty.");
      await seed(client, password);
    }
  } finally {
    client.release();
  }
  const app = createApp(pool);
  const port = Number(process.env.KEEL_LISTEN_PORT || url.port || 80);
  const hostname = process.env.KEEL_BIND || url.hostname;
  serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`api ${origin}`);
  });
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry.endsWith(`${path.sep}app.ts`) || entry.endsWith(`${path.sep}server.js`)) {
  listen().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
