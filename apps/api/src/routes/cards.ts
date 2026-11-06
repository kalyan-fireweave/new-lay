import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import type { Card } from "@keel/contracts/board";
import type { User } from "@keel/contracts/session";
import {
  cardDetailResponse,
  cardEnvelope,
  changesResponse,
  commentBody,
  commentResponse,
  createCardBody,
  patchCardBody,
  patchCardResponse,
  searchResponse,
} from "@keel/contracts/writes";
import { currentUser } from "../auth.ts";
import { sharesTeam, teamSharedMovesEnabled } from "../team-moves.ts";
import { CARD_SELECT, mapCard, mapComment, type CardRow, type CommentRow } from "../card-row.ts";
import { withTx } from "../db/tx.ts";
import { consumeFault } from "../fault.ts";
import { newId } from "../ids.ts";

const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const INVALID_BODY = { error: { code: "invalid_body", message: "The request is invalid." } };
const INVALID_TITLE = { error: { code: "invalid_title", message: "Title is required." } };
const INVALID_COMMENT = { error: { code: "invalid_comment", message: "Comment is required." } };
const NOT_FOUND = { error: { code: "not_found", message: "Not found." } };

type IdempotentRow = { request_hash: string; status: number; response_json: unknown };

function badOrigin(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  const allowed = [process.env.KEEL_WEB_ORIGIN, process.env.KEEL_STUDIO_ORIGIN];
  if (allowed.includes(origin)) return null;
  return c.json({ error: { code: "forbidden", message: "Origin is not allowed." } }, 403);
}

function hashBody(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canCreate(user: User): boolean {
  return user.role === "owner" || user.role === "member";
}

function canEdit(user: User, authorId: string): boolean {
  if (user.role === "owner") return true;
  if (user.role === "member") return user.id === authorId;
  return false;
}

async function readJson(c: Context): Promise<unknown | Response> {
  try {
    return await c.req.json();
  } catch {
    return c.json(INVALID_BODY, 400);
  }
}

async function lockBoard(client: pg.PoolClient): Promise<boolean> {
  const found = await client.query("SELECT id FROM boards WHERE id = 'board_launch' FOR UPDATE");
  return (found.rowCount ?? 0) === 1;
}

async function bumpRevision(client: pg.PoolClient): Promise<number> {
  const updated = await client.query<{ revision: string }>(
    "UPDATE boards SET revision = revision + 1 WHERE id = 'board_launch' RETURNING revision::text AS revision",
  );
  return Number(updated.rows[0].revision);
}

async function readCard(client: pg.Pool | pg.PoolClient, id: string): Promise<CardRow | null> {
  const found = await client.query<CardRow>(
    `SELECT ${CARD_SELECT} FROM cards WHERE id = $1 AND board_id = 'board_launch'`,
    [id],
  );
  return found.rows[0] ?? null;
}

async function savedIdempotency(
  client: pg.PoolClient,
  key: string,
  userId: string,
  requestHash: string,
): Promise<{ replay: IdempotentRow } | { conflict: true } | null> {
  const found = await client.query<IdempotentRow>(
    `SELECT request_hash, status, response_json
     FROM idempotency_keys
     WHERE key = $1 AND user_id = $2
     FOR UPDATE`,
    [key, userId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) return { conflict: true };
  const response = typeof row.response_json === "string" ? JSON.parse(row.response_json) : row.response_json;
  return { replay: { ...row, response_json: response } };
}

async function remember(
  client: pg.PoolClient,
  key: string,
  userId: string,
  requestHash: string,
  body: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (key, user_id, request_hash, status, response_json, created_at)
     VALUES ($1, $2, $3, 201, $4::jsonb, now())`,
    [key, userId, requestHash, JSON.stringify(body)],
  );
}

function titleError(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return "invalid";
  return null;
}

type Placed = { position: number; shiftedIds: { id: string; position: number }[] };

async function placeInColumn(client: pg.PoolClient, column: string, movingId: string | null): Promise<Placed> {
  const existing = await client.query<{ id: string; position: number }>(
    `SELECT id, position
     FROM cards
     WHERE board_id = 'board_launch' AND "column" = $1 AND id IS DISTINCT FROM $2
     ORDER BY position
     FOR UPDATE`,
    [column, movingId],
  );
  const packed = existing.rows.some((row, index) => index > 0 && row.position - existing.rows[index - 1].position <= 1);
  if (!packed) {
    const last = existing.rows.at(-1)?.position;
    return { position: last === undefined ? 1024 : last + 1024, shiftedIds: [] };
  }
  const shiftedIds: { id: string; position: number }[] = [];
  for (let i = 0; i < existing.rows.length; i++) {
    const position = (i + 1) * 1024;
    if (existing.rows[i].position !== position) shiftedIds.push({ id: existing.rows[i].id, position });
  }
  return { position: (existing.rows.length + 1) * 1024, shiftedIds };
}

export function cardRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.post("/cards", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const origin = badOrigin(c);
    if (origin) return origin;
    const key = c.req.header("idempotency-key")?.trim() ?? "";
    if (!key) return c.json(INVALID_BODY, 400);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = createCardBody.safeParse(body);
    if (!parsed.success) return c.json(INVALID_BODY, 400);
    const title = parsed.data.title.trim();
    if (title.length === 0 || title.length > 200) return c.json(INVALID_TITLE, 400);
    if (parsed.data.boardId !== "launch") return c.json(NOT_FOUND, 404);
    if (!canCreate(user)) {
      return c.json({ error: { code: "forbidden", message: "You cannot create a card." } }, 403);
    }
    const requestHash = hashBody({ boardId: "launch", title, column: parsed.data.column });

    const result = await withTx(pool, async (client) => {
      if (!(await lockBoard(client))) return { kind: "missing" as const };
      const prior = await savedIdempotency(client, key, user.id, requestHash);
      if (prior && "conflict" in prior) return { kind: "conflict" as const };
      if (prior && "replay" in prior) return { kind: "replay" as const, body: prior.replay.response_json };
      const version = await bumpRevision(client);
      const placed = await placeInColumn(client, parsed.data.column, null);
      const now = new Date();
      if (placed.shiftedIds.length > 0) {
        for (const shift of placed.shiftedIds) {
          await client.query("UPDATE cards SET position = $1, version = $2, updated_at = $3 WHERE id = $4", [
            shift.position,
            version,
            now,
            shift.id,
          ]);
        }
      }
      const inserted = await client.query<CardRow>(
        `INSERT INTO cards (id, board_id, title, "column", position, author_id, version, created_at, updated_at)
         VALUES ($1, 'board_launch', $2, $3, $4, $5, $6, $7, $7)
         RETURNING ${CARD_SELECT}`,
        [newId("card_"), title, parsed.data.column, placed.position, user.id, version, now],
      );
      const envelope = cardEnvelope.parse({ card: mapCard(inserted.rows[0]) });
      await remember(client, key, user.id, requestHash, envelope);
      return { kind: "created" as const, body: envelope };
    });

    if (result.kind === "missing") return c.json(NOT_FOUND, 404);
    if (result.kind === "conflict") {
      return c.json({ error: { code: "conflict", message: "This idempotency key was already used." } }, 409);
    }
    if (result.kind === "created" && consumeFault(c.req.header("x-keel-fault"))) throw new Error("keel fault");
    c.set("keelBusiness", "keel.card.created");
    if (result.kind === "replay") c.header("x-keel-idempotent", "replay");
    return c.json(result.body, 201);
  });

  app.patch("/cards/:id", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const origin = badOrigin(c);
    if (origin) return origin;
    const match = c.req.header("if-match")?.trim() ?? "";
    if (!/^\d+$/.test(match)) return c.json(INVALID_BODY, 400);
    const ifMatch = Number(match);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = patchCardBody.safeParse(body);
    if (!parsed.success) return c.json(INVALID_BODY, 400);
    let title: string | undefined;
    if (parsed.data.title !== undefined) {
      title = parsed.data.title.trim();
      if (titleError(title)) return c.json(INVALID_TITLE, 400);
    }
    const id = c.req.param("id");

    const result = await withTx(pool, async (client) => {
      if (!(await lockBoard(client))) return { kind: "missing" as const };
      const current = await client.query<CardRow>(
        `SELECT ${CARD_SELECT} FROM cards WHERE id = $1 AND board_id = 'board_launch' FOR UPDATE`,
        [id],
      );
      const row = current.rows[0];
      if (!row) return { kind: "missing" as const };
      const card = mapCard(row);
      if (card.version !== ifMatch) return { kind: "stale" as const, card };
      const column = parsed.data.column ?? card.column;
      const moved = column !== card.column;
      const nextTitle = title ?? card.title;
      const authored = canEdit(user, row.author_id);
      if ((nextTitle !== card.title || !moved) && !authored) return { kind: "forbidden" as const };
      if (!authored) {
        const shared =
          moved && (await teamSharedMovesEnabled(user.id)) && (await sharesTeam(client, user.id, row.author_id));
        if (!shared) return { kind: "forbidden" as const };
      }
      const placed = moved ? await placeInColumn(client, column, id) : { position: card.position, shiftedIds: [] };
      const version = await bumpRevision(client);
      const now = new Date();
      const shifted: Card[] = [];
      for (const shift of placed.shiftedIds) {
        const updated = await client.query<CardRow>(
          `UPDATE cards SET position = $1, version = $2, updated_at = $3 WHERE id = $4 RETURNING ${CARD_SELECT}`,
          [shift.position, version, now, shift.id],
        );
        shifted.push(mapCard(updated.rows[0]));
      }
      const saved = await client.query<CardRow>(
        `UPDATE cards
         SET title = $2, "column" = $3, position = $4, version = $5, updated_at = $6
         WHERE id = $1
         RETURNING ${CARD_SELECT}`,
        [id, title ?? card.title, column, placed.position, version, now],
      );
      return { kind: "ok" as const, moved, body: patchCardResponse.parse({ card: mapCard(saved.rows[0]), shifted }) };
    });

    if (result.kind === "missing") return c.json(NOT_FOUND, 404);
    if (result.kind === "forbidden") {
      return c.json({ error: { code: "forbidden", message: "You cannot change this card." } }, 403);
    }
    if (result.kind === "stale") {
      return c.json({ error: { code: "conflict", message: "The card changed.", card: result.card } }, 409);
    }
    if (result.moved) c.set("keelBusiness", "keel.card.moved");
    return c.json(result.body);
  });

  app.post("/cards/:id/comments", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const origin = badOrigin(c);
    if (origin) return origin;
    const key = c.req.header("idempotency-key")?.trim() ?? "";
    if (!key) return c.json(INVALID_BODY, 400);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = commentBody.safeParse(body);
    if (!parsed.success) return c.json(INVALID_BODY, 400);
    const text = parsed.data.body.trim();
    if (text.length === 0 || text.length > 2000) return c.json(INVALID_COMMENT, 400);
    if (!canCreate(user)) {
      return c.json({ error: { code: "forbidden", message: "You cannot comment on this card." } }, 403);
    }
    const id = c.req.param("id");
    const requestHash = hashBody({ cardId: id, body: text });

    const result = await withTx(pool, async (client) => {
      if (!(await lockBoard(client))) return { kind: "missing" as const };
      const prior = await savedIdempotency(client, key, user.id, requestHash);
      if (prior && "conflict" in prior) return { kind: "conflict" as const };
      if (prior && "replay" in prior) return { kind: "replay" as const, body: prior.replay.response_json };
      const locked = await client.query<CardRow>(
        `SELECT ${CARD_SELECT} FROM cards WHERE id = $1 AND board_id = 'board_launch' FOR UPDATE`,
        [id],
      );
      if (!locked.rows[0]) return { kind: "missing" as const };
      const version = await bumpRevision(client);
      const now = new Date();
      const commentId = newId("cmt_");
      await client.query(
        `INSERT INTO comments (id, card_id, body, author_id, created_at, version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [commentId, id, text, user.id, now, version],
      );
      const saved = await client.query<CardRow>(
        `UPDATE cards SET version = $2, updated_at = $3 WHERE id = $1 RETURNING ${CARD_SELECT}`,
        [id, version, now],
      );
      const envelope = commentResponse.parse({
        comment: { id: commentId, cardId: id, body: text, authorId: user.id, createdAt: now.toISOString() },
        card: mapCard(saved.rows[0]),
      });
      await remember(client, key, user.id, requestHash, envelope);
      return { kind: "created" as const, body: envelope };
    });

    if (result.kind === "missing") return c.json(NOT_FOUND, 404);
    if (result.kind === "conflict") {
      return c.json({ error: { code: "conflict", message: "This idempotency key was already used." } }, 409);
    }
    c.set("keelBusiness", "keel.comment.created");
    if (result.kind === "replay") c.header("x-keel-idempotent", "replay");
    return c.json(result.body, 201);
  });

  app.get("/cards/:id", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const row = await readCard(pool, c.req.param("id"));
    if (!row) return c.json(NOT_FOUND, 404);
    const comments = await pool.query<CommentRow>(
      `SELECT id, card_id, body, author_id, created_at
       FROM comments
       WHERE card_id = $1
       ORDER BY created_at ASC, id ASC`,
      [row.id],
    );
    return c.json(cardDetailResponse.parse({ card: mapCard(row), comments: comments.rows.map(mapComment) }));
  });

  app.get("/search", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const query = c.req.query("q")?.trim() ?? "";
    if (query.length < 1 || query.length > 80) return c.json(INVALID_BODY, 400);
    const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const found = await pool.query<CardRow>(
      `SELECT ${CARD_SELECT}
       FROM cards
       WHERE board_id = 'board_launch' AND title ILIKE $1 ESCAPE '\\'
       ORDER BY updated_at DESC, id ASC
       LIMIT 20`,
      [pattern],
    );
    return c.json(searchResponse.parse({ query, cards: found.rows.map(mapCard) }));
  });

  app.get("/boards/:id/changes", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    if (c.req.param("id") !== "launch") return c.json(NOT_FOUND, 404);
    const raw = c.req.query("since");
    if (raw === undefined || !/^\d+$/.test(raw)) return c.json(INVALID_BODY, 400);
    const since = Number(raw);
    const board = await pool.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM boards WHERE id = 'board_launch'",
    );
    const revision = Number(board.rows[0]?.revision ?? 0);
    if (!board.rows[0] || since > revision) return c.json(INVALID_BODY, 400);
    if (since === revision) {
      return c.json(changesResponse.parse({ revision, cards: [], comments: [], removedCardIds: [] }));
    }
    const cards = await pool.query<CardRow>(
      `SELECT ${CARD_SELECT} FROM cards WHERE board_id = 'board_launch' AND version > $1 ORDER BY version ASC, id ASC`,
      [since],
    );
    const comments = await pool.query<CommentRow>(
      `SELECT c.id, c.card_id, c.body, c.author_id, c.created_at
       FROM comments c
       JOIN cards k ON k.id = c.card_id
       WHERE k.board_id = 'board_launch' AND c.version > $1
       ORDER BY c.created_at ASC, c.id ASC`,
      [since],
    );
    return c.json(
      changesResponse.parse({
        revision,
        cards: cards.rows.map(mapCard),
        comments: comments.rows.map(mapComment),
        removedCardIds: [],
      }),
    );
  });

  app.post("/cards/:id/stars", async (c) => {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    const origin = badOrigin(c);
    if (origin) return origin;
    const key = c.req.header("idempotency-key")?.trim() ?? "";
    if (!key) return c.json(INVALID_BODY, 400);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
      return c.json(INVALID_BODY, 400);
    }
    const cardId = c.req.param("id");
    const requestHash = hashBody({ cardId });
    const result = await withTx(pool, async (client) => {
      if (!(await lockBoard(client))) return { kind: "missing" as const };
      const prior = await savedIdempotency(client, key, user.id, requestHash);
      if (prior && "conflict" in prior) return { kind: "conflict" as const };
      if (prior && "replay" in prior) return { kind: "replay" as const, body: prior.replay.response_json };
      const card = await readCard(client, cardId);
      if (!card) return { kind: "missing" as const };
      const inserted = await client.query(
        `INSERT INTO card_stars (card_id, user_id, created_at)
         VALUES ($1, $2, now())
         ON CONFLICT (card_id, user_id) DO NOTHING
         RETURNING card_id`,
        [cardId, user.id],
      );
      const envelope = { starred: true };
      await remember(client, key, user.id, requestHash, envelope);
      return { kind: (inserted.rowCount ?? 0) > 0 ? ("created" as const) : ("kept" as const), body: envelope };
    });
    if (result.kind === "missing") return c.json(NOT_FOUND, 404);
    if (result.kind === "conflict") {
      return c.json({ error: { code: "conflict", message: "This idempotency key was already used." } }, 409);
    }
    if (result.kind === "created") c.set("keelBusiness", "keel.card.starred");
    if (result.kind === "replay") c.header("x-keel-idempotent", "replay");
    return c.json(result.body, 201);
  });

  return app;
}
