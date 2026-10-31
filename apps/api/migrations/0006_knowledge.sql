-- Knowledge base v2: access metadata, version history and an optional pgvector passage index.
ALTER TABLE support_knowledge ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'customer';
ALTER TABLE support_knowledge ADD COLUMN IF NOT EXISTS plans jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE support_knowledge ADD COLUMN IF NOT EXISTS source_url text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_knowledge_audience_check' AND conrelid = 'support_knowledge'::regclass) THEN
    ALTER TABLE support_knowledge ADD CONSTRAINT support_knowledge_audience_check CHECK (audience IN ('customer', 'internal') AND jsonb_typeof(plans) = 'array');
  END IF;
END $$;

-- Every saved version (draft, published, revoked) is kept, so operators can see what the AI cited.
CREATE TABLE IF NOT EXISTS support_knowledge_versions (
  knowledge_id uuid NOT NULL, business_id uuid NOT NULL, version integer NOT NULL, status text NOT NULL,
  title text NOT NULL, category text NOT NULL, content text NOT NULL, audience text NOT NULL, plans jsonb NOT NULL,
  source_url text, updated_at timestamptz NOT NULL, PRIMARY KEY (knowledge_id, version));
CREATE OR REPLACE FUNCTION support_knowledge_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO support_knowledge_versions VALUES (NEW.id, NEW.business_id, NEW.version, NEW.status, NEW.title, NEW.category, NEW.content, NEW.audience, NEW.plans, NEW.source_url, NEW.updated_at)
  ON CONFLICT (knowledge_id, version) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_knowledge_history ON support_knowledge;
CREATE TRIGGER support_knowledge_history AFTER INSERT OR UPDATE ON support_knowledge FOR EACH ROW EXECUTE FUNCTION support_knowledge_history();
INSERT INTO support_knowledge_versions SELECT id, business_id, version, status, title, category, content, audience, plans, source_url, updated_at FROM support_knowledge ON CONFLICT DO NOTHING;

-- Passage vectors: only when pgvector is installed (image pgvector/pgvector, compose.knowledge.yaml).
-- The extension always lives in public so dropping a schema never drops it.
DO $$ DECLARE s text; BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgvector unavailable: %', SQLERRM; END;
  END IF;
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';
  IF s IS NOT NULL THEN
    EXECUTE format('CREATE TABLE IF NOT EXISTS support_knowledge_chunks (knowledge_id uuid NOT NULL, business_id uuid NOT NULL, version integer NOT NULL, embedder text NOT NULL, ord integer NOT NULL, section text NOT NULL, body text NOT NULL, content_hash text NOT NULL, embedding %I.vector(768) NOT NULL, tsv tsvector NOT NULL, PRIMARY KEY (knowledge_id, embedder, ord))', s);
    EXECUTE format('CREATE INDEX IF NOT EXISTS support_knowledge_chunks_hnsw ON support_knowledge_chunks USING hnsw (embedding %I.vector_cosine_ops)', s);
    CREATE INDEX IF NOT EXISTS support_knowledge_chunks_tsv ON support_knowledge_chunks USING gin (tsv);
    CREATE INDEX IF NOT EXISTS support_knowledge_chunks_ref ON support_knowledge_chunks (knowledge_id, version, embedder);
  END IF;
END $$;
