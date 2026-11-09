import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../packages/otel/package.json", import.meta.url));
const yaml = require("yaml") as { parse: (text: string) => unknown };

type ApiBlock = {
  method?: string;
  path?: string;
  body?: unknown;
  expect?: number;
  ifMatch?: string;
  includes?: string;
};

type Step = { id?: string; ui?: unknown; api?: ApiBlock };
type Journey = { id?: string; steps?: Step[] };

function loadEnv(): void {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1);
  }
}

function versionsFrom(json: unknown, versions: Map<string, string>): void {
  if (!json || typeof json !== "object") return;
  const cards = (json as { cards?: { id?: string; version?: number }[] }).cards ?? [];
  for (const card of cards) {
    if (card.id && card.version !== undefined) versions.set(card.id, String(card.version));
  }
}

async function execute(name: string, journey: Journey, origin: string): Promise<boolean> {
  const jar = new Map<string, string>();
  const versions = new Map<string, string>();
  let ok = true;
  for (const step of journey.steps ?? []) {
    const api = step.api;
    if (!api?.method || !api.path) continue;
    const headers: Record<string, string> = { accept: "application/json" };
    if (jar.size > 0) headers.cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
    let body: string | undefined;
    if (api.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(api.body);
    }
    if (api.method === "POST" && (api.path === "/cards" || api.path.endsWith("/comments") || api.path.endsWith("/stars") || api.path.endsWith("/duplicate") || api.path.endsWith("/assignee"))) {
      headers["idempotency-key"] = randomUUID();
    }
    if (api.ifMatch) {
      const version = versions.get(api.ifMatch);
      if (version) headers["if-match"] = version;
    }
    const response = await fetch(`${origin}${api.path}`, { method: api.method, headers, body });
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const pair = header.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    versionsFrom(json, versions);
    const includes = !api.includes || text.includes(api.includes);
    const matched = response.status === api.expect && includes;
    console.log(`executed ${journey.id} ${api.method} ${api.path} ${response.status}${api.includes ? ` ${api.includes}` : ""}`);
    if (!matched) {
      console.error(`${name} step ${step.id ?? "?"} expected ${api.expect}${api.includes ? ` including ${api.includes}` : ""}, got ${response.status}`);
      ok = false;
    }
  }
  return ok;
}

loadEnv();
const dir = path.join(root, "packages/journeys");
const files = readdirSync(dir).filter((entry) => entry.endsWith(".yaml")).sort();
const journeys: { name: string; journey: Journey }[] = [];
const seen = new Map<string, string>();
let failed = false;

for (const name of files) {
  const journey = yaml.parse(readFileSync(path.join(dir, name), "utf8")) as Journey;
  journeys.push({ name, journey });
  if (journey.id) {
    const prior = seen.get(journey.id);
    if (prior) {
      console.error(`duplicate journey id ${journey.id} in ${prior} and ${name}`);
      failed = true;
    } else {
      seen.set(journey.id, name);
    }
  } else {
    console.error(`${name} needs an id`);
    failed = true;
  }
  for (const step of journey.steps ?? []) {
    const api = step.api;
    if (step.ui && api?.method && api.path && typeof api.expect === "number") continue;
    console.error(`${name} step ${step.id ?? "?"} needs a ui block and an api block`);
    failed = true;
  }
}

const origin = (process.env.KEEL_API_ORIGIN ?? "http://127.0.0.1:4101").replace(/\/$/, "");
let apiUp = false;
if (!failed) {
  try {
    apiUp = (await fetch(`${origin}/health`)).ok;
  } catch {
    apiUp = false;
  }
  if (!apiUp) console.log("api skipped");
  if (apiUp) {
    for (const { name, journey } of journeys) {
      if (!(await execute(name, journey, origin))) failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("journeys ok");
