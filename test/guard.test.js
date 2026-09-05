'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkStatement, buildAllowlist, RULES } = require('../src/guard');

const allowlist = buildAllowlist([
  'dbo.Projects',
  '[dbo].[Project Lines]',
  'sales.Orders',
  'CONIX.dbo.Legacy'
]);

const check = (statement) => checkStatement(statement, { allowlist });

/**
 * The accepted corpus. Every one of these is a shape the hub is expected to
 * compose, and a change that refuses one of them is a regression the client
 * would feel as "it says no to a normal question".
 */
const ACCEPTED = [
  ['a bare select', 'SELECT 1'],
  ['a simple read', 'SELECT * FROM dbo.Projects'],
  ['TOP with a predicate', "SELECT TOP 50 name FROM dbo.Projects WHERE status = 'open'"],
  ['a join across two allowlisted tables', 'SELECT p.id FROM dbo.Projects p JOIN sales.Orders o ON o.pid = p.id'],
  ['a common table expression', 'WITH recent AS (SELECT id FROM dbo.Projects) SELECT * FROM recent'],
  ['a union of allowlisted tables', 'SELECT id FROM dbo.Projects UNION SELECT pid FROM sales.Orders'],
  ['an aggregate', 'SELECT COUNT(*) AS n FROM dbo.Projects'],
  ['a bracketed identifier with a space', 'SELECT * FROM [dbo].[Project Lines]'],
  ['a three-part name', 'SELECT * FROM CONIX.dbo.Legacy'],
  ['lower case', 'select * from dbo.projects'],
  ['a semicolon terminator', 'SELECT * FROM dbo.Projects;'],
  ['a semicolon inside a literal', "SELECT * FROM dbo.Projects WHERE note = 'a;b'"],
  ['a comment', 'SELECT id /* the id */ FROM dbo.Projects -- trailing'],
  ['a nested comment', 'SELECT /* a /* b */ c */ id FROM dbo.Projects'],
  ['an escaped quote', "SELECT * FROM dbo.Projects WHERE note = 'it''s fine'"],
  ['a scalar subquery on an allowlisted table', 'SELECT (SELECT COUNT(*) FROM sales.Orders) AS n FROM dbo.Projects'],
  ['paging', 'SELECT id FROM dbo.Projects ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY']
];

/**
 * The refused corpus. Each row names the rule the refusal must carry, because
 * the rule name is what reaches the log and the client's IT, and "it was
 * refused somehow" is not the promise the plan makes.
 */
const REFUSED = [
  ['an empty statement', '', RULES.EMPTY],
  ['whitespace only', '   \n  ', RULES.EMPTY],
  ['a second statement', 'SELECT * FROM dbo.Projects; DROP TABLE dbo.Projects', RULES.MULTIPLE_STATEMENTS],
  ['a leading semicolon', '; SELECT * FROM dbo.Projects', RULES.MULTIPLE_STATEMENTS],
  ['a stacked select', 'SELECT 1; SELECT 2', RULES.MULTIPLE_STATEMENTS],
  ['EXEC', 'EXEC dbo.SomeProc', RULES.BANNED_EXEC],
  ['EXECUTE', 'EXECUTE dbo.SomeProc', RULES.BANNED_EXEC],
  ['a stored procedure call in a subquery', 'SELECT * FROM dbo.Projects WHERE 1 = (EXEC dbo.p)', RULES.BANNED_EXEC],
  ['an xp_ name', 'SELECT * FROM dbo.Projects WHERE 1 = xp_cmdshell(1)', RULES.BANNED_XP],
  ['an sp_ name', 'SELECT * FROM sp_helpuser', RULES.BANNED_SP],
  ['OPENROWSET', "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')", RULES.BANNED_OPENROWSET],
  ['OPENQUERY', 'SELECT * FROM OPENQUERY(LINKED, \'SELECT 1\')', RULES.BANNED_OPENQUERY],
  ['OPENDATASOURCE', "SELECT * FROM OPENDATASOURCE('x','y').db.dbo.t", RULES.BANNED_ROWSET_FUNCTION],
  ['OPENXML', 'SELECT * FROM OPENXML(1, \'/x\', 2)', RULES.BANNED_ROWSET_FUNCTION],
  ['an UPDATE', 'UPDATE dbo.Projects SET name = 1', RULES.BANNED_WRITE],
  ['an INSERT', "INSERT INTO dbo.Projects (name) VALUES ('x')", RULES.BANNED_WRITE],
  ['a DELETE', 'DELETE FROM dbo.Projects', RULES.BANNED_WRITE],
  ['a MERGE', 'MERGE dbo.Projects AS t USING dbo.Projects AS s ON 1=1', RULES.BANNED_WRITE],
  ['a DROP', 'DROP TABLE dbo.Projects', RULES.BANNED_WRITE],
  ['an ALTER', 'ALTER TABLE dbo.Projects ADD x INT', RULES.BANNED_WRITE],
  ['a CREATE', 'CREATE TABLE dbo.X (a INT)', RULES.BANNED_WRITE],
  ['a TRUNCATE', 'TRUNCATE TABLE dbo.Projects', RULES.BANNED_WRITE],
  ['a GRANT', 'GRANT SELECT ON dbo.Projects TO hub_reader', RULES.BANNED_WRITE],
  ['a BACKUP', 'BACKUP DATABASE CONIX TO DISK = \'x\'', RULES.BANNED_WRITE],
  ['a SHUTDOWN', 'SHUTDOWN', RULES.BANNED_WRITE],
  ['DBCC', 'DBCC CHECKDB', RULES.BANNED_WRITE],
  ['a batch separator', 'SELECT * FROM dbo.Projects\nGO\nSELECT 1', RULES.BANNED_BATCH_SEPARATOR],
  ['SELECT INTO', 'SELECT id INTO dbo.Copy FROM dbo.Projects', RULES.BANNED_SELECT_INTO],
  ['USE', 'USE master', RULES.BANNED_CONTROL_FLOW],
  ['DECLARE', 'DECLARE @x INT', RULES.BANNED_CONTROL_FLOW],
  ['SET', 'SET NOCOUNT ON', RULES.BANNED_CONTROL_FLOW],
  ['WAITFOR', "WAITFOR DELAY '00:00:10'", RULES.BANNED_CONTROL_FLOW],
  ['a transaction', 'BEGIN TRAN', RULES.BANNED_CONTROL_FLOW],
  ['a global variable', 'SELECT @@VERSION', RULES.BANNED_VARIABLE],
  ['a local variable', 'SELECT * FROM dbo.Projects WHERE id = @id', RULES.BANNED_VARIABLE],
  ['an unterminated literal', "SELECT * FROM dbo.Projects WHERE n = 'x", RULES.UNTERMINATED_LITERAL],
  ['an unterminated block comment', 'SELECT * FROM dbo.Projects /* x', RULES.UNTERMINATED_COMMENT],
  ['an unterminated bracket', 'SELECT * FROM [dbo].[Projects', RULES.UNTERMINATED_IDENTIFIER],
  ['an over-long statement', `SELECT * FROM dbo.Projects WHERE n = '${'x'.repeat(9000)}'`, RULES.TOO_LONG],
  ['a table with no schema', 'SELECT * FROM Projects', RULES.UNQUALIFIED_TABLE],
  ['a table that is not on the allowlist', 'SELECT * FROM dbo.Salaries', RULES.NOT_ALLOWLISTED],
  ['a non-allowlisted table in a subquery', 'SELECT * FROM dbo.Projects WHERE id IN (SELECT id FROM hr.Salaries)', RULES.NOT_ALLOWLISTED],
  ['a non-allowlisted table in a join', 'SELECT * FROM dbo.Projects p JOIN hr.Salaries s ON 1=1', RULES.NOT_ALLOWLISTED],
  ['a non-allowlisted table in a CTE body', 'WITH c AS (SELECT * FROM hr.Salaries) SELECT * FROM c', RULES.NOT_ALLOWLISTED],
  ['gibberish', 'not a statement at all', RULES.PARSE_FAILED]
];

test('the accepted corpus is accepted', async (t) => {
  for (const [name, statement] of ACCEPTED) {
    await t.test(name, () => {
      const verdict = check(statement);
      assert.strictEqual(
        verdict.ok,
        true,
        `expected acceptance, got ${verdict.rule}: ${verdict.message}`
      );
      assert.ok(Array.isArray(verdict.tables));
    });
  }
});

test('the refused corpus is refused, each naming its rule', async (t) => {
  for (const [name, statement, rule] of REFUSED) {
    await t.test(name, () => {
      const verdict = check(statement);
      assert.strictEqual(verdict.ok, false, 'expected a refusal');
      assert.strictEqual(verdict.rule, rule);
      assert.ok(typeof verdict.message === 'string' && verdict.message.length > 0);
    });
  }
});

test('every rule the corpus can reach is exercised by it', () => {
  const covered = new Set(REFUSED.map(([, , rule]) => rule));
  const unreachable = new Set([RULES.NOT_SELECT]);
  const missing = Object.values(RULES).filter((r) => !covered.has(r) && !unreachable.has(r));
  assert.deepStrictEqual(missing, [], `rules with no test: ${missing.join(', ')}`);
});

test('a refusal never leaks the statement back in the message', () => {
  const verdict = check("SELECT * FROM dbo.Salaries WHERE ssn = '123'");
  assert.strictEqual(verdict.ok, false);
  assert.ok(!verdict.message.includes('123'));
});

test('the corpus is large enough to be a corpus', () => {
  assert.ok(ACCEPTED.length >= 15, `accepted: ${ACCEPTED.length}`);
  assert.ok(REFUSED.length >= 40, `refused: ${REFUSED.length}`);
});
