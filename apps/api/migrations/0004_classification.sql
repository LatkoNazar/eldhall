-- Business-specific classification is independent from the action policy and intent.
ALTER TABLE support_settings ADD COLUMN IF NOT EXISTS classification jsonb;
