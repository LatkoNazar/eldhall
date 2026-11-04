// Fixed catalog queries only. SQL definitions are hashed on PG17, never returned.
const hash = (sql: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((${sql}), 'UTF8')), 'hex')`;
const owned = `JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`;
export const schemaCatalogQueries = {
  relations: `SELECT c.oid::text AS object_id,c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
    (SELECT count(*)::int FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance,
    (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policies,
    (SELECT count(*)::int FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid) AS rules
    FROM pg_catalog.pg_class c ${owned} ORDER BY c.relname LIMIT 64`,
  columns: `SELECT c.relname AS relation,a.attname AS name,tn.nspname AS type_schema,t.typname AS type,a.atttypmod AS typmod,
    a.attnotnull AS required,a.attidentity AS identity,a.attgenerated AS generated,cn.nspname AS collation_schema,co.collname AS collation,
    ${hash('pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)')} AS default_hash
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    ${owned} ORDER BY c.relname,a.attnum LIMIT 2049`,
  constraints: `SELECT c.relname AS relation,k.conname AS name,k.contype AS type,k.convalidated AS validated,k.condeferrable AS deferrable,k.condeferred AS deferred,
    ${hash('pg_catalog.pg_get_constraintdef(k.oid,false)')} AS definition_hash
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid ${owned}
    ORDER BY c.relname,k.conname LIMIT 1025`,
  indexes: `SELECT c.relname AS relation,x.relname AS name,am.amname AS method,i.indisunique AS unique,i.indisprimary AS primary,
    i.indnullsnotdistinct AS nulls_not_distinct,i.indimmediate AS immediate,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,
    ${hash('pg_catalog.pg_get_indexdef(i.indexrelid,0,false)')} AS definition_hash
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indrelid=c.oid JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=x.relam ${owned} ORDER BY c.relname,x.relname LIMIT 1025`,
  triggers: `SELECT c.relname AS relation,CASE WHEN t.tgisinternal THEN NULL ELSE t.tgname END AS name,t.tgisinternal AS internal,
    t.tgenabled AS enabled,t.tgtype AS type,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,k.conname AS constraint_name,
    pn.nspname AS function_schema,p.proname AS function_name,p.pronargs AS function_args,
    CASE WHEN t.tgisinternal THEN NULL ELSE ${hash('pg_catalog.pg_get_triggerdef(t.oid,false)')} END AS definition_hash
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace LEFT JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint ${owned}
    ORDER BY c.relname,t.tgisinternal,k.conname,pn.nspname,p.proname,t.tgtype,t.tgenabled,t.tgname LIMIT 1025`,
};
export const schemaHistoryFunctionQuery = `SELECT l.lanname AS language,p.prokind AS kind,p.provolatile AS volatility,p.proparallel AS parallel,
  p.prosecdef AS security_definer,p.proleakproof AS leakproof,p.proisstrict AS strict,p.proretset AS returns_set,
  pg_catalog.format_type(p.prorettype,NULL) AS returns,
  ${hash('p.prosrc')} AS body_hash,${hash("coalesce(p.proconfig::text,'')")} AS config_hash
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE n.nspname='public' AND p.proname='support_knowledge_history' AND p.pronargs=0 LIMIT 2`;
export const schemaContextQuery = `SELECT pg_catalog.current_setting('server_version_num')::int AS version,
  ${hash("pg_catalog.jsonb_build_array(d.encoding,d.datlocprovider,d.datcollate,d.datctype,d.datlocale,d.daticurules,d.datcollversion)::text")} AS locale_hash,
  EXISTS(SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name='vector') AS vector_available
  FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`;
export const schemaVectorQuery = `SELECT e.extversion AS version,n.nspname AS namespace FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' LIMIT 2`;
export const schemaUnmanagedQuery = `SELECT least(count(*),1000)::int AS count FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')
  AND NOT c.relname=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid AND d.deptype='e')`;
