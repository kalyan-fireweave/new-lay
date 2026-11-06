import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { api, ApiError } from "../api.ts";
import { sessionStore, useSession } from "../store/session.ts";
import { clearTeamDirectory, refreshTeamDirectory, useTeamDirectory } from "../team-directory.ts";
import { SearchBox } from "./search.tsx";

export function Shell() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const gate = location.pathname === "/sign-in" || location.pathname === "/sign-up";
  const directory = useTeamDirectory();
  const userId = session.status === "user" ? session.user.id : "";
  const canPulse = session.status === "user" && session.user.role !== "viewer";
  const [pulseNote, setPulseNote] = useState("");

  useEffect(() => {
    if (!userId) {
      clearTeamDirectory();
      return;
    }
    refreshTeamDirectory();
  }, [userId]);

  async function recordPulse() {
    setPulseNote("");
    try {
      await api.pulse();
      setPulseNote("Recorded.");
    } catch (error) {
      setPulseNote(error instanceof ApiError ? error.message : "The request failed.");
    }
  }

  async function signOut() {
    await api.signOut();
    sessionStore.clear();
    navigate("/sign-in");
  }

  return (
    <div className={gate ? "app gate-app" : "app"}>
      {gate ? null : (
        <header className="top">
          <Link className="brand" to={session.status === "user" ? "/boards/launch" : "/sign-in"}>
            <span className="brand-mark" aria-hidden="true">K</span>
            Keel
          </Link>
          {session.status === "user" && directory.status === "ready" ? (
            <Link className="ghost linkish" to="/teams">Teams</Link>
          ) : null}
          {session.status === "user" ? (
            <>
              <SearchBox />
              {canPulse ? (
                <>
                  <button className="ghost" type="button" onClick={() => void recordPulse()}>Pulse</button>
                  {pulseNote ? <span className="hint">{pulseNote}</span> : null}
                </>
              ) : null}
              <span className="who">
                <span className="avatar" aria-hidden="true">{session.user.name.slice(0, 1)}</span>
                {session.user.name}
              </span>
              <button className="ghost" type="button" onClick={() => void signOut()}>Sign out</button>
            </>
          ) : (
            <Link className="ghost linkish" to="/sign-in">Sign in</Link>
          )}
        </header>
      )}
      <main className={gate ? "gate-main" : "page"}>
        <Outlet />
      </main>
    </div>
  );
}
