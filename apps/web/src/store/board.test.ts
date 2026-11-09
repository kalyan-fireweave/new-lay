import { describe, expect, it } from "vitest";
import { applyCard, applyChanges, applyConflict, snapshotFromCards, type Card, type ColumnName } from "./board.ts";

function card(index: number): Card {
  const column = (["todo", "doing", "done"] as const)[index % 3] as ColumnName;
  return {
    id: `card_${String(index + 1).padStart(2, "0")}`,
    boardId: "launch",
    title: `Card ${index + 1}`,
    column,
    position: (Math.floor(index / 3) + 1) * 1024,
    authorId: index % 2 === 0 ? "user_ada" : "user_grace",
    assigneeId: null,
    assigneeName: null,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    version: 1,
  };
}

function launch() {
  return snapshotFromCards("launch", "Launch", 1, Array.from({ length: 12 }, (_, index) => card(index)));
}

describe("board store", () => {
  it("keeps the snapshot when a poll is empty", () => {
    const snapshot = launch();
    const next = applyChanges(snapshot, { revision: 1, cards: [], comments: [], removedCardIds: [] });
    expect(next).toBe(snapshot);
    expect(next.byColumn.todo).toBe(snapshot.byColumn.todo);
  });

  it("appends a new todo card and leaves the doing array alone", () => {
    const snapshot = launch();
    const created: Card = { ...card(0), id: "card_99", title: "Check the collector", position: 5120, version: 2 };
    const next = applyCard(snapshot, created);
    expect(next).not.toBe(snapshot);
    expect(next.byColumn.doing).toBe(snapshot.byColumn.doing);
    expect(next.byColumn.todo.at(-1)).toBe(created);
    expect(next.revision).toBe(2);
  });

  it("moves card_01 onto the end of doing without copying card_02", () => {
    const snapshot = launch();
    const moved: Card = { ...snapshot.cardsById.card_01, column: "doing", version: 2 };
    const next = applyCard(snapshot, moved);
    expect(next.byColumn.todo.some((item) => item.id === "card_01")).toBe(false);
    expect(next.byColumn.doing.at(-1)?.id).toBe("card_01");
    expect(next.cardsById.card_02).toBe(snapshot.cardsById.card_02);
  });

  it("replaces the stale card with the 409 card", () => {
    const snapshot = launch();
    const cardFromServer: Card = { ...snapshot.cardsById.card_01, title: "From the server", version: 4 };
    const next = applyConflict(snapshot, { error: { card: cardFromServer } });
    expect(next.cardsById.card_01).toBe(cardFromServer);
  });
});
