CREATE TABLE IF NOT EXISTS support_request_catalogs (
  case_id uuid PRIMARY KEY REFERENCES support_cases(id),
  version integer NOT NULL CHECK(version >= 0),
  sync_state text NOT NULL CHECK(sync_state IN ('current','needs_review')),
  last_source_message_id uuid REFERENCES support_messages(id),
  document jsonb NOT NULL CHECK(jsonb_typeof(document)='array')
);
CREATE TABLE IF NOT EXISTS support_request_checkpoints (
  case_id uuid NOT NULL REFERENCES support_cases(id),
  source_message_id uuid NOT NULL REFERENCES support_messages(id),
  fingerprint text NOT NULL, response jsonb NOT NULL,
  PRIMARY KEY(case_id,source_message_id)
);
CREATE TABLE IF NOT EXISTS support_request_events (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES support_cases(id),
  request_id uuid NOT NULL, revision integer NOT NULL CHECK(revision > 0),
  event jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_request_events_case ON support_request_events(case_id,created_at,id);
