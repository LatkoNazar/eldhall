CREATE TABLE IF NOT EXISTS support_turn_jobs (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES support_cases(id),
  customer_id uuid NOT NULL REFERENCES support_customers(id),
  customer_message_id uuid NOT NULL UNIQUE REFERENCES support_messages(id),
  body text NOT NULL,
  ownership_version integer NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  fence integer NOT NULL DEFAULT 0,
  worker_id text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS support_one_active_turn ON support_turn_jobs(case_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS support_turn_outbox ON support_turn_jobs(status,available_at,lease_expires_at);
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS client_message_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS support_customer_message_dedupe ON support_messages(case_id,client_message_id) WHERE client_message_id IS NOT NULL;
ALTER TABLE support_proposals ADD COLUMN IF NOT EXISTS turn_job_id uuid REFERENCES support_turn_jobs(id);
CREATE UNIQUE INDEX IF NOT EXISTS support_proposal_logical_turn ON support_proposals(turn_job_id,tool) WHERE turn_job_id IS NOT NULL;
ALTER TABLE support_agent_runs ADD COLUMN IF NOT EXISTS turn_job_id uuid REFERENCES support_turn_jobs(id);
