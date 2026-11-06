import type { BoardResponse, Card } from "@keel/contracts/board";
import type { User } from "@keel/contracts/session";
import type { DirectoryUser, Team } from "@keel/contracts/teams";
import type { Comment } from "@keel/contracts/writes";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const record = body as { error?: { code?: string; message?: string } } | null;
    super(record?.error?.message || "The request failed.");
    this.status = status;
    this.code = record?.error?.code || "internal";
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export type CardDetail = { card: Card; comments: Comment[] };
export type PatchResult = { card: Card; shifted: Card[] };
export type CommentResult = { comment: Comment; card: Card };
export type SearchResult = { query: string; cards: Card[] };
export type Changes = { revision: number; cards: Card[]; comments: Comment[]; removedCardIds: string[] };
export type { DirectoryUser, Team };

export const api = {
  session: () => request<{ user: User }>("/session"),
  signIn: (email: string, password: string) =>
    request<{ user: User }>("/session", { method: "POST", body: JSON.stringify({ email, password }) }),
  signUp: (name: string, email: string, password: string) =>
    request<{ user: User }>("/session/sign-up", { method: "POST", body: JSON.stringify({ name, email, password }) }),
  signOut: () => request<null>("/session", { method: "DELETE" }),
  board: (boardId: string) => request<BoardResponse>(`/boards/${boardId}`),
  changes: (boardId: string, since: number) =>
    request<Changes>(`/boards/${boardId}/changes?since=${since}`),
  card: (cardId: string) => request<CardDetail>(`/cards/${cardId}`),
  createCard: (body: { boardId: string; title: string; column: Card["column"] }, key: string) =>
    request<{ card: Card }>("/cards", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "idempotency-key": key },
    }),
  patchCard: (cardId: string, version: number, body: { title?: string; column?: Card["column"] }) =>
    request<PatchResult>(`/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "if-match": String(version) },
    }),
  star: (cardId: string, key: string) =>
    request<{ starred: boolean }>(`/cards/${cardId}/stars`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "idempotency-key": key },
    }),
  comment: (cardId: string, body: string, key: string) =>
    request<CommentResult>(`/cards/${cardId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "idempotency-key": key },
    }),
  search: (query: string) => request<SearchResult>(`/search?q=${encodeURIComponent(query)}`),
  users: () => request<{ users: DirectoryUser[] }>("/users"),
  teams: () => request<{ teams: Team[] }>("/teams"),
  createTeam: (name: string) => request<{ team: Team }>("/teams", { method: "POST", body: JSON.stringify({ name }) }),
  deleteTeam: (teamId: string) => request<null>(`/teams/${teamId}`, { method: "DELETE" }),
  addMembers: (teamId: string, userIds: string[]) =>
    request<{ team: Team }>(`/teams/${teamId}/members`, { method: "POST", body: JSON.stringify({ userIds }) }),
  removeMember: (teamId: string, userId: string) =>
    request<{ team: Team }>(`/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
};
