'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkStatement, buildAllowlist, normaliseName, RULES } = require('../src/guard');

test('names normalise past brackets, quotes and case', () => {
  assert.strictEqual(normaliseName('[dbo].[Projects]'), 'dbo.projects');
  assert.strictEqual(normaliseName('"dbo"."Projects"'), 'dbo.projects');
  assert.strictEqual(normaliseName(' DBO . Projects '), 'dbo.projects');
  assert.strictEqual(normaliseName('CONIX.dbo.Legacy'), 'conix.dbo.legacy');
});

test('an allowlist entry must be schema-qualified', () => {
  assert.throws(() => buildAllowlist(['Projects']), /not schema-qualified/);
  assert.doesNotThrow(() => buildAllowlist(['dbo.Projects']));
});

test('the allowlist is matched case-insensitively and past brackets', () => {
  const allowlist = buildAllowlist(['dbo.Projects']);
  for (const statement of [
    'SELECT * FROM dbo.Projects',
    'SELECT * FROM DBO.PROJECTS',
    'SELECT * FROM [dbo].[Projects]'
  ]) {
    assert.strictEqual(checkStatement(statement, { allowlist }).ok, true, statement);
  }
});

test('a near-miss on the schema is refused', () => {
  const allowlist = buildAllowlist(['dbo.Projects']);
  const verdict = checkStatement('SELECT * FROM other.Projects', { allowlist });
  assert.strictEqual(verdict.rule, RULES.NOT_ALLOWLISTED);
  assert.strictEqual(verdict.detail, 'other.projects');
});

test('a two-part allowlist entry does not admit a three-part name', () => {
  const allowlist = buildAllowlist(['dbo.Projects']);
  const verdict = checkStatement('SELECT * FROM OtherDb.dbo.Projects', { allowlist });
  assert.strictEqual(verdict.rule, RULES.NOT_ALLOWLISTED);
});

test('every table in the statement is checked, not just the first', () => {
  const allowlist = buildAllowlist(['dbo.Projects']);
  const verdict = checkStatement(
    'SELECT * FROM dbo.Projects p JOIN dbo.Secrets s ON s.id = p.id',
    { allowlist }
  );
  assert.strictEqual(verdict.rule, RULES.NOT_ALLOWLISTED);
  assert.strictEqual(verdict.detail, 'dbo.secrets');
});

test('an accepted statement reports the table set it read', () => {
  const allowlist = buildAllowlist(['dbo.Projects', 'sales.Orders']);
  const verdict = checkStatement(
    'SELECT * FROM dbo.Projects p JOIN sales.Orders o ON o.pid = p.id',
    { allowlist }
  );
  assert.deepStrictEqual(verdict.tables, ['dbo.projects', 'sales.orders']);
});

test('a CTE name is not mistaken for an unallowlisted table', () => {
  const allowlist = buildAllowlist(['dbo.Projects']);
  const verdict = checkStatement(
    'WITH recent AS (SELECT id FROM dbo.Projects) SELECT * FROM recent',
    { allowlist }
  );
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.tables, ['dbo.projects']);
});

test('an empty allowlist refuses every statement that names a table', () => {
  const allowlist = buildAllowlist([]);
  assert.strictEqual(checkStatement('SELECT * FROM dbo.Projects', { allowlist }).rule, RULES.NOT_ALLOWLISTED);
});
