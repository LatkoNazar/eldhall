CREATE TABLE IF NOT EXISTS support_insight_runs (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES support_businesses(id) ON DELETE CASCADE,
  request_id uuid,
  requested_limit integer NOT NULL CHECK (requested_limit BETWEEN 1 AND 25),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  data jsonb NOT NULL,
  input_snapshot jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  fence integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS support_insight_one_active ON support_insight_runs(business_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS support_insight_claim ON support_insight_runs(status,lease_expires_at,created_at);
