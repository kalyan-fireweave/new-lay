import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api.ts";
import { boardStore, useBoardState, type Card, type ColumnName } from "../store/board.ts";
import { commentStore } from "../store/comments.ts";
import { useSession } from "../store/session.ts";
import { useTeamDirectory } from "../team-directory.ts";

const order: ColumnName[] = ["todo", "doing", "done"];
const labels: Record<ColumnName, string> = { todo: "Todo", doing: "Doing", done: "Done" };

let draggingId: string | null = null;
let dragEndedAt = 0;

export function BoardPage() {
  const { boardId = "" } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const state = useBoardState();
  const snapshot = state.boards[boardId] ?? null;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const user = session.status === "user" ? session.user : null;
  const directory = useTeamDirectory();
  const teamMoves = directory.status === "ready";
  const [peerIds, setPeerIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const current = boardStore.get(boardId);
      if (!current || document.visibilityState === "hidden") return;
      void api.changes(boardId, current.revision).then((change) => {
        boardStore.applyServerChanges(boardId, change);
        commentStore.merge(change.comments);
      }).catch(() => {});
    };
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(tick, 15_000);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        window.clearInterval(timer);
        timer = 0;
        return;
      }
      tick();
      start();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [boardId]);

  useEffect(() => {
    if (!user || directory.status !== "ready") {
      setPeerIds(new Set());
      return;
    }
    const ids = new Set<string>();
    for (const team of directory.teams) {
      if (!team.memberIds.includes(user.id)) continue;
      for (const memberId of team.memberIds) ids.add(memberId);
    }
    setPeerIds(ids);
  }, [directory, user]);

  if (!snapshot || !user) return <p>Loading the board…</p>;

  const canCreate = user.role === "owner" || user.role === "member";

  function canMove(card: Card): boolean {
    if (!user) return false;
    if (user.role === "owner") return true;
    if (user.role === "member" && card.authorId === user.id) return true;
    return teamMoves && peerIds.has(card.authorId);
  }

  function cardsIn(column: ColumnName): Card[] {
    return order.flatMap((name) => snapshot!.byColumn[name]).filter((card) => {
      return (state.pending[card.id]?.column ?? card.column) === column;
    });
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    const key = boardStore.beginCreate(title, "todo");
    try {
      const body = await api.createCard({ boardId, title, column: "todo" }, key);
      boardStore.commitCreate(boardId, body.card);
      setDraft("");
      setError("");
    } catch (caught) {
      boardStore.clearPendingCreate();
      setError(caught instanceof Error ? caught.message : "The card could not be created.");
    }
  }

  async function onDrop(event: DragEvent, column: ColumnName) {
    event.preventDefault();
    const cardId = draggingId || event.dataTransfer.getData("text/plain");
    draggingId = null;
    if (!cardId) return;
    const card = boardStore.get(boardId)?.cardsById[cardId];
    if (!card || card.column === column || !canMove(card)) return;
    boardStore.beginMove(cardId, column);
    try {
      const body = await api.patchCard(cardId, card.version, { column });
      boardStore.applyMany(boardId, [body.card, ...body.shifted]);
      setError("");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const fresh = (caught.body as { error?: { card?: Card } }).error?.card;
        if (fresh) {
          boardStore.applyCard(boardId, fresh);
          setError(caught.message);
          return;
        }
      }
      boardStore.clearPending(cardId);
      setError(caught instanceof Error ? caught.message : "The card could not be moved.");
    }
  }

  return (
    <div className="board-layout">
      <div>
        <div className="board-head">
          <div>
            <h1>{snapshot.name}</h1>
            <p className="lede">{Object.keys(snapshot.cardsById).length} cards</p>
          </div>
          {canCreate ? (
            <form className="composer" onSubmit={(event) => void onCreate(event)}>
              <label>
                New card
                <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What needs doing?" />
              </label>
              <button type="submit">Add</button>
            </form>
          ) : null}
        </div>
        {error ? <p className="alert" role="alert">{error}</p> : null}
        <div className="columns">
          {order.map((column) => {
            const cards = cardsIn(column);
            return (
            <section
              key={column}
              className="column"
              data-column={column}
              aria-label={labels[column]}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void onDrop(event, column)}
            >
              <div className="column-head">
                <h2>{labels[column]}</h2>
                <span className="count">{cards.length}</span>
              </div>
              {cards.map((card) => {
                const movable = canMove(card);
                const title = state.pending[card.id]?.title ?? card.title;
                return (
                  <div
                    key={card.id}
                    className="card"
                    role="button"
                    tabIndex={0}
                    draggable={movable}
                    onDragStart={(event) => {
                      if (!movable) {
                        event.preventDefault();
                        return;
                      }
                      draggingId = card.id;
                      event.dataTransfer.setData("text/plain", card.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      dragEndedAt = Date.now();
                    }}
                    onClick={() => {
                      if (Date.now() - dragEndedAt < 500) return;
                      navigate(`/boards/${boardId}/cards/${card.id}`);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigate(`/boards/${boardId}/cards/${card.id}`);
                      }
                    }}
                    aria-label={title}
                  >
                    {title}
                    {card.assigneeName ? <span className="assignee">{card.assigneeName}</span> : null}
                  </div>
                );
              })}
              {state.pendingCreate?.column === column ? <div className="pending">{state.pendingCreate.title}</div> : null}
            </section>
            );
          })}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
