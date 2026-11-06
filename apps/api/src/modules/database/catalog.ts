import type pg from 'pg';
import { DatabaseInvestigationError, type DatabaseInvestigationSourceConfig, type DatabaseRelation } from './contracts.js';

export const SAFE_DATABASE_TYPES = new Set([16, 20, 21, 23, 25, 700, 701, 1042, 1043, 1700, 2950, 1082, 1114, 1184]);
type CatalogRow = { name: string; oid: number; owner: boolean; writable: boolean; kind: string; inherited: boolean; rules: boolean; rls: boolean; columns: { name: string; type: string; oid: number; namespace: string; kind: string; collationNamespace: string | null; description: string | null; selectable: boolean }[] };
export async function assertReadOnlyRole(client: pg.PoolClient) {
  const result = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR current_user <> session_user
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND (c.relowner=r.oid OR pg_catalog.has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR pg_catalog.has_any_column_privilege(c.oid,'INSERT,UPDATE')))
    AS unsafe FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
  if (result.rows.length !== 1 || result.rows[0].unsafe !== false) throw new DatabaseInvestigationError('role_not_readonly');
}

/** Catalog-only discovery. Ownership rules are deployment input; table/column names never come from model grants. */
export async function discoverDatabaseRelations(client: pg.PoolClient, source: DatabaseInvestigationSourceConfig): Promise<DatabaseRelation[]> {
  const result = await client.query<CatalogRow>(`SELECT c.relname name,c.oid::int oid,c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) owner,
    pg_catalog.has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR pg_catalog.has_any_column_privilege(c.oid,'INSERT,UPDATE') writable,
    c.relkind kind,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) inherited,
    c.relhasrules OR EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=idx.relam
      WHERE i.indrelid=c.oid AND (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR am.amname NOT IN ('btree','hash','gin','gist','spgist','brin')
        OR EXISTS(SELECT 1 FROM unnest(i.indclass) oc(oid) JOIN pg_catalog.pg_opclass op ON op.oid=oc.oid JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace WHERE ns.nspname<>'pg_catalog'))) rules,
    c.relrowsecurity OR c.relforcerowsecurity OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) rls,COALESCE((SELECT json_agg(json_build_object('name',a.attname,'type',t.typname,'oid',t.oid::int,'namespace',tn.nspname,'kind',t.typtype,
      'collationNamespace',cn.nspname,'description',left(pg_catalog.col_description(c.oid,a.attnum),160),'selectable',true) ORDER BY a.attnum)
      FROM (SELECT a.* FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND pg_catalog.has_column_privilege(c.oid,a.attnum,'SELECT')
        AND tn.nspname='pg_catalog' AND t.typtype='b' AND t.oid IN (16,20,21,23,25,700,701,1042,1043,1700,2950,1082,1114,1184) ORDER BY a.attnum LIMIT 41) a
      JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
      LEFT JOIN pg_catalog.pg_collation col ON col.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=col.collnamespace
      ),'[]'::json) columns
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname LIMIT 65`, [source.schema]);
  if (result.rows.length > 64) throw new DatabaseInvestigationError('scope_unavailable');
  const relations: DatabaseRelation[] = [];
  for (const row of result.rows) {
    const override = source.relations.find(item => item.table === row.name);
    const ownership = override?.ownership ?? { kind: 'columns' as const, ...source.ownership };
    const usable = row.columns.filter(column => column.selectable && column.namespace === 'pg_catalog' && column.kind === 'b' && SAFE_DATABASE_TYPES.has(column.oid) && (!column.collationNamespace || column.collationNamespace === 'pg_catalog'));
    const required = ownership.kind === 'columns' ? [ownership.customerColumn, ownership.businessColumn] : [ownership.foreignKey];
    if (!required.every(name => usable.some(column => column.name === name))) { if (override) throw new DatabaseInvestigationError('scope_unavailable'); continue; }
    if (row.kind !== 'r' || row.inherited || row.rules || row.rls) { if (override) throw new DatabaseInvestigationError('scope_unavailable'); continue; }
    if (row.owner || row.writable) throw new DatabaseInvestigationError('role_not_readonly');
    const selected = override?.columns ? override.columns.map(name => usable.find(column => column.name === name)) : usable;
    if (!selected.length || selected.length > 40 || selected.some(column => column === undefined)) throw new DatabaseInvestigationError('scope_unavailable');
    relations.push({ name: row.name, oid: row.oid, ownership, ...(ownership.kind === 'columns' ? { ownershipTypes: { business: usable.find(column => column.name === ownership.businessColumn)!.type, customer: usable.find(column => column.name === ownership.customerColumn)!.type } } : {}), columns: selected.map(column => ({ name: column!.name, type: column!.type, oid: column!.oid, description: column!.description })) });
  }
  for (const configured of source.relations) if (!relations.some(row => row.name === configured.table)) throw new DatabaseInvestigationError('scope_unavailable');
  for (const relation of relations) if (relation.ownership.kind === 'parent') {
    const rule = relation.ownership, parent = relations.find(row => row.name === rule.parentTable);
    if (!parent || parent.ownership.kind !== 'columns' || !parent.columns.some(column => column.name === rule.parentKey) || parent.columns.find(column => column.name === rule.parentKey)?.oid !== relation.columns.find(column => column.name === rule.foreignKey)?.oid) throw new DatabaseInvestigationError('scope_unavailable');
    const foreignKey = await client.query(`SELECT 1 FROM pg_catalog.pg_constraint f
      JOIN pg_catalog.pg_attribute child ON child.attrelid=f.conrelid AND child.attnum=f.conkey[1]
      JOIN pg_catalog.pg_attribute parent ON parent.attrelid=f.confrelid AND parent.attnum=f.confkey[1]
      WHERE f.contype='f' AND f.convalidated AND f.conrelid=$1 AND f.confrelid=$2 AND array_length(f.conkey,1)=1 AND array_length(f.confkey,1)=1
        AND child.attname=$3 AND parent.attname=$4 AND EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=f.confrelid
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=1 AND i.indkey[0]=f.confkey[1] AND i.indpred IS NULL) LIMIT 1`, [relation.oid, parent.oid, rule.foreignKey, rule.parentKey]);
    if (foreignKey.rows.length !== 1) throw new DatabaseInvestigationError('scope_unavailable');
  }
  return relations;
}
