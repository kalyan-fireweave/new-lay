import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type Pace = "demo" | "office" | "real-time" | "machine";

export type ApiStep = {
  method: string;
  path: string;
  body?: unknown;
  expect?: number;
  ifMatch?: string;
};

export type JourneyStep = {
  id: string;
  ui: unknown;
  api: ApiStep;
  thinkMs: { min: number; max: number };
};

export type Journey = {
  id: string;
  title: string;
  actor: string;
  actors: string[];
  metrics?: string[];
  steps: JourneyStep[];
};

export type JourneySummary = {
  id: string;
  title: string;
  actor: string;
  metrics: string[];
  steps: { id: string; method: string; path: string; thinkMs: { min: number; max: number } }[];
};

export type PlannedStep = {
  actor: string;
  step: string;
  thinkMs: number;
  ui: unknown;
  api: ApiStep;
};

const PROFILES: Record<Pace, { actors: number; scale: number; minutes: number }> = {
  demo: { actors: 1, scale: 10, minutes: 3 },
  office: { actors: 3, scale: 10, minutes: 15 },
  "real-time": { actors: 3, scale: 1, minutes: 30 },
  machine: { actors: 1, scale: 1, minutes: 10 },
};

export function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
  return dir;
}

export function profileFor(pace: Pace, target: string): { actors: number; scale: number; minutes: number } {
  const profile = PROFILES[pace];
  if (target === "production") return { ...profile, actors: 1, minutes: Math.min(profile.minutes, 10) };
  return profile;
}

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const char of seed) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function think(next: () => number, range: { min: number; max: number }): number {
  const span = Math.max(0, range.max - range.min);
  return range.min + Math.floor(next() * (span + 1));
}

function isWrite(step: JourneyStep): boolean {
  return step.api.method !== "GET";
}

export function loadJourney(id: string): Journey | null {
  const file = path.join(repoRoot(), "packages/journeys", `${id}.yaml`);
  if (!existsSync(file)) return null;
  const raw = parse(readFileSync(file, "utf8")) as Journey;
  if (!raw || raw.id !== id || !Array.isArray(raw.steps) || raw.steps.length === 0) return null;
  for (const step of raw.steps) {
    if (!step.id || !step.api?.method || !step.api.path || !step.ui || !step.thinkMs) return null;
  }
  return raw;
}

export function metricForStep(method: string, stepPath: string): string | null {
  if (method === "POST" && stepPath === "/cards") return "keel.card.created";
  if (method === "POST" && stepPath.endsWith("/comments")) return "keel.comment.created";
  if (method === "POST" && stepPath.endsWith("/stars")) return "keel.card.starred";
  if (method === "POST" && stepPath.endsWith("/duplicate")) return "keel.card.duplicated";
  if (method === "PATCH" && stepPath.startsWith("/cards/")) return "keel.card.moved";
  return null;
}

export function journeySummary(id: string): JourneySummary | null {
  const journey = loadJourney(id);
  if (!journey) return null;
  return {
    id: journey.id,
    title: journey.title,
    actor: journey.actor,
    metrics: (journey.metrics ?? []).filter((name) => typeof name === "string"),
    steps: journey.steps.map((step) => ({
      id: step.id,
      method: step.api.method,
      path: step.api.path,
      thinkMs: step.thinkMs,
    })),
  };
}

export type CatalogMetric = {
  name: string;
  kind: string;
  description: string;
};

export function catalogMetrics(): CatalogMetric[] {
  const file = path.join(repoRoot(), "packages/catalog/metrics.yaml");
  const raw = parse(readFileSync(file, "utf8")) as { metrics?: { name?: string; kind?: string; description?: string }[] };
  return (raw.metrics ?? []).flatMap((item) => {
    if (!item?.name) return [];
    return [{ name: item.name, kind: item.kind || "counter", description: item.description || "" }];
  });
}

export function journeyIds(): string[] {
  const dir = path.join(repoRoot(), "packages/journeys");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => name.slice(0, -5))
    .sort();
}

export function planSteps(journey: Journey, pace: Pace, seed: string): PlannedStep[] {
  const next = rng(`${seed}\0${pace}\0${journey.id}`);
  let steps = journey.steps.map((step) => ({ ...step }));
  if (pace !== "demo") {
    const bad = next();
    const abandon = next();
    if (bad < 0.02 && journey.id === "create-card") {
      steps = steps.map((step) => {
        if (step.api.method !== "POST" || step.api.path !== "/cards") return step;
        const body = { ...(step.api.body as Record<string, unknown>), title: "" };
        return { ...step, id: "empty-title", api: { ...step.api, body, expect: 400 } };
      });
    }
    if (abandon < 0.03) {
      let lastWrite = -1;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step && isWrite(step)) lastWrite = index;
      }
      if (lastWrite > 0) steps = steps.slice(0, lastWrite);
    }
  }
  return steps.map((step) => ({
    actor: journey.actor,
    step: step.id,
    thinkMs: think(next, step.thinkMs),
    ui: step.ui,
    api: step.api,
  }));
}
