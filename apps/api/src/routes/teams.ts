import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";
import {
  addMembersBody,
  createTeamBody,
  teamResponse,
  teamSchema,
  teamsResponse,
  usersResponse,
  type Team,
} from "@keel/contracts/teams";
import type { User } from "@keel/contracts/session";
import { currentUser } from "../auth.ts";
import { newId } from "../ids.ts";
import { teamSharedMovesEnabled } from "../team-moves.ts";

const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const INVALID_BODY = { error: { code: "invalid_body", message: "The request is invalid." } };
const NOT_FOUND = { error: { code: "not_found", message: "Not found." } };
const FORBIDDEN = { error: { code: "forbidden", message: "You cannot change teams." } };

type TeamRow = { id: string; name: string; member_ids: string[] | null };

function badOrigin(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  const allowed = [process.env.KEEL_WEB_ORIGIN, process.env.KEEL_STUDIO_ORIGIN];
  if (allowed.includes(origin)) return null;
  return c.json({ error: { code: "forbidden", message: "Origin is not allowed." } }, 403);
}

function mapTeam(row: TeamRow): Team {
  return teamSchema.parse({
    id: row.id,
    name: row.name,
    memberIds: row.member_ids ?? [],
  });
}

async function readJson(c: Context): Promise<unknown | Response> {
  try {
    return await c.req.json();
  } catch {
    return c.json(INVALID_BODY, 400);
  }
}

async function listTeams(pool: pg.Pool): Promise<Team[]> {
  const found = await pool.query<TeamRow>(
    `SELECT t.id, t.name,
            COALESCE(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
     FROM teams t
     LEFT JOIN team_members m ON m.team_id = t.id
     GROUP BY t.id, t.name
     ORDER BY t.name, t.id`,
  );
  return found.rows.map(mapTeam);
}

async function oneTeam(pool: pg.Pool, id: string): Promise<Team | null> {
  const found = await pool.query<TeamRow>(
    `SELECT t.id, t.name,
            COALESCE(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS member_ids
     FROM teams t
     LEFT JOIN team_members m ON m.team_id = t.id
     WHERE t.id = $1
     GROUP BY t.id, t.name`,
    [id],
  );
  const row = found.rows[0];
  return row ? mapTeam(row) : null;
}

export function teamRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  async function open(c: Context): Promise<User | Response> {
    const user = await currentUser(pool, c);
    if (!user) return c.json(UNAUTHENTICATED, 401);
    if (!(await teamSharedMovesEnabled(user.id))) return c.json(NOT_FOUND, 404);
    return user;
  }

  app.get("/users", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    const found = await pool.query<{ id: string; email: string; name: string; role: User["role"] }>(
      "SELECT id, email, name, role FROM users ORDER BY name, id",
    );
    return c.json(usersResponse.parse({ users: found.rows }));
  });

  app.get("/teams", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    return c.json(teamsResponse.parse({ teams: await listTeams(pool) }));
  });

  app.post("/teams", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    const origin = badOrigin(c);
    if (origin) return origin;
    if (user.role !== "owner") return c.json(FORBIDDEN, 403);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = createTeamBody.safeParse(body);
    if (!parsed.success) return c.json(INVALID_BODY, 400);
    const name = parsed.data.name.trim();
    if (name.length === 0 || name.length > 80) return c.json(INVALID_BODY, 400);
    const id = newId("team_");
    await pool.query("INSERT INTO teams (id, name, created_at) VALUES ($1, $2, now())", [id, name]);
    const team = await oneTeam(pool, id);
    if (!team) return c.json(NOT_FOUND, 404);
    return c.json(teamResponse.parse({ team }), 201);
  });

  app.delete("/teams/:id", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    const origin = badOrigin(c);
    if (origin) return origin;
    if (user.role !== "owner") return c.json(FORBIDDEN, 403);
    const removed = await pool.query("DELETE FROM teams WHERE id = $1", [c.req.param("id")]);
    if ((removed.rowCount ?? 0) === 0) return c.json(NOT_FOUND, 404);
    return c.body(null, 204);
  });

  app.post("/teams/:id/members", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    const origin = badOrigin(c);
    if (origin) return origin;
    if (user.role !== "owner") return c.json(FORBIDDEN, 403);
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = addMembersBody.safeParse(body);
    if (!parsed.success) return c.json(INVALID_BODY, 400);
    const id = c.req.param("id");
    const userIds = [...new Set(parsed.data.userIds)];
    const team = await oneTeam(pool, id);
    if (!team) return c.json(NOT_FOUND, 404);
    const known = await pool.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::text[])", [userIds]);
    if (known.rows.length !== userIds.length) return c.json(NOT_FOUND, 404);
    await pool.query(
      `INSERT INTO team_members (team_id, user_id)
       SELECT $1, member_id FROM unnest($2::text[]) AS member_id
       ON CONFLICT DO NOTHING`,
      [id, userIds],
    );
    const saved = await oneTeam(pool, id);
    if (!saved) return c.json(NOT_FOUND, 404);
    return c.json(teamResponse.parse({ team: saved }));
  });

  app.delete("/teams/:id/members/:userId", async (c) => {
    const user = await open(c);
    if (user instanceof Response) return user;
    const origin = badOrigin(c);
    if (origin) return origin;
    if (user.role !== "owner") return c.json(FORBIDDEN, 403);
    const id = c.req.param("id");
    const team = await oneTeam(pool, id);
    if (!team) return c.json(NOT_FOUND, 404);
    await pool.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [id, c.req.param("userId")]);
    const saved = await oneTeam(pool, id);
    if (!saved) return c.json(NOT_FOUND, 404);
    return c.json(teamResponse.parse({ team: saved }));
  });

  return app;
}
