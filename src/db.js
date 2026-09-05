'use strict';

const sql = require('mssql');

class QueryTimeoutError extends Error {
  constructor(ms) {
    super(`the query passed the ${ms} ms timeout and was cancelled`);
    this.name = 'QueryTimeoutError';
    this.timeoutMs = ms;
  }
}

/**
 * The connection is always encrypted. `trustServerCertificate` defaults to
 * false in config.js and turning it on is the documented override for a
 * self-signed server certificate; it is never the default and README.md says
 * what it costs.
 */
function poolConfigFrom(config) {
  return {
    server: config.sql.server,
    port: config.sql.port,
    database: config.sql.database,
    user: config.sql.user,
    password: config.sql.password,
    connectionTimeout: config.sql.connectTimeoutMs,
    requestTimeout: config.limits.queryTimeoutMs,
    pool: { max: config.sql.poolMax, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.sql.encrypt,
      trustServerCertificate: config.sql.trustServerCertificate,
      enableArithAbort: true,
      readOnlyIntent: true
    }
  };
}

async function createPool(config) {
  const pool = new sql.ConnectionPool(poolConfigFrom(config));
  await pool.connect();
  return pool;
}

/**
 * Streams the result and stops at the cap rather than buffering an unbounded
 * result set and trimming it afterwards, so a statement that would return a
 * million rows costs the cap and not the million.
 *
 * `request` is anything with `.stream`, `.query()`, `.on()` and `.cancel()`,
 * which is what mssql's Request gives us and what the tests supply as a fake.
 *
 * @returns {Promise<{rows: object[], rowCount: number, truncated: boolean}>}
 */
function executeStatement({ request, statement, rowCap, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        request.cancel();
      } catch {
        /* cancelling a finished request is not an error worth reporting */
      }
      finish(() => reject(new QueryTimeoutError(timeoutMs)));
    }, timeoutMs);

    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }

    request.stream = true;

    request.on('row', (row) => {
      if (rows.length < rowCap) {
        rows.push(row);
        return;
      }
      if (!truncated) {
        truncated = true;
        try {
          request.cancel();
        } catch {
          /* see above */
        }
      }
    });

    request.on('error', (err) => {
      if (timedOut) return;
      if (truncated) {
        finish(() => resolve({ rows, rowCount: rows.length, truncated }));
        return;
      }
      finish(() => reject(err));
    });

    request.on('done', () => {
      if (timedOut) return;
      finish(() => resolve({ rows, rowCount: rows.length, truncated }));
    });

    try {
      request.query(statement);
    } catch (err) {
      finish(() => reject(err));
    }
  });
}

module.exports = { createPool, executeStatement, poolConfigFrom, QueryTimeoutError, sql };
