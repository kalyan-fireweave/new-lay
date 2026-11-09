import { useSyncExternalStore } from "react";

export type ColumnName = "todo" | "doing" | "done";

export type Card = {
  id: string;
  boardId: string;
  title: string;
  column: ColumnName;
  position: number;
  authorId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type BoardSnapshot = {
  id: string;
  name: string;
  revision: number;
  cardsById: Record<string, Card>;
  byColumn: Record<ColumnName, Card[]>;
};

export type ChangeBatch = {
  revision: number;
  cards: Card[];
  comments?: unknown[];
  removedCardIds?: string[];
};

const columns: ColumnName[] = ["todo", "doing", "done"];

export function snapshotFromCards(id: string, name: string, revision: number, cards: Card[]): BoardSnapshot {
  const byColumn: Record<ColumnName, Card[]> = { todo: [], doing: [], done: [] };
  const cardsById: Record<string, Card> = {};
  for (const card of cards) {
    cardsById[card.id] = card;
    byColumn[card.column].push(card);
  }
  for (const column of columns) byColumn[column].sort((a, b) => a.position - b.position);
  return { id, name, revision, cardsById, byColumn };
}

export function applyCard(snapshot: BoardSnapshot, card: Card): BoardSnapshot {
  const previous = snapshot.cardsById[card.id];
  const cardsById = { ...snapshot.cardsById, [card.id]: card };
  const byColumn = { ...snapshot.byColumn };
  if (!previous) {
    byColumn[card.column] = [...byColumn[card.column], card];
  } else if (previous.column === card.column) {
    byColumn[card.column] = byColumn[card.column].map((item) => (item.id === card.id ? card : item));
  } else {
    byColumn[previous.column] = byColumn[previous.column].filter((item) => item.id !== card.id);
    byColumn[card.column] = [...byColumn[card.column], card];
  }
  return {
    ...snapshot,
    revision: Math.max(snapshot.revision, card.version),
    cardsById,
    byColumn,
  };
}

export function applyChanges(snapshot: BoardSnapshot, change: ChangeBatch): BoardSnapshot {
  const cards = change.cards ?? [];
  const removed = change.removedCardIds ?? [];
  if (cards.length === 0 && removed.length === 0) return snapshot;
  let next = snapshot;
  for (const card of cards) next = applyCard(next, card);
  if (removed.length > 0) {
    const cardsById = { ...next.cardsById };
    const byColumn = { ...next.byColumn };
    for (const id of removed) {
      const card = cardsById[id];
      if (!card) continue;
      delete cardsById[id];
      byColumn[card.column] = byColumn[card.column].filter((item) => item.id !== id);
    }
    next = { ...next, cardsById, byColumn };
  }
  return { ...next, revision: change.revision };
}

export function applyConflict(snapshot: BoardSnapshot, body: { error: { card: Card } }): BoardSnapshot {
  return applyCard(snapshot, body.error.card);
}

type PendingCreate = { title: string; column: ColumnName; key: string };
type PendingCard = { title?: string; column?: ColumnName };

type StoreState = {
  boards: Record<string, BoardSnapshot>;
  pendingCreate: PendingCreate | null;
  pending: Record<string, PendingCard>;
};

let state: StoreState = { boards: {}, pendingCreate: null, pending: {} };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const boardStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState(): StoreState {
    return state;
  },
  get(boardId: string): BoardSnapshot | null {
    return state.boards[boardId] ?? null;
  },
  replace(snapshot: BoardSnapshot): void {
    state = { ...state, boards: { ...state.boards, [snapshot.id]: snapshot } };
    emit();
  },
  commitCreate(boardId: string, card: Card): void {
    const current = state.boards[boardId];
    if (!current) return;
    state = {
      ...state,
      pendingCreate: null,
      boards: { ...state.boards, [boardId]: applyCard(current, card) },
    };
    emit();
  },
  applyCard(boardId: string, card: Card): void {
    const current = state.boards[boardId];
    if (!current) return;
    state = {
      ...state,
      pending: omit(state.pending, card.id),
      boards: { ...state.boards, [boardId]: applyCard(current, card) },
    };
    emit();
  },
  applyMany(boardId: string, cards: Card[]): void {
    const current = state.boards[boardId];
    if (!current || cards.length === 0) return;
    let next = current;
    let pending = state.pending;
    for (const card of cards) {
      next = applyCard(next, card);
      pending = omit(pending, card.id);
    }
    state = { ...state, pending, boards: { ...state.boards, [boardId]: next } };
    emit();
  },
  applyServerChanges(boardId: string, change: ChangeBatch): void {
    const current = state.boards[boardId];
    if (!current) return;
    const next = applyChanges(current, change);
    if (next === current) return;
    state = { ...state, boards: { ...state.boards, [boardId]: next } };
    emit();
  },
  beginCreate(title: string, column: ColumnName): string {
    if (state.pendingCreate?.title === title && state.pendingCreate.column === column) return state.pendingCreate.key;
    const key = crypto.randomUUID();
    state = { ...state, pendingCreate: { title, column, key } };
    emit();
    return key;
  },
  clearPendingCreate(): void {
    if (!state.pendingCreate) return;
    state = { ...state, pendingCreate: null };
    emit();
  },
  beginMove(cardId: string, column: ColumnName): void {
    state = { ...state, pending: { ...state.pending, [cardId]: { ...state.pending[cardId], column } } };
    emit();
  },
  setPending(cardId: string, patch: PendingCard): void {
    state = { ...state, pending: { ...state.pending, [cardId]: { ...state.pending[cardId], ...patch } } };
    emit();
  },
  clearPending(cardId: string): void {
    if (!state.pending[cardId]) return;
    state = { ...state, pending: omit(state.pending, cardId) };
    emit();
  },
  getPendingCreate(): PendingCreate | null {
    return state.pendingCreate;
  },
  getPending(): Record<string, PendingCard> {
    return state.pending;
  },
};

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function useBoard(boardId: string): BoardSnapshot | null {
  return useSyncExternalStore(boardStore.subscribe, () => boardStore.get(boardId));
}

export function useBoardState(): StoreState {
  return useSyncExternalStore(boardStore.subscribe, boardStore.getState);
}
