import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const pg = require("pg");

function loadEnv() {
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
}

loadEnv();
const apiOrigin = process.env.KEEL_API_ORIGIN ?? "http://127.0.0.1:4101";

function runSeed() {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "seed failed");
}

async function resetBoard() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const teams = await db.query("SELECT to_regclass('public.teams') AS name");
    if (teams.rows[0]?.name) {
      await db.query("DELETE FROM team_members");
      await db.query("DELETE FROM teams");
    }
    await db.query("DELETE FROM comments");
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM cards");
    await db.query("UPDATE boards SET revision = 1 WHERE id = 'board_launch'");
    runSeed();
  } finally {
    await db.end();
  }
}

type Hit = { method: string; path: string; search: string };

function watch(page: Page): Hit[] {
  const hits: Hit[] = [];
  page.on("request", (request) => {
    if (request.resourceType() !== "fetch" && request.resourceType() !== "xhr") return;
    const url = new URL(request.url());
    if (url.origin !== new URL(process.env.KEEL_WEB_ORIGIN ?? "http://127.0.0.1:4100").origin) return;
    hits.push({ method: request.method(), path: url.pathname, search: url.search });
  });
  return hits;
}

async function navigationCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("navigation").length);
}

test.beforeAll(resetBoard);
test.afterAll(resetBoard);

test("the board stays on one document and loads only what changed", async ({ page }) => {
  const hits = watch(page);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("grace@keel.test");
  await page.getByLabel("Password").fill("keel-local-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Launch" })).toBeVisible();
  expect(await navigationCount(page)).toBe(1);

  const boardGets = () => hits.filter((hit) => hit.method === "GET" && hit.path === "/boards/launch");
  expect(boardGets()).toHaveLength(1);

  await page.getByLabel("New card").fill("Check the collector");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("button", { name: "Check the collector" })).toBeVisible();
  expect(hits.filter((hit) => hit.method === "POST" && hit.path === "/cards")).toHaveLength(1);
  expect(boardGets()).toHaveLength(1);

  await page.getByRole("button", { name: "Check the collector" }).click();
  await expect(page).toHaveURL(/\/cards\//);
  const cardId = new URL(page.url()).pathname.split("/").pop() ?? "";
  const cardGets = () => hits.filter((hit) => hit.method === "GET" && hit.path === `/cards/${cardId}`);
  expect(cardGets()).toHaveLength(1);

  await page.getByRole("link", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/boards\/launch$/);
  await page.getByRole("button", { name: "Check the collector" }).click();
  await expect(page).toHaveURL(new RegExp(`/cards/${cardId}$`));
  expect(cardGets()).toHaveLength(1);

  await page.getByRole("link", { name: "Close" }).click();
  await page.getByRole("button", { name: "Check the collector" }).dragTo(page.getByRole("region", { name: "Done" }));
  expect(hits.filter((hit) => hit.method === "PATCH" && hit.path === `/cards/${cardId}`)).toHaveLength(1);
  expect(boardGets()).toHaveLength(1);

  await page.getByLabel("Search").fill("collector");
  await expect.poll(() => hits.some((hit) => hit.method === "GET" && hit.path === "/search" && hit.search.includes("collector"))).toBe(true);
  expect(boardGets()).toHaveLength(1);

  const column = await adaMovesCard02();
  const label = column === "todo" ? "Todo" : column === "doing" ? "Doing" : "Done";
  await expect(page.getByRole("region", { name: label }).getByRole("button", { name: "Pin the ports" })).toBeVisible({ timeout: 16_000 });
  expect(hits.some((hit) => hit.path.includes("/changes"))).toBe(true);
  expect(boardGets()).toHaveLength(1);
  expect(await navigationCount(page)).toBe(1);
});

async function adaMovesCard02(): Promise<"todo" | "doing" | "done"> {
  const sign = await fetch(`${apiOrigin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: "ada@keel.test", password: "keel-local-only" }),
  });
  const cookie = sign.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("Ada did not get a session");
  const detail = await fetch(`${apiOrigin}/cards/card_02`, { headers: { cookie, accept: "application/json" } });
  const body = (await detail.json()) as { card: { column: "todo" | "doing" | "done"; version: number } };
  const column = body.card.column === "done" ? "todo" : "done";
  const patched = await fetch(`${apiOrigin}/cards/card_02`, {
    method: "PATCH",
    headers: {
      cookie,
      accept: "application/json",
      "content-type": "application/json",
      "if-match": String(body.card.version),
    },
    body: JSON.stringify({ column }),
  });
  if (!patched.ok) throw new Error(await patched.text());
  return column;
}
