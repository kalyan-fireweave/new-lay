import { useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { api, type DirectoryUser, type Team } from "../api.ts";
import { useSession } from "../store/session.ts";
import { refreshTeamDirectory, useTeamDirectory } from "../team-directory.ts";

export function TeamsPage() {
  const session = useSession();
  const directory = useTeamDirectory();
  const [teams, setTeams] = useState<Team[]>([]);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  const user = session.status === "user" ? session.user : null;
  const owner = user?.role === "owner";
  const selected = teams.find((team) => team.id === selectedId) ?? null;

  useEffect(() => {
    if (!user || directory.status !== "ready") return;
    let cancel = false;
    void Promise.all([api.teams(), api.users()])
      .then(([teamBody, userBody]) => {
        if (cancel) return;
        setTeams(teamBody.teams);
        setPeople(userBody.users);
        setSelectedId((current) => current || teamBody.teams[0]?.id || "");
        setReady(true);
        setError("");
      })
      .catch((caught: unknown) => {
        if (cancel) return;
        setError(caught instanceof Error ? caught.message : "Teams could not be loaded.");
        setReady(true);
      });
    return () => {
      cancel = true;
    };
  }, [user, directory.status]);

  if (session.status === "anonymous") return <Navigate to="/sign-in" replace />;
  if (!user || directory.status === "idle") return <p>Loading…</p>;
  if (directory.status === "closed") return <p className="lede">Teams are not available.</p>;

  function personName(id: string): string {
    return people.find((person) => person.id === id)?.name ?? id;
  }

  function toggle(id: string): void {
    setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function createTeam(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const body = await api.createTeam(trimmed);
      const next = await api.teams();
      setTeams(next.teams);
      refreshTeamDirectory();
      setSelectedId(body.team.id);
      setName("");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The team could not be created.");
    }
  }

  async function addPeople() {
    if (!selected || checked.length === 0) return;
    try {
      const body = await api.addMembers(selected.id, checked);
      setTeams((current) => current.map((team) => (team.id === body.team.id ? body.team : team)));
      refreshTeamDirectory();
      setChecked([]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Those people could not be added.");
    }
  }

  async function removePerson(userId: string) {
    if (!selected) return;
    try {
      const body = await api.removeMember(selected.id, userId);
      setTeams((current) => current.map((team) => (team.id === body.team.id ? body.team : team)));
      refreshTeamDirectory();
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That person could not be removed.");
    }
  }

  async function deleteTeam() {
    if (!selected) return;
    try {
      await api.deleteTeam(selected.id);
      const next = teams.filter((team) => team.id !== selected.id);
      setTeams(next);
      refreshTeamDirectory();
      setSelectedId(next[0]?.id ?? "");
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The team could not be deleted.");
    }
  }

  return (
    <section className="teams">
      <div className="board-head">
        <div>
          <h1>Teams</h1>
          <p className="lede">People on a team can move cards created by anyone on that team.</p>
        </div>
        {owner ? (
          <form className="composer" onSubmit={(event) => void createTeam(event)}>
            <label>
              Team name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name the team" />
            </label>
            <button type="submit">Create team</button>
          </form>
        ) : (
          <p className="hint">The board owner creates teams and adds people.</p>
        )}
      </div>
      {error ? <p className="alert" role="alert">{error}</p> : null}
      {!ready ? <p>Loading teams…</p> : null}
      <div className="team-layout">
        <section className="team-panel" aria-label="Teams">
          <h2>Teams</h2>
          {teams.length === 0 ? <p className="lede">No teams yet.</p> : null}
          <div className="team-choices">
            {teams.map((team) => (
              <button
                key={team.id}
                className="ghost team-choice"
                type="button"
                aria-pressed={team.id === selectedId}
                onClick={() => setSelectedId(team.id)}
              >
                {team.name}
                <span className="count">{team.memberIds.length}</span>
              </button>
            ))}
          </div>
          {selected ? (
            <>
              <ul className="member-list">
                {selected.memberIds.length === 0 ? <li className="lede">No one is on this team yet.</li> : null}
                {selected.memberIds.map((id) => (
                  <li key={id} className="person">
                    <span>{personName(id)}</span>
                    {owner ? (
                      <button className="ghost" type="button" onClick={() => void removePerson(id)}>
                        Remove {personName(id)}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {owner ? (
                <button className="ghost" type="button" onClick={() => void deleteTeam()}>
                  Delete team
                </button>
              ) : null}
            </>
          ) : null}
        </section>
        <section className="team-panel" aria-label="People">
          <h2>People</h2>
          <ul className="person-list">
            {people.map((person) => {
              const onTeam = selected?.memberIds.includes(person.id) ?? false;
              return (
                <li key={person.id} className="person">
                  {owner ? (
                    <input
                      type="checkbox"
                      checked={checked.includes(person.id)}
                      aria-label={person.name}
                      onChange={() => toggle(person.id)}
                    />
                  ) : null}
                  <span>
                    <strong>{person.name}</strong>
                    <small>{person.email}</small>
                  </span>
                  <small className="role">{person.role}</small>
                  {onTeam ? <small>On this team</small> : null}
                </li>
              );
            })}
          </ul>
          {owner ? (
            <button type="button" disabled={!selected || checked.length === 0} onClick={() => void addPeople()}>
              Add to team
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}
