CREATE TABLE IF NOT EXISTS support_integrations (
  business_id uuid NOT NULL REFERENCES support_businesses(id),
  integration_id text NOT NULL,
  state jsonb NOT NULL,
  PRIMARY KEY(business_id,integration_id)
);
CREATE TABLE IF NOT EXISTS support_integration_manifests (
  business_id uuid NOT NULL REFERENCES support_businesses(id),
  integration_id text NOT NULL,
  manifest_hash text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(business_id,integration_id,manifest_hash)
);
CREATE TABLE IF NOT EXISTS support_integration_audit (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES support_businesses(id),
  integration_id text NOT NULL, actor text NOT NULL, type text NOT NULL,
  version integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE support_proposals DROP CONSTRAINT IF EXISTS support_proposals_status_check;
ALTER TABLE support_proposals ADD CONSTRAINT support_proposals_status_check CHECK(status IN ('pending','approved','executing','executed','rejected','failed','denied','unknown','expired','invalidated'));
ALTER TABLE support_proposals ADD COLUMN IF NOT EXISTS authorization_origin text;
CREATE TABLE IF NOT EXISTS support_external_executions (
  action_id uuid PRIMARY KEY REFERENCES support_proposals(id),
  business_id uuid NOT NULL REFERENCES support_businesses(id), integration_id text NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  authorization_origin text NOT NULL CHECK(authorization_origin IN ('operator_approval','policy_auto')),
  status text NOT NULL CHECK(status IN ('admitted','dispatched','executed','failed','unknown')),
  attempts integer NOT NULL DEFAULT 1,
  admitted_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
  completed_at timestamptz, provider_ref text, result jsonb, error text,
  completion_message_id uuid UNIQUE REFERENCES support_messages(id)
);
CREATE INDEX IF NOT EXISTS support_external_execution_status ON support_external_executions(status,admitted_at);
