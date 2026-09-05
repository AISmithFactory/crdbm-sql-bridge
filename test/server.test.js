'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');
const { createServer } = require('../src/server');
const { AccessVerifier, HEADER } = require('../src/access');
const { QueryLog } = require('../src/log');
const { buildAllowlist } = require('../src/guard');

const TEAM = 'https://conix-example.cloudflareaccess.com';
const AUD = 'aud-tag-for-the-test';

class FakeRequest extends EventEmitter {
  constructor(rows, delayMs) {
    super();
    this.rows = rows;
    this.delayMs = delayMs || 0;
    this.cancelled = false;
    this.stream = false;
  }

  query() {
    setTimeout(() => {
      for (const row of this.rows) {
        if (this.cancelled) break;
        this.emit('row', row);
      }
      this.emit('done');
    }, this.delayMs);
  }

  cancel() {
    this.cancelled = true;
  }
}

function baseConfig(logPath, overrides) {
  return {
    server: { host: '127.0.0.1', port: 0, maxBodyBytes: 2048 },
    access: { teamDomain: TEAM, audience: AUD },
    limits: {
      rowCap: 5000, queryTimeoutMs: 30000, maxStatementLength: 8000, rateLimitPerMinute: 60,
      ...(overrides && overrides.limits)
    },
    log: { path: logPath, maxBytes: 1048576, keep: 2, includeStatementText: true },
    health: { requireAccessJwt: false },
    allowlist: buildAllowlist(['dbo.Projects'])
  };
}

async function harness(options) {
  const opts = options || {};
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const verifier = new AccessVerifier({
    teamDomain: TEAM, audience: AUD, keySet: createLocalJWKSet({ keys: [jwk] })
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crdbm-srv-'));
  const logPath = path.join(home, 'query.jsonl');
  const queryLog = new QueryLog({ path: logPath, maxBytes: 1048576, keep: 2 }).open();
  const config = baseConfig(logPath, opts);
  const server = createServer({
    config,
    verifier,
    queryLog,
    requestFactory: () => new FakeRequest(opts.rows || [{ id: 1 }], opts.delayMs || 0)
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = await new SignJWT({ common_name: 'hub-edge-function.access' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime('5m')
    .sign(privateKey);
  return {
    base,
    token,
    logPath,
    readLog: () => fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    stop: () => new Promise((resolve) => { queryLog.close(); server.close(resolve); })
  };
}

const post = (base, body, headers) =>
  fetch(`${base}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });

test('an allowlisted select returns rows and is logged', async () => {
  const h = await harness({ rows: [{ id: 1 }, { id: 2 }] });
  try {
    const res = await post(h.base, { statement: 'SELECT * FROM dbo.Projects' }, { [HEADER]: h.token });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.rowCount, 2);
    assert.strictEqual(body.truncated, false);
    assert.deepStrictEqual(body.tables, ['dbo.projects']);
    const record = h.readLog().at(-1);
    assert.strictEqual(record.outcome, 'ok');
    assert.strictEqual(record.caller, 'hub-edge-function.access');
    assert.strictEqual(record.rowCount, 2);
    assert.match(record.statementSha256, /^[0-9a-f]{64}$/);
  } finally {
    await h.stop();
  }
});

test('a request with no Access assertion never reaches the guard', async () => {
  const h = await harness();
  try {
    const res = await post(h.base, { statement: 'SELECT * FROM dbo.Projects' });
    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.strictEqual(body.error, 'access-denied');
    assert.strictEqual(body.reason, 'missing-access-assertion');
    const record = h.readLog().at(-1);
    assert.strictEqual(record.event, 'access-denied');
    assert.strictEqual(record.statementSha256, null, 'the statement should not have been read');
  } finally {
    await h.stop();
  }
});

test('a refused statement returns 400 naming the rule, and is logged with it', async () => {
  const h = await harness();
  try {
    const res = await post(h.base, { statement: 'DROP TABLE dbo.Projects' }, { [HEADER]: h.token });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'refused');
    assert.strictEqual(body.rule, 'banned-write-verb');
    const record = h.readLog().at(-1);
    assert.strictEqual(record.outcome, 'refused');
    assert.strictEqual(record.rule, 'banned-write-verb');
  } finally {
    await h.stop();
  }
});

test('a table outside the allowlist is refused', async () => {
  const h = await harness();
  try {
    const res = await post(h.base, { statement: 'SELECT * FROM hr.Salaries' }, { [HEADER]: h.token });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).rule, 'table-not-allowlisted');
  } finally {
    await h.stop();
  }
});

test('the row cap truncates and says so', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
  const h = await harness({ rows, limits: { rowCap: 10 } });
  try {
    const res = await post(h.base, { statement: 'SELECT * FROM dbo.Projects' }, { [HEADER]: h.token });
    const body = await res.json();
    assert.strictEqual(body.rowCount, 10);
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(body.rowCap, 10);
    assert.strictEqual(h.readLog().at(-1).truncated, true);
  } finally {
    await h.stop();
  }
});

test('a query over the timeout returns 504 and is logged as a timeout', async () => {
  const h = await harness({ delayMs: 300, limits: { queryTimeoutMs: 40 } });
  try {
    const res = await post(h.base, { statement: 'SELECT * FROM dbo.Projects' }, { [HEADER]: h.token });
    assert.strictEqual(res.status, 504);
    assert.strictEqual((await res.json()).error, 'query-timeout');
    assert.strictEqual(h.readLog().at(-1).outcome, 'timeout');
  } finally {
    await h.stop();
  }
});

test('the rate limit answers 429 with Retry-After', async () => {
  const h = await harness({ limits: { rateLimitPerMinute: 2 } });
  try {
    const send = () => post(h.base, { statement: 'SELECT * FROM dbo.Projects' }, { [HEADER]: h.token });
    assert.strictEqual((await send()).status, 200);
    assert.strictEqual((await send()).status, 200);
    const third = await send();
    assert.strictEqual(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.strictEqual((await third.json()).limitPerMinute, 2);
  } finally {
    await h.stop();
  }
});

test('an over-large body is refused before it is parsed', async () => {
  const h = await harness();
  try {
    const res = await post(h.base, { statement: `SELECT '${'x'.repeat(4000)}'` }, { [HEADER]: h.token });
    assert.strictEqual(res.status, 413);
  } finally {
    await h.stop();
  }
});

test('a body that is not JSON, or carries no statement, is a 400', async () => {
  const h = await harness();
  try {
    assert.strictEqual((await post(h.base, 'not json', { [HEADER]: h.token })).status, 400);
    assert.strictEqual((await post(h.base, { sql: 'SELECT 1' }, { [HEADER]: h.token })).status, 400);
  } finally {
    await h.stop();
  }
});

test('health answers on localhost without an assertion and leaks nothing', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.deepStrictEqual(Object.keys(body).sort(), ['service', 'status', 'uptimeSeconds', 'version']);
  } finally {
    await h.stop();
  }
});

test('any other path is a 404 and any other method a 405', async () => {
  const h = await harness();
  try {
    assert.strictEqual((await fetch(`${h.base}/`)).status, 404);
    assert.strictEqual((await fetch(`${h.base}/query`)).status, 405);
  } finally {
    await h.stop();
  }
});
