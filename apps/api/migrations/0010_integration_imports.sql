-- Prepared OpenAPI snapshots contain no credentials and never authorize an operation.
CREATE TABLE IF NOT EXISTS support_integration_imports (
 id uuid PRIMARY KEY,
 business_id uuid NOT NULL REFERENCES support_businesses(id),
 integration_id text NOT NULL,
 expires_at timestamptz NOT NULL,
 document jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_integration_import_scope ON support_integration_imports(business_id,expires_at);
