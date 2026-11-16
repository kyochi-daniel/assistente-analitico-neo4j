// shortcut: subconjunto conservador de Cypher; adote um parser antes de ampliar a gramática aceita.
const forbidden = /\b(CALL|LOAD|CSV|CREATE|INSERT|MERGE|SET|REMOVE|DELETE|DETACH|FOREACH|DROP|ALTER|RENAME|GRANT|DENY|REVOKE|SHOW|TERMINATE|START|STOP|USE|CYPHER|EXPLAIN|PROFILE|UNION|TRANSACTIONS|FINISH|LET|USING|COMMIT)\b/i;
const functions = new Set([
  'MATCH', 'WHERE', 'WITH', 'RETURN', 'AND', 'OR', 'NOT', 'IN',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'ABS', 'CEIL', 'FLOOR',
  'COALESCE', 'TOFLOAT', 'TOINTEGER', 'TOSTRING', 'TOLOWER', 'TOUPPER',
  'SIZE', 'LENGTH', 'TYPE', 'LABELS', 'DISTINCT', 'DATE', 'DATETIME',
]);

export function assertReadOnlyCypher(query: string): string {
  if (typeof query !== 'string' || !query.trim() || query.length > 8_000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f;`\\{}]|\/\/|\/\*|\*\//.test(query)) {
    throw new Error('Cypher fora do subconjunto de leitura permitido.');
  }
  // Mascara literais sem permitir que aspas incompletas escondam cláusulas.
  let source = '';
  let quote = '';
  for (const char of query) {
    if (quote) {
      if (char === quote) quote = '';
      source += ' ';
    } else if (char === '"' || char === "'") {
      quote = char;
      source += ' ';
    } else {
      source += char;
    }
  }
  if (quote || /[^\x20-\x7e\t\r\n]/.test(source) || !/^\s*(MATCH\b|OPTIONAL\s+MATCH\b|RETURN\b)/i.test(source) ||
      !/\bRETURN\b/i.test(source) || forbidden.test(source) ||
      /\[[^\]]*\*/.test(source)) {
    throw new Error('Cypher fora do subconjunto de leitura permitido.');
  }
  for (const match of source.matchAll(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
    if (!functions.has(match[1].toUpperCase())) {
      throw new Error('Função Cypher não permitida.');
    }
  }
  return query.trim();
}
