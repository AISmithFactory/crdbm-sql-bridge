'use strict';

const fs = require('fs');
const path = require('path');
const { describeConfig } = require('./config');
const { AccessVerifier } = require('./access');
const { createPool } = require('./db');

/**
 * `--check` is what the client's IT runs after installing, before the tunnel is
 * pointed at anything: it proves the config parses, the Access certificates are
 * reachable, the SQL login connects over TLS and answers SELECT 1, and the log
 * file can be written. It opens no listening socket.
 *
 * Measured 2026-09-05: Cloudflare serves a certificates document for any
 * <name>.cloudflareaccess.com, so reaching the endpoint proves the network path
 * and not that the team name is yours. A wrong team domain passes this check and
 * then refuses every real request with `wrong-access-issuer`, which is why the
 * line says "reachable" and the install doc says to confirm with a real query.
 */
async function runCheck(config, out) {
  const say = out || console.log;
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    say(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  };

  const described = describeConfig(config);
  record('config', true, `${described.configPath}`);
  say(JSON.stringify(described, null, 2));

  const logDir = path.dirname(config.log.path);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const probe = path.join(logDir, '.crdbm-write-probe');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    record('log path writable', true, logDir);
  } catch (err) {
    record('log path writable', false, `${logDir}: ${err.message}`);
  }

  const verifier = new AccessVerifier(config.access);
  try {
    const response = await fetch(verifier.certsUrl, { redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const keys = Array.isArray(body.keys) ? body.keys.length : 0;
    if (keys === 0) throw new Error('the certificates endpoint returned no keys');
    record('cloudflare access certificates reachable', true, `${verifier.certsUrl} (${keys} keys)`);
  } catch (err) {
    record('cloudflare access certificates reachable', false, `${verifier.certsUrl}: ${err.message}`);
  }

  let pool = null;
  try {
    pool = await createPool(config);
    const result = await pool.request().query('SELECT 1 AS one');
    const value = result.recordset && result.recordset[0] && result.recordset[0].one;
    if (value !== 1) throw new Error(`SELECT 1 returned ${JSON.stringify(value)}`);
    record(
      'sql server',
      true,
      `${described.sql} encrypted=${config.sql.encrypt} trustServerCertificate=${config.sql.trustServerCertificate}`
    );
  } catch (err) {
    record('sql server', false, `${described.sql}: ${err.message}`);
  } finally {
    if (pool) await pool.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  say(failed.length === 0 ? 'check: all passed' : `check: ${failed.length} of ${results.length} failed`);
  return { ok: failed.length === 0, results };
}

module.exports = { runCheck };
