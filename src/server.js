'use strict';

const http = require('http');
const { checkStatement } = require('./guard');
const { executeStatement, QueryTimeoutError } = require('./db');
const { RateLimiter } = require('./rate-limit');
const { version } = require('../package.json');

function send(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('body too large');
        err.tooLarge = true;
        // Do not destroy the socket here: the 413 has to reach the caller
        // first. server.js closes the connection once the response is out.
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The request path, in the order the plan describes it: Access first, then the
 * rate limit, then the guard, then the query. Nothing reads the body until the
 * Access assertion has verified, so an unauthenticated caller never gets as far
 * as having a statement parsed on its behalf.
 */
function createServer({ config, verifier, queryLog, requestFactory }) {
  const limiter = new RateLimiter(config.limits.rateLimitPerMinute);

  const handler = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/health' && req.method === 'GET') {
      if (config.health.requireAccessJwt) {
        const auth = await verifier.verify(req.headers);
        if (!auth.ok) return send(res, 403, { error: 'access-denied', reason: auth.reason });
      }
      return send(res, 200, {
        status: 'ok',
        service: 'crdbm-sql-bridge',
        version,
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    if (url.pathname !== '/query') return send(res, 404, { error: 'not-found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });

    const auth = await verifier.verify(req.headers);
    if (!auth.ok) {
      limiter.take('unauthenticated');
      queryLog.writeQuery({
        event: 'access-denied',
        caller: null,
        outcome: 'refused',
        rule: auth.reason,
        durationMs: Date.now() - started
      });
      return send(res, 403, { error: 'access-denied', reason: auth.reason });
    }

    const caller = auth.identity;
    const budget = limiter.take(caller);
    if (!budget.allowed) {
      queryLog.writeQuery({
        event: 'rate-limited',
        caller,
        outcome: 'refused',
        rule: 'rate-limit',
        durationMs: Date.now() - started
      });
      res.setHeader('retry-after', String(budget.retryAfterSeconds));
      return send(res, 429, {
        error: 'rate-limited',
        limitPerMinute: config.limits.rateLimitPerMinute,
        retryAfterSeconds: budget.retryAfterSeconds
      });
    }

    let raw;
    try {
      raw = await readBody(req, config.server.maxBodyBytes);
    } catch (err) {
      if (err.tooLarge) {
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
        return send(res, 413, { error: 'body-too-large', maxBodyBytes: config.server.maxBodyBytes });
      }
      return send(res, 400, { error: 'bad-request', message: 'the body could not be read' });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'bad-request', message: 'the body is not valid JSON' });
    }
    if (!body || typeof body.statement !== 'string') {
      return send(res, 400, {
        error: 'bad-request',
        message: 'the body must be {"statement": "SELECT ..."}'
      });
    }

    const statement = body.statement;
    const verdict = checkStatement(statement, {
      allowlist: config.allowlist,
      maxStatementLength: config.limits.maxStatementLength
    });
    if (!verdict.ok) {
      queryLog.writeQuery({
        event: 'query',
        caller,
        statement,
        outcome: 'refused',
        rule: verdict.rule,
        error: verdict.message,
        durationMs: Date.now() - started
      });
      return send(res, 400, { error: 'refused', rule: verdict.rule, message: verdict.message });
    }

    try {
      const result = await executeStatement({
        request: requestFactory(),
        statement,
        rowCap: config.limits.rowCap,
        timeoutMs: config.limits.queryTimeoutMs
      });
      const durationMs = Date.now() - started;
      queryLog.writeQuery({
        event: 'query',
        caller,
        statement,
        tables: verdict.tables,
        rowCount: result.rowCount,
        truncated: result.truncated,
        outcome: 'ok',
        durationMs
      });
      return send(res, 200, {
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        rowCap: config.limits.rowCap,
        tables: verdict.tables,
        durationMs
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const timedOut = err instanceof QueryTimeoutError;
      queryLog.writeQuery({
        event: 'query',
        caller,
        statement,
        tables: verdict.tables,
        outcome: timedOut ? 'timeout' : 'error',
        rule: timedOut ? 'query-timeout' : null,
        error: String(err.message).slice(0, 500),
        durationMs
      });
      if (timedOut) {
        return send(res, 504, {
          error: 'query-timeout',
          timeoutMs: config.limits.queryTimeoutMs
        });
      }
      return send(res, 502, { error: 'database-error', message: String(err.message).slice(0, 500) });
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      try {
        send(res, 500, { error: 'internal-error', message: String(err.message).slice(0, 200) });
      } catch {
        res.destroy();
      }
    });
  });
  server.headersTimeout = 10000;
  return server;
}

module.exports = { createServer };
