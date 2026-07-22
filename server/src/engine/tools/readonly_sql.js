function maskSqlLiterals(sql) {
  return String(sql || '')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``')
    .replace(/\[(?:\]\]|[^\]])*\]/g, '[]');
}

/** 只允许单条只读查询。WITH 允许，但其中仍不能包含写操作。 */
export function assertReadOnlySql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) throw new Error('SQL 不能为空');
  const masked = maskSqlLiterals(raw).trim();
  if (!/^(select|with)\b/i.test(masked)) throw new Error('只允许 SELECT 或 WITH 查询');
  const withoutFinalSemicolon = masked.replace(/;\s*$/, '');
  if (withoutFinalSemicolon.includes(';')) throw new Error('一次只能执行一条 SQL');
  const forbidden = /\b(insert|update|delete|merge|replace|upsert|drop|alter|create|truncate|attach|detach|pragma|vacuum|copy|call|execute|grant|revoke)\b/i;
  const found = forbidden.exec(withoutFinalSemicolon);
  if (found) throw new Error(`SQL 包含不允许的操作: ${found[1].toUpperCase()}`);
  const externalAccess = /\b(read_csv(?:_auto)?|read_json(?:_auto)?|read_parquet|read_blob|glob|sqlite_scan|postgres_scan|mysql_scan|load_extension)\s*\(/i;
  const externalFound = externalAccess.exec(withoutFinalSemicolon);
  if (externalFound) throw new Error(`SQL 包含不允许的外部访问函数: ${externalFound[1]}`);
  return raw;
}
