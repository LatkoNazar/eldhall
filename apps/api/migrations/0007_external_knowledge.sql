-- Only citation identifiers and hashes are stored; remote corpora stay in their own database.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS external_source_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='support_messages_external_refs_array' AND conrelid='support_messages'::regclass) THEN
    ALTER TABLE support_messages ADD CONSTRAINT support_messages_external_refs_array CHECK (jsonb_typeof(external_source_refs)='array');
  END IF;
END $$;
