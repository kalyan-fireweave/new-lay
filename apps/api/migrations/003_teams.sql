CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (id),
  PRIMARY KEY (team_id, user_id)
);
