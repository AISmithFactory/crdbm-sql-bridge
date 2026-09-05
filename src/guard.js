'use strict';

const { Parser } = require('node-sql-parser');
const { scan } = require('./tokeniser');

const PARSER_OPTIONS = { database: 'transactsql' };

/**
 * Every refusal names exactly one rule, and that name is what goes in the log
 * and in the 400 body. The client's IT reads these names; do not rename one
 * without saying so in the README.
 */
const RULES = {
  EMPTY: 'empty-statement',
  TOO_LONG: 'statement-too-long',
  UNTERMINATED_LITERAL: 'unterminated-literal',
  UNTERMINATED_IDENTIFIER: 'unterminated-identifier',
  UNTERMINATED_COMMENT: 'unterminated-comment',
  MULTIPLE_STATEMENTS: 'multiple-statements',
  BANNED_EXEC: 'banned-exec',
  BANNED_XP: 'banned-xp-prefix',
  BANNED_SP: 'banned-sp-prefix',
  BANNED_OPENROWSET: 'banned-openrowset',
  BANNED_OPENQUERY: 'banned-openquery',
  BANNED_ROWSET_FUNCTION: 'banned-rowset-function',
  BANNED_WRITE: 'banned-write-verb',
  BANNED_CONTROL_FLOW: 'banned-control-flow',
  BANNED_BATCH_SEPARATOR: 'banned-batch-separator',
  BANNED_SELECT_INTO: 'banned-select-into',
  BANNED_VARIABLE: 'banned-variable',
  PARSE_FAILED: 'parse-failed',
  NOT_SELECT: 'not-a-select',
  UNQUALIFIED_TABLE: 'unqualified-table',
  NOT_ALLOWLISTED: 'table-not-allowlisted'
};

/** word -> rule. Checked against unquoted tokens only. */
const BANNED_WORDS = new Map(
  Object.entries({
    exec: RULES.BANNED_EXEC,
    execute: RULES.BANNED_EXEC,
    openrowset: RULES.BANNED_OPENROWSET,
    openquery: RULES.BANNED_OPENQUERY,
    opendatasource: RULES.BANNED_ROWSET_FUNCTION,
    openxml: RULES.BANNED_ROWSET_FUNCTION,
    openjson: RULES.BANNED_ROWSET_FUNCTION,
    go: RULES.BANNED_BATCH_SEPARATOR,
    into: RULES.BANNED_SELECT_INTO,
    insert: RULES.BANNED_WRITE,
    update: RULES.BANNED_WRITE,
    delete: RULES.BANNED_WRITE,
    merge: RULES.BANNED_WRITE,
    drop: RULES.BANNED_WRITE,
    alter: RULES.BANNED_WRITE,
    create: RULES.BANNED_WRITE,
    truncate: RULES.BANNED_WRITE,
    grant: RULES.BANNED_WRITE,
    revoke: RULES.BANNED_WRITE,
    deny: RULES.BANNED_WRITE,
    backup: RULES.BANNED_WRITE,
    restore: RULES.BANNED_WRITE,
    shutdown: RULES.BANNED_WRITE,
    reconfigure: RULES.BANNED_WRITE,
    checkpoint: RULES.BANNED_WRITE,
    kill: RULES.BANNED_WRITE,
    dbcc: RULES.BANNED_WRITE,
    bulk: RULES.BANNED_WRITE,
    use: RULES.BANNED_CONTROL_FLOW,
    declare: RULES.BANNED_CONTROL_FLOW,
    set: RULES.BANNED_CONTROL_FLOW,
    setuser: RULES.BANNED_CONTROL_FLOW,
    revert: RULES.BANNED_CONTROL_FLOW,
    waitfor: RULES.BANNED_CONTROL_FLOW,
    begin: RULES.BANNED_CONTROL_FLOW,
    commit: RULES.BANNED_CONTROL_FLOW,
    rollback: RULES.BANNED_CONTROL_FLOW,
    print: RULES.BANNED_CONTROL_FLOW,
    throw: RULES.BANNED_CONTROL_FLOW,
    goto: RULES.BANNED_CONTROL_FLOW,
    while: RULES.BANNED_CONTROL_FLOW,
    return: RULES.BANNED_CONTROL_FLOW
  })
);

const DEFAULTS = { maxStatementLength: 8000 };

function refuse(rule, message, detail) {
  return { ok: false, rule, message, detail: detail === undefined ? null : detail };
}

/** `[dbo].[Projects]` and ` DBO.Projects ` both normalise to `dbo.projects`. */
function normaliseName(name) {
  return String(name)
    .split('.')
    .map((part) => part.trim().replace(/^\[(.*)\]$/s, '$1').replace(/^"(.*)"$/s, '$1').trim())
    .filter((part) => part.length > 0)
    .join('.')
    .toLowerCase();
}

function buildAllowlist(entries) {
  const set = new Set();
  for (const entry of entries || []) {
    const key = normaliseName(entry);
    if (key.split('.').length < 2) {
      throw new Error(`allowlist entry "${entry}" is not schema-qualified`);
    }
    set.add(key);
  }
  return set;
}

function lexicalPass(sql, limits) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return refuse(RULES.EMPTY, 'the statement is empty');
  }
  if (sql.length > limits.maxStatementLength) {
    return refuse(
      RULES.TOO_LONG,
      `the statement is ${sql.length} characters, over the ${limits.maxStatementLength} limit`
    );
  }

  const scanned = scan(sql);
  if (scanned.open) {
    return refuse(scanned.open, 'the statement ends inside a literal, identifier or comment');
  }

  for (const pos of scanned.semicolons) {
    if (scanned.scrubbed.slice(pos + 1).trim().length > 0) {
      return refuse(
        RULES.MULTIPLE_STATEMENTS,
        'more than one statement: text follows a semicolon'
      );
    }
  }

  for (const token of scanned.tokens) {
    const lower = token.word.toLowerCase();
    if (lower.startsWith('xp_')) {
      return refuse(RULES.BANNED_XP, `"${token.word}" is an xp_ name`, token.word);
    }
    if (lower.startsWith('sp_')) {
      return refuse(RULES.BANNED_SP, `"${token.word}" is an sp_ name`, token.word);
    }
    if (token.quoted) continue;
    const rule = BANNED_WORDS.get(lower);
    if (rule) {
      return refuse(rule, `"${token.word}" is not accepted in a read statement`, token.word);
    }
  }

  if (scanned.sigils.length > 0) {
    return refuse(RULES.BANNED_VARIABLE, 'variables and @@ globals are not accepted');
  }

  return { ok: true, scanned };
}

function collectCteNames(ast) {
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.with)) {
      for (const cte of node.with) {
        const value = cte && cte.name && (cte.name.value !== undefined ? cte.name.value : cte.name);
        if (typeof value === 'string') names.add(value.toLowerCase());
      }
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(ast);
  return names;
}

function structuralPass(sql, allowlist) {
  const parser = new Parser();
  let parsed;
  try {
    parsed = parser.parse(sql, PARSER_OPTIONS);
  } catch (err) {
    return refuse(RULES.PARSE_FAILED, 'the statement did not parse as T-SQL', String(err.message).slice(0, 200));
  }

  const asts = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  if (asts.length !== 1) {
    return refuse(RULES.MULTIPLE_STATEMENTS, `the request carried ${asts.length} statements`);
  }
  if (!asts[0] || asts[0].type !== 'select') {
    return refuse(RULES.NOT_SELECT, `the statement is a ${asts[0] ? asts[0].type : 'unknown'}, not a SELECT`);
  }

  const cteNames = collectCteNames(parsed.ast);
  const tables = [];
  for (const entry of parsed.tableList || []) {
    const [action, db, table] = String(entry).split('::');
    if (action !== 'select') {
      return refuse(RULES.NOT_SELECT, `the statement would ${action} "${table}"`, table);
    }
    const bareTable = normaliseName(table);
    const hasSchema = db && db !== 'null';
    if (!hasSchema) {
      if (cteNames.has(bareTable)) continue;
      return refuse(
        RULES.UNQUALIFIED_TABLE,
        `"${table}" is not schema-qualified; the allowlist is checked on schema.table`,
        table
      );
    }
    const key = `${normaliseName(db)}.${bareTable}`;
    if (!allowlist.has(key)) {
      return refuse(RULES.NOT_ALLOWLISTED, `"${key}" is not on the allowlist`, key);
    }
    if (!tables.includes(key)) tables.push(key);
  }

  return { ok: true, tables: tables.sort() };
}

/**
 * @param {string} sql one statement
 * @param {{allowlist: Set<string>, maxStatementLength?: number}} options
 * @returns {{ok: true, tables: string[]} | {ok: false, rule: string, message: string, detail: ?string}}
 */
function checkStatement(sql, options) {
  const limits = {
    maxStatementLength: options.maxStatementLength || DEFAULTS.maxStatementLength
  };
  const lexical = lexicalPass(sql, limits);
  if (!lexical.ok) return lexical;
  return structuralPass(sql, options.allowlist);
}

module.exports = { checkStatement, buildAllowlist, normaliseName, RULES, DEFAULTS };
