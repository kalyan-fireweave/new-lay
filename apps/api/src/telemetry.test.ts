import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { memoryTelemetry, type MemoryExporters } from "@keel/otel";
import { createApp } from "./app.ts";
import { loadEnv } from "./db/env.ts";
import { resetFaults } from "./fault.ts";
import type { Hono } from "hono";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadFileEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) throw new Error("missing .env");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1);
  }
  loadEnv();
}

function runSeed() {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], { cwd: root, env: process.env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "seed failed");
}

async function resetBoard(db: pg.Client) {
  await db.query("DELETE FROM comments");
  await db.query("DELETE FROM card_stars");
  await db.query("DELETE FROM idempotency_keys");
  await db.query("DELETE FROM cards");
  await db.query("UPDATE boards SET revision = 1 WHERE id = 'board_launch'");
  runSeed();
}

function points(memory: MemoryExporters, name: string) {
  const found: { attributes: Record<string, unknown>; value: number }[] = [];
  for (const resource of memory.metrics.getMetrics()) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        if (metric.descriptor.name !== name) continue;
        for (const point of metric.dataPoints) {
          const value = point.value;
          const count = typeof value === "number" ? value : value && typeof value === "object" && "count" in value ? Number(value.count) : 0;
          found.push({ attributes: point.attributes as Record<string, unknown>, value: count });
        }
      }
    }
  }
  return found;
}

loadFileEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await db.connect();
  await resetBoard(db);
});

afterAll(async () => {
  await resetBoard(db);
  await db.end();
  await pool.end();
});

beforeEach(() => {
  resetFaults();
});

async function signIn(app: Hono, email: string): Promise<string> {
  const response = await app.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "keel-local-only" }),
  });
  if (response.status !== 201) throw new Error(`sign in ${response.status}`);
  const header = response.headers.get("set-cookie") ?? "";
  const token = header.split(";")[0]?.split("=")[1] ?? "";
  if (!token) throw new Error("no session cookie");
  return token;
}

function open(): { app: Hono; memory: MemoryExporters } {
  const memory = memoryTelemetry();
  return { app: createApp(pool, memory.telemetry), memory };
}

it("records the route template, the histogram, the request counter, and the create counter", async () => {
  const { app, memory } = open();
  const token = await signIn(app, "grace@keel.test");
  const response = await app.request("/cards", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${token}`,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ boardId: "launch", title: "Phase five", column: "todo" }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { card: { id: string } };
  const span = memory.spans.getFinishedSpans().find((item) => item.attributes["http.route"] === "/cards");
  expect(span?.name).toBe("/cards");
  expect(span?.attributes["http.route"]).toBe("/cards");
  expect(String(span?.attributes["http.route"])).not.toBe(body.card.id);
  expect(String(span?.name)).not.toContain(body.card.id);
  expect(points(memory, "http.server.request.duration").some((point) => point.attributes["http.route"] === "/cards" && point.value >= 1)).toBe(true);
  expect(points(memory, "http.server.requests").some((point) => point.attributes["http.route"] === "/cards" && point.value >= 1)).toBe(true);
  expect(points(memory, "keel.card.created").some((point) => point.value >= 1)).toBe(true);
});

it("counts a viewer move as 403 and does not count a move", async () => {
  const { app, memory } = open();
  const token = await signIn(app, "linus@keel.test");
  const board = await app.request("/boards/launch", { headers: { cookie: `keel_session=${token}` } });
  const snapshot = (await board.json()) as { cards: { id: string; version: number; column: string }[] };
  const card = snapshot.cards.find((item) => item.id === "card_01");
  if (!card) throw new Error("missing card_01");
  const response = await app.request("/cards/card_01", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${token}`,
      "if-match": String(card.version),
    },
    body: JSON.stringify({ column: card.column === "todo" ? "doing" : "todo" }),
  });
  expect(response.status).toBe(403);
  expect(points(memory, "http.server.requests").some((point) => point.attributes["http.route"] === "/cards/:id" && point.attributes["http.response.status_code"] === 403)).toBe(true);
  expect(points(memory, "keel.card.moved").reduce((sum, point) => sum + point.value, 0)).toBe(0);
});

it("leaves the cookie out of the log record", async () => {
  const { app, memory } = open();
  const token = await signIn(app, "grace@keel.test");
  const response = await app.request("/cards", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${token}`,
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify({ boardId: "launch", title: "No cookie in the log", column: "todo" }),
  });
  expect(response.status).toBe(201);
  const record = memory.logs.getFinishedLogRecords().find((item) => String(item.body).startsWith("POST /cards"));
  expect(record).toBeTruthy();
  expect(record?.attributes).not.toHaveProperty("cookie");
  expect(record?.attributes).not.toHaveProperty("authorization");
  expect(JSON.stringify(record)).not.toContain(token);
});

it("throws once after the card is saved and then accepts the header", async () => {
  const { app } = open();
  const token = await signIn(app, "grace@keel.test");
  const headers = {
    "content-type": "application/json",
    cookie: `keel_session=${token}`,
    "x-keel-fault": "once",
  };
  const first = await app.request("/cards", {
    method: "POST",
    headers: { ...headers, "idempotency-key": randomUUID() },
    body: JSON.stringify({ boardId: "launch", title: "Fault once", column: "todo" }),
  });
  expect(first.status).toBe(500);
  const board = await app.request("/boards/launch", { headers: { cookie: `keel_session=${token}` } });
  const snapshot = (await board.json()) as { cards: { title: string }[] };
  expect(snapshot.cards.some((card) => card.title === "Fault once")).toBe(true);
  const second = await app.request("/cards", {
    method: "POST",
    headers: { ...headers, "idempotency-key": randomUUID() },
    body: JSON.stringify({ boardId: "launch", title: "Fault twice", column: "todo" }),
  });
  expect(second.status).toBe(201);
});

function resourceSignal(memory: MemoryExporters, name: string): string | undefined {
  for (const resource of memory.metrics.getMetrics()) {
    const carries = resource.scopeMetrics.some((scope) => scope.metrics.some((metric) => metric.descriptor.name === name));
    if (!carries) continue;
    const attributes = resource.resource.attributes;
    const signal = attributes["keel.signal"];
    return typeof signal === "string" ? signal : undefined;
  }
  return undefined;
}

it("counts a copy on the application signal and leaves a refused copy off that counter", async () => {
  const { app, memory } = open();
  const grace = await signIn(app, "grace@keel.test");
  const copied = await app.request("/cards/card_02/duplicate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${grace}`,
      "idempotency-key": randomUUID(),
    },
    body: "{}",
  });
  expect(copied.status).toBe(201);
  const body = (await copied.json()) as { card: { title: string } };
  expect(body.card.title).toBe("Copy of Pin the ports");
  expect(Math.max(...points(memory, "keel.card.duplicated").map((point) => point.value))).toBe(1);
  expect(resourceSignal(memory, "keel.card.duplicated")).toBe("app");
  expect(points(memory, "http.server.request.duration").some((point) => point.attributes["http.route"] === "/cards/:id/duplicate")).toBe(true);

  const linus = await signIn(app, "linus@keel.test");
  const refused = await app.request("/cards/card_01/duplicate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${linus}`,
      "idempotency-key": randomUUID(),
    },
    body: "{}",
  });
  expect(refused.status).toBe(403);
  expect(points(memory, "keel.card.duplicate.rejected").some((point) => point.attributes["http.response.status_code"] === 403 && point.value >= 1)).toBe(true);
  expect(resourceSignal(memory, "keel.card.duplicate.rejected")).toBe("app");
  expect(Math.max(...points(memory, "keel.card.duplicated").map((point) => point.value))).toBe(1);
  expect(points(memory, "keel.card.duplicate.failed").reduce((sum, point) => sum + point.value, 0)).toBe(0);
});

it("counts a duplicate that throws as a failure and not as a copy", async () => {
  const { app, memory } = open();
  const token = await signIn(app, "grace@keel.test");
  const response = await app.request("/cards/card_02/duplicate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `keel_session=${token}`,
      "idempotency-key": randomUUID(),
      "x-keel-fault": "once",
    },
    body: "{}",
  });
  expect(response.status).toBe(500);
  expect(Math.max(0, ...points(memory, "keel.card.duplicate.failed").map((point) => point.value))).toBe(1);
  expect(points(memory, "keel.card.duplicated").reduce((sum, point) => sum + point.value, 0)).toBe(0);
  expect(points(memory, "http.server.requests").some((point) => point.attributes["http.route"] === "/cards/:id/duplicate" && point.attributes["http.response.status_code"] === 500)).toBe(true);
  expect(resourceSignal(memory, "keel.card.duplicate.failed")).toBe("app");
});
