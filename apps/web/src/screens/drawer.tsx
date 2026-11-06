import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api } from "../api.ts";
import { boardStore, useBoard, type ColumnName } from "../store/board.ts";
import { commentStore, useComments } from "../store/comments.ts";
import { useSession } from "../store/session.ts";

const labels: Record<ColumnName, string> = { todo: "Todo", doing: "Doing", done: "Done" };

export function Drawer() {
  const { boardId = "", cardId = "" } = useParams();
  const snapshot = useBoard(boardId);
  const thread = useComments(cardId);
  const card = snapshot?.cardsById[cardId];
  const session = useSession();
  const editor = session.status === "user" ? session.user : null;
  const [title, setTitle] = useState(card?.title ?? "");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [starred, setStarred] = useState(false);
  const keyRef = useRef<string | null>(null);
  const starKey = useRef<string | null>(null);
  const duplicateKey = useRef<string | null>(null);

  useEffect(() => {
    setTitle(card?.title ?? "");
  }, [card?.title]);

  if (!card) return <aside className="drawer">That card is not on this board.</aside>;

  const canEditTitle = editor?.role === "owner" || (editor?.role === "member" && editor.id === card.authorId);
  const canDuplicate = editor?.role === "owner" || (editor?.role === "member" && editor.id === card.authorId);

  async function saveTitle() {
    const current = boardStore.get(boardId)?.cardsById[cardId];
    if (!current) return;
    const next = title.trim();
    if (next === current.title) return;
    boardStore.setPending(cardId, { title: next });
    try {
      const body = await api.patchCard(cardId, current.version, { title: next });
      boardStore.applyMany(boardId, [body.card, ...body.shifted]);
      setError("");
    } catch (caught) {
      boardStore.clearPending(cardId);
      if (caught instanceof ApiError && caught.status === 409) {
        const fresh = (caught.body as { error?: { card?: typeof current } }).error?.card;
        if (fresh) boardStore.applyCard(boardId, fresh);
      }
      setError(caught instanceof Error ? caught.message : "The title could not be saved.");
      setTitle(boardStore.get(boardId)?.cardsById[cardId]?.title ?? current.title);
    }
  }

  async function onDuplicate() {
    if (!duplicateKey.current) duplicateKey.current = crypto.randomUUID();
    try {
      const body = await api.duplicateCard(cardId, duplicateKey.current);
      boardStore.applyCard(boardId, body.card);
      duplicateKey.current = null;
      setError("");
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 409)) duplicateKey.current = null;
      setError(caught instanceof Error ? caught.message : "The card could not be duplicated.");
    }
  }

  async function onStar() {
    if (starred) return;
    if (!starKey.current) starKey.current = crypto.randomUUID();
    try {
      await api.star(cardId, starKey.current);
      setStarred(true);
      setError("");
    } catch (caught) {
      starKey.current = null;
      setError(caught instanceof Error ? caught.message : "The card could not be starred.");
    }
  }

  async function sendComment(event: FormEvent) {
    event.preventDefault();
    const text = comment.trim();
    if (!text) return;
    if (!keyRef.current) keyRef.current = crypto.randomUUID();
    const key = keyRef.current;
    try {
      const body = await api.comment(cardId, text, key);
      commentStore.append(body.comment);
      boardStore.applyCard(boardId, body.card);
      keyRef.current = null;
      setComment("");
      setError("");
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 409)) keyRef.current = null;
      setError(caught instanceof Error ? caught.message : "The comment could not be sent.");
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label={card.title}>
      <div className="drawer-top">
        <p className="eyebrow">{labels[card.column]}</p>
        <Link to={`/boards/${boardId}`}>Close</Link>
      </div>
      <h2>{card.title}</h2>
      <label>
        Title
        <input
          value={title}
          readOnly={!canEditTitle}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (canEditTitle) void saveTitle();
          }}
        />
      </label>
      <button className="ghost" type="button" onClick={() => void onStar()}>{starred ? "Starred" : "Star"}</button>
      {canDuplicate ? <button type="button" onClick={() => void onDuplicate()}>Duplicate</button> : null}
      {error ? <p className="alert" role="alert">{error}</p> : null}
      <ul className="comments">
        {(thread?.comments ?? []).map((item) => (
          <li key={item.id}>
            <small>{item.authorId}</small>
            <div>{item.body}</div>
          </li>
        ))}
      </ul>
      <form className="comment-form" onSubmit={(event) => void sendComment(event)}>
        <label>
          Comment
          <input value={comment} onChange={(event) => setComment(event.target.value)} />
        </label>
        <button type="submit">Send</button>
      </form>
    </aside>
  );
}
