import { createBrowserRouter, Navigate, redirect } from "react-router";
import { ApiError, api } from "./api.ts";
import { BoardPage } from "./screens/board.tsx";
import { Drawer } from "./screens/drawer.tsx";
import { SearchPage } from "./screens/search.tsx";
import { Shell } from "./screens/shell.tsx";
import { TeamsPage } from "./screens/teams.tsx";
import { SignIn } from "./screens/sign-in.tsx";
import { SignUp } from "./screens/sign-up.tsx";
import { boardStore, snapshotFromCards } from "./store/board.ts";
import { commentStore } from "./store/comments.ts";
import { sessionStore, useSession } from "./store/session.ts";

const boardLoads = new Map<string, Promise<void>>();
const commentLoads = new Map<string, Promise<void>>();

async function loadBoard(boardId: string): Promise<void> {
  const inflight = boardLoads.get(boardId);
  if (inflight) return inflight;
  const run = (async () => {
    const existing = boardStore.get(boardId);
    if (!existing) {
      const body = await api.board(boardId);
      boardStore.replace(snapshotFromCards(body.board.id, body.board.name, body.board.revision, body.cards));
      return;
    }
    const change = await api.changes(boardId, existing.revision);
    boardStore.applyServerChanges(boardId, change);
    commentStore.merge(change.comments);
  })().finally(() => {
    boardLoads.delete(boardId);
  });
  boardLoads.set(boardId, run);
  return run;
}

async function loadComments(cardId: string): Promise<void> {
  if (commentStore.isLoaded(cardId)) return;
  const inflight = commentLoads.get(cardId);
  if (inflight) return inflight;
  const run = (async () => {
    const detail = await api.card(cardId);
    commentStore.set(cardId, detail.comments);
  })().finally(() => {
    commentLoads.delete(cardId);
  });
  commentLoads.set(cardId, run);
  return run;
}

function redirectIfSignedOut(error: unknown): never {
  if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
    if (error.status === 401) throw redirect("/sign-in");
  }
  throw error;
}

function Home() {
  const session = useSession();
  if (session.status !== "user") return <Navigate to="/sign-in" replace />;
  return <Navigate to="/boards/launch" replace />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    loader: async () => {
      await sessionStore.bootstrap();
      return null;
    },
    children: [
      { index: true, element: <Home /> },
      { path: "sign-in", element: <SignIn /> },
      { path: "sign-up", element: <SignUp /> },
      {
        path: "boards/:boardId",
        element: <BoardPage />,
        shouldRevalidate: ({ currentParams, nextParams }) => currentParams.boardId !== nextParams.boardId,
        loader: async ({ params }) => {
          await sessionStore.bootstrap();
          if (sessionStore.get().status !== "user") throw redirect("/sign-in");
          try {
            await loadBoard(params.boardId ?? "");
          } catch (error) {
            redirectIfSignedOut(error);
          }
          return null;
        },
        children: [
          {
            path: "cards/:cardId",
            element: <Drawer />,
            shouldRevalidate: ({ currentParams, nextParams }) => currentParams.cardId !== nextParams.cardId,
            loader: async ({ params }) => {
              const cardId = params.cardId ?? "";
              if (commentStore.isLoaded(cardId)) return null;
              try {
                await loadComments(cardId);
              } catch (error) {
                redirectIfSignedOut(error);
              }
              return null;
            },
          },
        ],
      },
      { path: "search", element: <SearchPage /> },
      { path: "teams", element: <TeamsPage /> },
    ],
  },
]);
