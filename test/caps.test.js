'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { executeStatement, QueryTimeoutError, poolConfigFrom } = require('../src/db');
const { RateLimiter } = require('../src/rate-limit');

/**
 * A stand-in for mssql's Request: the same four members executeStatement uses,
 * so the cap and the timeout are tested without a SQL Server. `rows` is how
 * many the fake would emit if nobody stopped it.
 */
class FakeRequest extends EventEmitter {
  constructor({ rows = 0, delayMs = 0, failWith = null } = {}) {
    super();
    this.available = rows;
    this.delayMs = delayMs;
    this.failWith = failWith;
    this.cancelled = false;
    this.emitted = 0;
    this.stream = false;
  }

  query() {
    setTimeout(() => {
      if (this.failWith) {
        this.emit('error', this.failWith);
        return;
      }
      for (let i = 0; i < this.available; i += 1) {
        if (this.cancelled) break;
        this.emitted += 1;
        this.emit('row', { i });
      }
      if (!this.cancelled) this.emit('done');
      else this.emit('done');
    }, this.delayMs);
  }

  cancel() {
    this.cancelled = true;
  }
}

test('a result under the cap comes back whole', async () => {
  const request = new FakeRequest({ rows: 10 });
  const result = await executeStatement({ request, statement: 'SELECT 1', rowCap: 5000, timeoutMs: 1000 });
  assert.strictEqual(result.rowCount, 10);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.rows.length, 10);
});

test('a result over the cap is truncated at the cap and flagged', async () => {
  const request = new FakeRequest({ rows: 100 });
  const result = await executeStatement({ request, statement: 'SELECT 1', rowCap: 25, timeoutMs: 1000 });
  assert.strictEqual(result.rowCount, 25);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(request.cancelled, true, 'the request should be cancelled at the cap');
});

test('the default cap of 5000 is what the plan proposes', async () => {
  const request = new FakeRequest({ rows: 5001 });
  const result = await executeStatement({ request, statement: 'SELECT 1', rowCap: 5000, timeoutMs: 2000 });
  assert.strictEqual(result.rowCount, 5000);
  assert.strictEqual(result.truncated, true);
});

test('the streaming path does not buffer past the cap', async () => {
  const request = new FakeRequest({ rows: 100000 });
  const result = await executeStatement({ request, statement: 'SELECT 1', rowCap: 10, timeoutMs: 2000 });
  assert.strictEqual(result.rows.length, 10);
  assert.ok(request.emitted < 100000, 'the fake should have been stopped early');
});

test('a query over the timeout is cancelled and rejected', async () => {
  const request = new FakeRequest({ rows: 1, delayMs: 500 });
  await assert.rejects(
    executeStatement({ request, statement: 'SELECT 1', rowCap: 100, timeoutMs: 30 }),
    (err) => err instanceof QueryTimeoutError && err.timeoutMs === 30
  );
  assert.strictEqual(request.cancelled, true, 'the request should be cancelled on timeout');
});

test('a query inside the timeout is not cancelled', async () => {
  const request = new FakeRequest({ rows: 3, delayMs: 10 });
  const result = await executeStatement({ request, statement: 'SELECT 1', rowCap: 100, timeoutMs: 500 });
  assert.strictEqual(result.rowCount, 3);
  assert.strictEqual(request.cancelled, false);
});

test('a driver error is passed back rather than swallowed', async () => {
  const request = new FakeRequest({ failWith: new Error('login failed for user') });
  await assert.rejects(
    executeStatement({ request, statement: 'SELECT 1', rowCap: 10, timeoutMs: 500 }),
    /login failed/
  );
});

test('the pool always asks for an encrypted connection', () => {
  const config = {
    sql: {
      server: 'sqlhost', port: 1433, database: 'db', user: 'hub_reader', password: 'x',
      encrypt: true, trustServerCertificate: false, connectTimeoutMs: 15000, poolMax: 4
    },
    limits: { queryTimeoutMs: 30000 }
  };
  const built = poolConfigFrom(config);
  assert.strictEqual(built.options.encrypt, true);
  assert.strictEqual(built.options.trustServerCertificate, false);
  assert.strictEqual(built.options.readOnlyIntent, true);
  assert.strictEqual(built.requestTimeout, 30000);
});

test('the rate limit allows the budget and then refuses', () => {
  const now = 1000;
  const limiter = new RateLimiter(3, () => now);
  assert.strictEqual(limiter.take('a').allowed, true);
  assert.strictEqual(limiter.take('a').allowed, true);
  assert.strictEqual(limiter.take('a').allowed, true);
  const refused = limiter.take('a');
  assert.strictEqual(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1);
});

test('the rate limit is per caller', () => {
  const now = 1000;
  const limiter = new RateLimiter(1, () => now);
  assert.strictEqual(limiter.take('a').allowed, true);
  assert.strictEqual(limiter.take('a').allowed, false);
  assert.strictEqual(limiter.take('b').allowed, true);
});

test('the rate limit window slides', () => {
  let now = 1000;
  const limiter = new RateLimiter(1, () => now);
  assert.strictEqual(limiter.take('a').allowed, true);
  assert.strictEqual(limiter.take('a').allowed, false);
  now += 60001;
  assert.strictEqual(limiter.take('a').allowed, true);
});
