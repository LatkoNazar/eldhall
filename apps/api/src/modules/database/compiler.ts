import { createHash } from 'node:crypto';
import { parse } from 'pgsql-ast-parser';
import { DatabaseInvestigationError, type DatabaseInvestigationSourceConfig, type DatabaseRelation, type DatabaseScope } from './contracts.js';

type Node = Record<string, unknown>;
const refuse = (): never => { throw new DatabaseInvestigationError('invalid_query'); };
const record = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : refuse();
const keys = (node: Node, allowed: string[]) => { if (Object.keys(node).some(key => !allowed.includes(key))) refuse(); };
const list = (value: unknown, max = 100): unknown[] => Array.isArray(value) && value.length <= max ? value : refuse();
export const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const name = (value: unknown): string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value) ? value : refuse();
const binary = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', 'AND', 'OR', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', 'IN', 'NOT IN', 'IS DISTINCT FROM', 'IS NOT DISTINCT FROM']);
const functions = new Set(['count', 'sum', 'avg', 'min', 'max', 'lower', 'upper', 'length', 'round', 'abs', 'date_trunc']);
const specialFunctions = new Set(['coalesce', 'nullif']);

/** Closed SQL profile. Original text is never sent to PostgreSQL; every base ref becomes a scoped materialized CTE. */
export function compileDatabaseQuery(query: string, source: DatabaseInvestigationSourceConfig, relations: DatabaseRelation[], scope: DatabaseScope, maxRows: number) {
  if (typeof query !== 'string' || Buffer.byteLength(query) > 8192 || !query.trim()) refuse();
  let statements: unknown[];
  try { statements = parse(query); } catch { return refuse(); }
  if (statements.length !== 1) refuse();
  const values: unknown[] = [scope.businessId, scope.customerId];
  const used = new Map<string, string>();
  let nodes = 0;
  const parameter = (value: unknown) => { if (values.length >= 102) refuse(); values.push(value); return '$' + values.length; };
  const cte = (table: string): string => {
    const relation = relations.find(row => row.name === table); if (!relation) return refuse();
    if (!used.has(table)) used.set(table, '__eldhall_scope_' + used.size);
    return quoteIdentifier(used.get(table)!);
  };
  type Binding = { alias: string; columns: string[] };
  const select = (input: unknown, depth = 0): { sql: string; columns: string[] } => {
    const node = record(input); if (depth > 8 || ++nodes > 600 || node.type !== 'select') refuse();
    keys(node, ['type', 'columns', 'from', 'where', 'groupBy', 'having', 'orderBy', 'limit', 'distinct']);
    const bindings: Binding[] = [];
    const expr = (input: unknown, level = 0): string => {
      const item = record(input); if (level > 20 || ++nodes > 600) refuse();
      switch (item.type) {
        case 'ref': {
          keys(item, ['type', 'name', 'table']); const column = item.name;
          if (column === '*') return refuse();
          if (item.table) { const table = record(item.table); keys(table, ['name']); return quoteIdentifier(name(table.name)) + '.' + quoteIdentifier(name(column)); }
          return quoteIdentifier(name(column));
        }
        case 'string': keys(item, ['type', 'value']); return typeof item.value === 'string' && item.value.length <= 4000 ? parameter(item.value) : refuse();
        case 'integer': keys(item, ['type', 'value']); return Number.isSafeInteger(item.value) ? parameter(item.value) : refuse();
        // The parser stores numeric literals as JS doubles. Refuse lossy decimals; quoted values are bound exactly and PostgreSQL infers the column type.
        case 'numeric': return refuse();
        case 'boolean': keys(item, ['type', 'value']); return typeof item.value === 'boolean' ? parameter(item.value) : refuse();
        case 'null': keys(item, ['type']); return 'NULL';
        case 'binary': {
          keys(item, ['type', 'left', 'right', 'op']); if (typeof item.op !== 'string' || !binary.has(item.op)) refuse();
          const right = record(item.right); const rhs = right.type === 'select' ? '(' + select(right, depth + 1).sql + ')' : right.type === 'list' && ['IN', 'NOT IN'].includes(String(item.op)) ? '(' + list(right.expressions, 50).map(value => expr(value, level + 1)).join(',') + ')' : expr(right, level + 1);
          if (right.type === 'list') keys(right, ['type', 'expressions']);
          return '(' + expr(item.left, level + 1) + ' ' + item.op + ' ' + rhs + ')';
        }
        case 'unary': keys(item, ['type', 'operand', 'op']); if (!['NOT', '+', '-', 'IS NULL', 'IS NOT NULL', 'IS TRUE', 'IS FALSE', 'IS NOT TRUE', 'IS NOT FALSE'].includes(String(item.op))) refuse(); return ['NOT', '+', '-'].includes(String(item.op)) ? '(' + item.op + ' ' + expr(item.operand, level + 1) + ')' : '(' + expr(item.operand, level + 1) + ' ' + item.op + ')';
        case 'ternary': keys(item, ['type', 'value', 'lo', 'hi', 'op']); if (!['BETWEEN', 'NOT BETWEEN'].includes(String(item.op))) refuse(); return '(' + expr(item.value, level + 1) + ' ' + item.op + ' ' + expr(item.lo, level + 1) + ' AND ' + expr(item.hi, level + 1) + ')';
        case 'call': {
          keys(item, ['type', 'function', 'args', 'distinct']); const fn = record(item.function); keys(fn, ['name', 'schema']);
          const functionName = name(fn.name).toLowerCase(); if (fn.schema !== undefined && fn.schema !== 'pg_catalog') refuse();
          if (!functions.has(functionName) && !specialFunctions.has(functionName)) refuse();
          if (item.distinct !== undefined && item.distinct !== 'distinct') refuse();
          const args = list(item.args, 10);
          const text = args.map(value => functionName === 'count' && args.length === 1 && JSON.stringify(value) === '{"type":"ref","name":"*"}' ? '*' : expr(value, level + 1)).join(',');
          return (specialFunctions.has(functionName) ? functionName : 'pg_catalog.' + quoteIdentifier(functionName)) + '(' + (item.distinct ? 'DISTINCT ' : '') + text + ')';
        }
        case 'select': return '(' + select(item, depth + 1).sql + ')';
        default: return refuse();
      }
    };
    const from = node.from === undefined ? [] : list(node.from, 8).map((value, index) => {
      const item = record(value); let sql: string;
      if (item.type === 'table') {
        keys(item, ['type', 'name', 'join']); const table = record(item.name); keys(table, ['name', 'schema', 'alias']);
        if (table.schema !== undefined && table.schema !== source.schema) refuse();
        const relationName = name(table.name), relation = relations.find(row => row.name === relationName); if (!relation) refuse();
        const alias = name(table.alias ?? relationName); if (alias.startsWith('__eldhall_') || bindings.some(row => row.alias === alias)) refuse();
        bindings.push({ alias, columns: relation!.columns.map(column => column.name) }); sql = cte(relationName) + ' AS ' + quoteIdentifier(alias);
      } else if (item.type === 'statement') {
        keys(item, ['type', 'statement', 'alias', 'join']); const nested = select(item.statement, depth + 1), alias = name(item.alias);
        if (alias.startsWith('__eldhall_') || bindings.some(row => row.alias === alias)) refuse(); bindings.push({ alias, columns: nested.columns }); sql = '(' + nested.sql + ') AS ' + quoteIdentifier(alias);
      } else return refuse();
      if (!item.join) return index === 0 ? sql : ', ' + sql;
      const join = record(item.join); keys(join, ['type', 'on']); if (!index || !['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'].includes(String(join.type))) refuse();
      if (join.type === 'CROSS JOIN') { if (join.on) refuse(); return ' CROSS JOIN ' + sql; }
      return ' ' + join.type + ' ' + sql + ' ON ' + expr(join.on);
    }).join('');
    const outputNames: string[] = [];
    const columns = list(node.columns, 40).flatMap(value => {
      const column = record(value); keys(column, ['expr', 'alias']); const e = record(column.expr);
      if (e.type === 'ref' && e.name === '*') {
        keys(e, ['type', 'name', 'table']); if (column.alias) refuse();
        let selected = bindings;
        if (e.table) { const table = record(e.table); keys(table, ['name']); selected = bindings.filter(row => row.alias === name(table.name)); }
        if (!selected.length) refuse(); return selected.flatMap(binding => binding.columns.map(key => { outputNames.push(key); return quoteIdentifier(binding.alias) + '.' + quoteIdentifier(key); }));
      }
      const alias = column.alias ? record(column.alias) : undefined; if (alias) keys(alias, ['name']);
      outputNames.push(alias ? name(alias.name) : e.type === 'ref' ? name(e.name) : e.type === 'call' ? name(record(e.function).name).toLowerCase() : '?column?');
      return [expr(e) + (alias ? ' AS ' + quoteIdentifier(name(alias.name)) : '')];
    });
    if (!columns.length || columns.length > 40) refuse();
    if (node.distinct !== undefined && node.distinct !== 'distinct') refuse();
    let sql = 'SELECT ' + (node.distinct ? 'DISTINCT ' : '') + columns.join(',') + (from ? ' FROM ' + from : '');
    if (node.where) sql += ' WHERE ' + expr(node.where);
    if (node.groupBy) sql += ' GROUP BY ' + list(node.groupBy, 20).map(value => expr(value)).join(',');
    if (node.having) sql += ' HAVING ' + expr(node.having);
    if (node.orderBy) sql += ' ORDER BY ' + list(node.orderBy, 20).map(value => { const order = record(value); keys(order, ['by', 'order', 'nulls']); if (order.order !== undefined && !['ASC', 'DESC'].includes(String(order.order))) refuse(); if (order.nulls !== undefined && !['FIRST', 'LAST'].includes(String(order.nulls))) refuse(); return expr(order.by) + (order.order ? ' ' + order.order : '') + (order.nulls ? ' NULLS ' + order.nulls : ''); }).join(',');
    if (node.limit) { const limit = record(node.limit); keys(limit, ['limit', 'offset']); for (const key of ['limit', 'offset']) if (limit[key] !== undefined) { const number = record(limit[key]); keys(number, ['type', 'value']); if (number.type !== 'integer' || !Number.isSafeInteger(number.value) || Number(number.value) < 0 || Number(number.value) > 10000) refuse(); sql += (key === 'limit' ? ' LIMIT ' : ' OFFSET ') + parameter(number.value); } }
    return { sql, columns: outputNames };
  };
  const compiled = select(statements[0]);
  if (!used.size) refuse();
  const entries: string[] = [];
  // Parent CTEs are added before dependent entries, never sourced from model SQL.
  for (const table of [...used.keys()]) { const relation = relations.find(row => row.name === table)!; if (relation.ownership.kind === 'parent') cte(relation.ownership.parentTable); }
  for (const [table, alias] of used) {
    const relation = relations.find(row => row.name === table)!; const owner = relation.ownership;
    const predicate = owner.kind === 'columns' ? `${quoteIdentifier(owner.businessColumn)} = $1::pg_catalog.text::pg_catalog.${quoteIdentifier(name(relation.ownershipTypes?.business ?? relation.columns.find(column => column.name === owner.businessColumn)?.type))} AND ${quoteIdentifier(owner.customerColumn)} = $2::pg_catalog.text::pg_catalog.${quoteIdentifier(name(relation.ownershipTypes?.customer ?? relation.columns.find(column => column.name === owner.customerColumn)?.type))}` : `${quoteIdentifier(owner.foreignKey)} IN (SELECT ${quoteIdentifier(owner.parentKey)} FROM ${cte(owner.parentTable)})`;
    entries.push(`${quoteIdentifier(alias)} AS MATERIALIZED (SELECT ${relation.columns.map(column => quoteIdentifier(column.name)).join(',')} FROM ONLY ${quoteIdentifier(source.schema)}.${quoteIdentifier(table)} WHERE ${predicate})`);
  }
  entries.sort((a, b) => Number(a.includes(' IN (SELECT ')) - Number(b.includes(' IN (SELECT ')));
  const output = compiled.columns.map((_, index) => '__eldhall_col_' + index);
  const projection = output.map(column => `pg_catalog.json_build_array(pg_catalog.pg_typeof(${quoteIdentifier(column)})::pg_catalog.text,pg_catalog.left(${quoteIdentifier(column)}::pg_catalog.text,2049)) AS ${quoteIdentifier(column)}`).join(',');
  return { text: 'WITH ' + entries.join(',') + ' SELECT ' + projection + ' FROM (' + compiled.sql + ') AS "__eldhall_result"(' + output.map(quoteIdentifier).join(',') + ') LIMIT ' + (maxRows + 1), values, relations: [...used.keys()], columns: compiled.columns, queryHash: createHash('sha256').update(query).digest('hex') };
}
