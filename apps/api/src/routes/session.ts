import { createHash } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import type pg from "pg";
import { signInBody, signUpBody, type User } from "@keel/contracts/session";
import { hashPassword, verifyPassword } from "../db/password.ts";
import { rememberPerson } from "../fireweave/identity.ts";
import { newId } from "../ids.ts";

const COOKIE = "keel_session";
const MAX_AGE = 43_200;
const INVALID = { error: { code: "invalid_credentials", message: "Email or password is wrong." } };
const UNAUTHENTICATED = { error: { code: "unauthenticated", message: "Sign in required." } };
const DUMMY_HASH = hashPassword("keel-dummy-password");

type UserRow = User & { password_hash: string };

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    secure: process.env.KEEL_ENV === "production",
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function readUser(pool: pg.Pool, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const found = await pool.query<User & { expires_at: Date }>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash(token)],
  );
  const row = found.rows[0];
  if (!row || row.expires_at.getTime() <= Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

function publicUser(row: User): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

async function startSession(pool: pg.Pool, userId: string, token: string): Promise<void> {
  const expires = new Date(Date.now() + MAX_AGE * 1000);
  await pool.query(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [newId("ses_"), userId, tokenHash(token), expires],
  );
}

export function sessionRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  app.post("/session/sign-up", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_body", message: "Body must be JSON." } }, 400);
    }
    const parsed = signUpBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_body", message: "Sign-up body is invalid." } }, 400);
    }
    const name = parsed.data.name.trim();
    const email = parsed.data.email.trim().toLowerCase();
    const password = parsed.data.password;
    if (!name || name.length > 80) {
      return c.json({ error: { code: "invalid_name", message: "Name must be 1 to 80 characters." } }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: { code: "invalid_email", message: "Email is not valid." } }, 400);
    }
    if (password.length < 8 || password.length > 200) {
      return c.json({ error: { code: "invalid_password", message: "Password must be 8 to 200 characters." } }, 400);
    }
    const user: User = { id: newId("user_"), email, name, role: "member" };
    try {
      await pool.query(
        "INSERT INTO users (id, email, name, role, password_hash) VALUES ($1, $2, $3, 'member', $4)",
        [user.id, email, name, hashPassword(password)],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return c.json({ error: { code: "conflict", message: "An account with that email already exists." } }, 409);
      }
      throw error;
    }
    const token = newId("ses_");
    await startSession(pool, user.id, token);
    setCookie(c, COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE });
    rememberPerson(user.id, user.role);
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post("/session", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_body", message: "Body must be JSON." } }, 400);
    }
    const parsed = signInBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_body", message: "Sign-in body is invalid." } }, 400);
    }

    const email = parsed.data.email.trim().toLowerCase();
    const found = await pool.query<UserRow>(
      "SELECT id, email, name, role, password_hash FROM users WHERE email = $1",
      [email],
    );
    const row = found.rows[0];
    const matches = verifyPassword(parsed.data.password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !matches) return c.json(INVALID, 401);

    const token = newId("ses_");
    await startSession(pool, row.id, token);
    setCookie(c, COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE });
    rememberPerson(row.id, row.role);
    return c.json({ user: publicUser(row) }, 201);
  });

  app.get("/session", async (c) => {
    const user = await readUser(pool, getCookie(c, COOKIE));
    if (!user) return c.json(UNAUTHENTICATED, 401);
    return c.json({ user });
  });

  app.delete("/session", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    }
    deleteCookie(c, COOKIE, cookieOptions());
    return c.body(null, 204);
  });

  return app;
}
