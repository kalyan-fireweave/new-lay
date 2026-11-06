import { useEffect, useState, useSyncExternalStore } from "react";
import { METRIC_NAME } from "./names.ts";
import { runStore, type AccountCatalog, type AccountSlot, type RunEvent } from "./store.ts";

type Metric = { name: string; description: string };

type Destination = "application" | "infrastructure" | "both";

const titles: Record<string, string> = {
  "keel.card.created": "Cards created",
  "keel.card.moved": "Cards moved",
  "keel.comment.created": "Comments",
  "keel.card.starred": "Stars",
  "keel.card.duplicated": "Cards copied",
  "keel.card.duplicate.rejected": "Copies refused",
  "keel.card.duplicate.failed": "Copies failed",
  "http.server.requests": "Requests",
  "http.server.request.duration": "Request time",
};

const plain: Record<string, string> = {
  "keel.card.created": "A card was added.",
  "keel.card.moved": "A card changed column.",
  "keel.comment.created": "A comment was saved.",
  "keel.card.starred": "A card was starred.",
  "keel.card.duplicated": "A card was copied.",
  "keel.card.duplicate.rejected": "A copy was refused.",
  "keel.card.duplicate.failed": "A copy failed.",
  "http.server.requests": "The API answered a call.",
  "http.server.request.duration": "How long a call took.",
};

const order = Object.keys(titles);

const fallback: Metric[] = order.map((name) => ({ name, description: "" }));

function titleFor(name: string): string {
  return titles[name] ?? name;
}

function sortMetrics(items: Metric[]): Metric[] {
  return [...items].sort((left, right) => {
    const a = order.indexOf(left.name);
    const b = order.indexOf(right.name);
    return (a === -1 ? order.length : a) - (b === -1 ? order.length : b);
  });
}

function asMetrics(value: unknown): Metric[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as { metrics?: unknown }).metrics;
  if (!Array.isArray(list)) return [];
  return sortMetrics(list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { name?: unknown; description?: unknown };
    if (typeof record.name !== "string" || !record.name) return [];
    return [{ name: record.name, description: typeof record.description === "string" ? record.description : "" }];
  }));
}

function accountNote(slot: AccountSlot | undefined): string {
  if (!slot) return "Checking this account.";
  if (slot.usesApplication) return "Same account as Application.";
  if (!slot.configured) return "Not set up. Numbers stay in the collector log.";
  return "Ready.";
}

export function Studio() {
  const snapshot = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot, runStore.getSnapshot);
  const [metrics, setMetrics] = useState<Metric[]>(fallback);
  const [picked, setPicked] = useState<string[]>(["keel.card.created"]);
  const [extra, setExtra] = useState<Metric[]>([]);
  const [custom, setCustom] = useState("");
  const [where, setWhere] = useState<Destination>("application");
  const [times, setTimes] = useState(5);
  const [every, setEvery] = useState(2);

  useEffect(() => {
    let cancel = false;
    void Promise.all([
      fetch("/targets", { headers: { accept: "application/json" } }).then((response) => response.json()),
      fetch("/accounts", { headers: { accept: "application/json" } }).then((response) => response.json()),
      fetch("/metrics", { headers: { accept: "application/json" } }).then((response) => response.json()),
    ]).then(([targetsBody, accountsBody, metricsBody]) => {
      if (cancel) return;
      const next = asMetrics(metricsBody);
      if (next.length) setMetrics(next);
      runStore.setCatalog(targetsBody.targets ?? [], [], accountsBody as AccountCatalog);
    });
    return () => {
      cancel = true;
    };
  }, []);

  const accounts = where === "both" ? (["application", "infrastructure"] as const) : ([where] as const);
  const shown = [...metrics, ...extra.filter((item) => !metrics.some((known) => known.name === item.name))];
  const chosen = shown.filter((item) => picked.includes(item.name));
  const names = chosen.map((item) => titleFor(item.name));
  const destination = where === "both" ? "both accounts" : where === "infrastructure" ? "the infrastructure account" : "the application account";
  const summary = names.length
    ? `Sending ${names.join(", ")} to ${destination}, ${times} ${times === 1 ? "time" : "times"}, every ${every} ${every === 1 ? "second" : "seconds"}.`
    : "Pick at least one number.";

  function toggle(name: string, on: boolean): void {
    runStore.setError("");
    setPicked((current) => (on ? [...new Set([...current, name])] : current.filter((item) => item !== name)));
  }

  function addCustom(): void {
    const name = custom.trim();
    if (!METRIC_NAME.test(name)) {
      runStore.setError("Use a name like keel.signup.completed. Letters, digits, dots, and underscores.");
      return;
    }
    if (picked.length >= 20 && !picked.includes(name)) {
      runStore.setError("Twenty numbers is the limit for one send.");
      return;
    }
    runStore.setError("");
    setCustom("");
    if (!metrics.some((item) => item.name === name)) {
      setExtra((current) => (current.some((item) => item.name === name) ? current : [...current, { name, description: "A name you added." }]));
    }
    setPicked((current) => (current.includes(name) ? current : [...current, name]));
  }

  function removeCustom(name: string): void {
    runStore.setError("");
    setExtra((current) => current.filter((item) => item.name !== name));
    setPicked((current) => current.filter((item) => item !== name));
  }

  async function start(): Promise<void> {
    if (picked.length === 0) {
      runStore.setError("Pick at least one number.");
      return;
    }
    const response = await fetch("/runs", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        target: "local",
        mode: "computer",
        journey: "create-card",
        pace: "demo",
        seed: "phase7-seed",
        confirm: "",
        people: "metrics",
        accounts,
        metrics: picked,
        metricCount: times,
        intervalMs: every * 1000,
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      runStore.setError(json.error?.message ?? "The send was refused.");
      return;
    }
    const run = json.run as { id: string; scale: number; actors: number; status: string };
    runStore.start(run);
    const source = new EventSource(`/runs/${run.id}/events`);
    source.onmessage = (message) => {
      runStore.append(JSON.parse(message.data) as RunEvent);
    };
    source.onerror = () => {
      source.close();
      void fetch(`/runs/${run.id}`, { headers: { accept: "application/json" } })
        .then((next) => next.json())
        .then((body) => {
          if (body.run?.status) runStore.setStatus(body.run.status);
        })
        .catch(() => undefined);
    };
  }

  async function control(action: "pause" | "stop"): Promise<void> {
    const live = runStore.getSnapshot().live;
    if (!live) return;
    const response = await fetch(`/runs/${live.id}/${action}`, { method: "POST", headers: { accept: "application/json" } });
    const json = await response.json();
    if (response.ok) runStore.setStatus(json.run.status);
  }

  const live = snapshot.live;
  const latest = live?.events.at(-1);

  return (
    <main className="studio">
      <header className="top">
        <h1>Studio</h1>
        <p>Pick the numbers. Choose where they go. Start.</p>
      </header>
      <p className="brief">{summary}</p>
      <form className="controls" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="field">
          <legend>Numbers</legend>
          {shown.map((item) => {
            const added = extra.some((customMetric) => customMetric.name === item.name);
            const row = (
              <label className="choice">
                <input
                  type="checkbox"
                  name="metric"
                  value={item.name}
                  checked={picked.includes(item.name)}
                  onChange={(event) => toggle(item.name, event.target.checked)}
                />
                <span>
                  <strong>{titleFor(item.name)}</strong>
                  <small>{plain[item.name] ?? item.description}</small>
                </span>
              </label>
            );
            return added ? (
              <div className="custom-row" key={item.name}>
                {row}
                <button type="button" className="ghost" aria-label={`Remove ${item.name}`} onClick={() => removeCustom(item.name)}>Remove</button>
              </div>
            ) : (
              <div key={item.name}>{row}</div>
            );
          })}
          <div className="add">
            <label htmlFor="custom">Add a metric</label>
            <span className="with-unit">
              <input
                id="custom"
                name="custom"
                value={custom}
                placeholder="keel.signup.completed"
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustom();
                  }
                }}
              />
              <button type="button" onClick={addCustom}>Add</button>
            </span>
            <p className="hint">Letters, digits, dots, and underscores.</p>
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Where they go</legend>
          <label className="choice">
            <input type="radio" name="where" value="application" checked={where === "application"} onChange={() => { runStore.setError(""); setWhere("application"); }} />
            <span>
              <strong>Application</strong>
              <small>Keeps this run’s id. {accountNote(snapshot.accounts?.application)}</small>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="where" value="infrastructure" checked={where === "infrastructure"} onChange={() => { runStore.setError(""); setWhere("infrastructure"); }} />
            <span>
              <strong>Infrastructure</strong>
              <small>Leaves the run id out. {accountNote(snapshot.accounts?.infrastructure)}</small>
            </span>
          </label>
          <label className="choice">
            <input type="radio" name="where" value="both" checked={where === "both"} onChange={() => { runStore.setError(""); setWhere("both"); }} />
            <span>
              <strong>Both</strong>
              <small>Application keeps the run id. Infrastructure does not.</small>
            </span>
          </label>
        </fieldset>
        <div className="field">
          <div className="pair">
            <label htmlFor="times">Times</label>
            <label htmlFor="every">Every</label>
            <input id="times" type="number" min={1} max={100} value={times} onChange={(event) => setTimes(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} />
            <span className="with-unit">
              <input id="every" type="number" min={1} max={60} value={every} onChange={(event) => setEvery(Math.min(60, Math.max(1, Number(event.target.value) || 1)))} />
              <span>seconds</span>
            </span>
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void start()}>Start</button>
          <button type="button" className="ghost" onClick={() => void control("pause")} disabled={!live}>Pause</button>
          <button type="button" className="ghost" onClick={() => void control("stop")} disabled={!live}>Stop</button>
        </div>
      </form>
      {snapshot.error ? <p className="alert" role="alert">{snapshot.error}</p> : null}
      {live ? (
        <section className="strip" aria-label="Live run">
          <h2>This send</h2>
          <dl>
            <div>
              <dt>Run</dt>
              <dd data-run="">{live.id}</dd>
            </div>
            <div>
              <dt>Scale</dt>
              <dd data-scale="">{live.scale}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{live.status}</dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>{latest ? `${live.events.length} of ${times}` : "waiting"}</dd>
            </div>
            <div>
              <dt>Number</dt>
              <dd>{latest?.step ?? "starting"}</dd>
            </div>
            <div>
              <dt>Errors</dt>
              <dd>{latest?.errorCount ?? 0}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </main>
  );
}
