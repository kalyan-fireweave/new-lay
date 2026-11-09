ALTER TABLE cards ADD COLUMN IF NOT EXISTS assignee_id text REFERENCES users (id);
