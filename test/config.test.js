'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, describeConfig, ConfigError } = require('../src/config');
const { QueryLog } = require('../src/log');

const VALID = {
  server: { host: '127.0.0.1', port: 8787 },
  access: { teamDomain: 'https://conix-example.cloudflareaccess.com', audience: 'aud-tag-value' },
  sql: { server: 'sqlhost', database: 'CONIX', user: 'hub_reader' },
  log: { path: null },
  allowlist: ['dbo.Projects']
};

function writeConfig(overrides, dir) {
  const home = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-cfg-'));
  const config = JSON.parse(JSON.stringify(VALID));
  config.log.path = path.join(home, 'query.jsonl');
  Object.assign(config, overrides || {});
  const file = path.join(home, 'bridge.config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { file, home };
}

const ENV = { BRIDGE_SQL_PASSWORD: 'not-a-real-password' };

test('a valid config loads and applies the documented defaults', () => {
  const { file } = writeConfig();
  const config = loadConfig(file, ENV);
  assert.strictEqual(config.limits.rowCap, 5000);
  assert.strictEqual(config.limits.queryTimeoutMs, 30000);
  assert.strictEqual(config.limits.rateLimitPerMinute, 60);
  assert.strictEqual(config.sql.encrypt, true);
  assert.strictEqual(config.sql.trustServerCertificate, false);
  assert.strictEqual(config.allowlist.has('dbo.projects'), true);
});

test('the password comes from the environment and is never described', () => {
  const { file } = writeConfig();
  const config = loadConfig(file, ENV);
  assert.strictEqual(config.sql.password, 'not-a-real-password');
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes('not-a-real-password'));
  assert.ok(!described.includes(config.access.audience));
});

test('a missing password is a config error', () => {
  const { file } = writeConfig();
  assert.throws(() => loadConfig(file, {}), ConfigError);
});

test('a placeholder left in the config is a config error', () => {
  const { file } = writeConfig({
    sql: { server: '<sql-server-hostname>', database: 'CONIX', user: 'hub_reader' }
  });
  assert.throws(() => loadConfig(file, ENV), /placeholder/);
});

test('a non-loopback host is refused', () => {
  const { file } = writeConfig({ server: { host: '0.0.0.0', port: 8787 } });
  assert.throws(() => loadConfig(file, ENV), /loopback/);
});

test('encryption cannot be turned off', () => {
  const { file } = writeConfig({
    sql: { server: 'sqlhost', database: 'CONIX', user: 'hub_reader', encrypt: false }
  });
  assert.throws(() => loadConfig(file, ENV), /encrypt/);
});

test('a typo in a limit is a config error rather than a silently missing limit', () => {
  const { file } = writeConfig({ limits: { rowCapp: 10 } });
  assert.throws(() => loadConfig(file, ENV), /unknown key "limits.rowCapp"/);
});

test('an unknown top-level key is a config error', () => {
  const { file } = writeConfig({ extra: true });
  assert.throws(() => loadConfig(file, ENV), /unknown top-level key "extra"/);
});

test('an empty allowlist is a config error', () => {
  const { file } = writeConfig({ allowlist: [] });
  assert.throws(() => loadConfig(file, ENV), /allowlist is empty/);
});

test('an allowlist entry with no schema is a config error', () => {
  const { file } = writeConfig({ allowlist: ['Projects'] });
  assert.throws(() => loadConfig(file, ENV), /not schema-qualified/);
});

test('an allowlist file beside the config is read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-cfg-'));
  fs.writeFileSync(path.join(home, 'allowlist.json'), JSON.stringify(['sales.Orders']));
  const { file } = writeConfig({ allowlist: ['dbo.Projects'], allowlistFile: 'allowlist.json' }, home);
  const config = loadConfig(file, ENV);
  assert.strictEqual(config.allowlist.size, 2);
  assert.ok(config.allowlist.has('sales.orders'));
});

test('the shipped example config is a complete, placeholder-only example', () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'bridge.config.example.json'), 'utf8')
  );
  assert.strictEqual(example.server.host, '127.0.0.1');
  assert.strictEqual(example.sql.encrypt, true);
  assert.strictEqual(example.sql.trustServerCertificate, false);
  assert.strictEqual(example.limits.rowCap, 5000);
  assert.strictEqual(example.limits.queryTimeoutMs, 30000);
  assert.strictEqual(example.limits.rateLimitPerMinute, 60);
  for (const value of [example.sql.server, example.sql.database, example.sql.password, example.access.teamDomain, example.access.audience]) {
    assert.ok(String(value).includes('<'), `${value} should be a placeholder`);
  }
});

test('the log writes one JSON object per line and hashes the statement', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-log-'));
  const log = new QueryLog({ path: path.join(home, 'query.jsonl'), maxBytes: 1048576, keep: 3 }).open();
  log.writeQuery({
    caller: 'hub-edge-function.access',
    statement: 'SELECT * FROM dbo.Projects',
    tables: ['dbo.projects'],
    rowCount: 12,
    durationMs: 7,
    outcome: 'ok'
  });
  log.close();
  const lines = fs.readFileSync(path.join(home, 'query.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.strictEqual(record.caller, 'hub-edge-function.access');
  assert.strictEqual(record.rowCount, 12);
  assert.deepStrictEqual(record.tables, ['dbo.projects']);
  assert.match(record.statementSha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(record.statement, 'SELECT * FROM dbo.Projects');
});

test('the log can be told to keep the hash and drop the statement text', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-log-'));
  const log = new QueryLog({
    path: path.join(home, 'query.jsonl'), maxBytes: 1048576, keep: 3, includeStatementText: false
  }).open();
  log.writeQuery({ statement: 'SELECT * FROM dbo.Projects', outcome: 'ok' });
  log.close();
  const record = JSON.parse(fs.readFileSync(path.join(home, 'query.jsonl'), 'utf8').trim());
  assert.strictEqual(record.statement, undefined);
  assert.match(record.statementSha256, /^[0-9a-f]{64}$/);
});

test('the log rotates at the size limit and keeps the generations', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-log-'));
  const file = path.join(home, 'query.jsonl');
  const log = new QueryLog({ path: file, maxBytes: 200, keep: 2 }).open();
  for (let i = 0; i < 20; i += 1) log.writeQuery({ outcome: 'ok', caller: `caller-${i}` });
  log.close();
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(!fs.existsSync(`${file}.4`), 'rotation should not keep more than the configured generations');
});
