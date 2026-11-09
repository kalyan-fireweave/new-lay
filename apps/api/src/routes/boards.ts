import { getCookie } from "hono/cookie";
import { Hono } from "hono";
import type pg from "pg";
import { boardResponse } from "@keel/contracts/board";
import { createHash } from "node:crypto";
import { CARD_SELECT, mapCard, type CardRow } from "../card-row.ts";

const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const NOT_FOUND = { error: { code: "not_found", message: "Board not found." } };

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function boardRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.get("/boards/:id", async (c) => {
    const token = getCookie(c, "keel_session");
    if (!token) return c.json(UNAUTHENTICATED, 401);
    const session = await pool.query(
      `SELECT 1
       FROM sessions
       WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash(token)],
    );
    if (session.rowCount !== 1) return c.json(UNAUTHENTICATED, 401);

    const publicId = c.req.param("id");
    if (publicId !== "launch") return c.json(NOT_FOUND, 404);

    const board = await pool.query<{ name: string; revision: string }>(
      "SELECT name, revision::text AS revision FROM boards WHERE id = 'board_launch'",
    );
    const row = board.rows[0];
    if (!row) return c.json(NOT_FOUND, 404);

    const cards = await pool.query<CardRow>(
      `SELECT ${CARD_SELECT}
       FROM cards
       WHERE board_id = 'board_launch'
       ORDER BY CASE "column" WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END, position ASC`,
    );

    const body = boardResponse.parse({
      board: { id: "launch", name: row.name, revision: Number(row.revision) },
      columns: ["todo", "doing", "done"],
      cards: cards.rows.map((card) => mapCard(card)),
    });
    return c.json(body);
  });

  return app;
}
