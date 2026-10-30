import { readFile } from 'node:fs/promises';
import type pg from 'pg';

const revision = '0001_jobs';
const columnsQuery = `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
  a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS default
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
const constraintsQuery = `SELECT contype AS type, pg_get_constraintdef(oid,true) AS definition
  FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY contype,pg_get_constraintdef(oid,true)`;

export function normalizeConstraintDefinition(definition: string): string {
  // pg_dump/restore may distribute a varchar[] -> text[] cast onto each item.
  // Both forms enforce the same values for the already-verified text/varchar columns.
  // Preserve complete SQL quoted tokens: literal contents are schema semantics.
  let normalized = '';
  let index = 0;
  while (index < definition.length) {
    const character = definition[index];
    if (character === "'" || character === '"') {
      const start = index++;
      const escaped = character === "'" && definition[start - 1]?.toLowerCase() === 'e';
      while (index < definition.length) {
        if (escaped && definition[index] === '\\') { index += 2; continue; }
        if (definition[index++] === character) {
          if (definition[index] === character) { index++; continue; }
          break;
        }
      }
      normalized += definition.slice(start, index);
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(definition.slice(index))?.[0];
      if (delimiter) {
        const end = definition.indexOf(delimiter, index + delimiter.length);
        if (end < 0) return normalized + definition.slice(index);
        normalized += definition.slice(index, end + delimiter.length);
        index = end + delimiter.length;
        continue;
      }
    }
    const cast = /^::(?:character varying|text)(?:\[\])?(?![a-zA-Z0-9_])/.exec(definition.slice(index));
    if (cast) index += cast[0].length;
    else normalized += definition[index++];
  }
  return normalized;
}

export async function migrate(pool: pg.Pool, sql?: string): Promise<void> {
  const source = sql ?? await readFile(new URL('../../migrations/0001_jobs.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('competition-starter-schema'))");
    await client.query('SET LOCAL search_path TO public');
    const tables = await client.query<{ jobs: string | null; alembic: string | null }>(
      "SELECT to_regclass('public.jobs')::text AS jobs, to_regclass('public.alembic_version')::text AS alembic",
    );
    const existing = tables.rows[0]!;
    if (existing.alembic) {
      const versions = await client.query<{ version_num: string }>('SELECT version_num FROM alembic_version');
      if (versions.rows.length !== 1 || versions.rows[0]?.version_num !== revision) {
        throw new Error('Unsupported schema revision; coordinate Python and Node migrations before switching');
      }
      if (!existing.jobs) throw new Error('Revision exists but jobs table is missing');
    }
    if (!existing.jobs) await client.query(source);

    // Compare PostgreSQL's own normalized metadata with an isolated reference table.
    // ON COMMIT DROP affects only this temporary reference, never persisted user data.
    await client.query(`${source.trim().replace('CREATE TABLE jobs', 'CREATE TEMPORARY TABLE node_expected_jobs').replace(/;$/, '')} ON COMMIT DROP`);
    const actualColumns = await client.query(columnsQuery, ['public.jobs']);
    const expectedColumns = await client.query(columnsQuery, ['pg_temp.node_expected_jobs']);
    const actualConstraints = await client.query<{ type: string; definition: string }>(constraintsQuery, ['public.jobs']);
    const expectedConstraints = await client.query<{ type: string; definition: string }>(constraintsQuery, ['pg_temp.node_expected_jobs']);
    const normalizedConstraints = (rows: { type: string; definition: string }[]) => rows.map(row => ({ ...row, definition: normalizeConstraintDefinition(row.definition) }));
    if (JSON.stringify(actualColumns.rows) !== JSON.stringify(expectedColumns.rows) || JSON.stringify(normalizedConstraints(actualConstraints.rows)) !== JSON.stringify(normalizedConstraints(expectedConstraints.rows))) {
      throw new Error('Existing jobs schema is incompatible; no data was changed');
    }
    if (!existing.alembic) {
      await client.query('CREATE TABLE alembic_version(version_num varchar(32) NOT NULL PRIMARY KEY)');
      await client.query('INSERT INTO alembic_version(version_num) VALUES($1)', [revision]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
