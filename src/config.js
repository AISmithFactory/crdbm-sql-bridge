'use strict';

const fs = require('fs');
const path = require('path');
const { buildAllowlist } = require('./guard');

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8787, maxBodyBytes: 65536 },
  access: { teamDomain: null, audience: null, jwksCacheSeconds: 600 },
  sql: {
    server: null,
    port: 1433,
    database: null,
    user: null,
    password: null,
    encrypt: true,
    trustServerCertificate: false,
    connectTimeoutMs: 15000,
    poolMax: 4
  },
  limits: { rowCap: 5000, queryTimeoutMs: 30000, maxStatementLength: 8000, rateLimitPerMinute: 60 },
  log: { path: null, maxBytes: 10485760, keep: 10, includeStatementText: true },
  health: { requireAccessJwt: false },
  allowlist: [],
  allowlistFile: null
};

const TOP_LEVEL = new Set(Object.keys(DEFAULTS));

class ConfigError extends Error {}

function mergeSection(name, defaults, given) {
  if (given === undefined) return { ...defaults };
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ConfigError(`"${name}" must be an object`);
  }
  for (const key of Object.keys(given)) {
    if (!(key in defaults)) throw new ConfigError(`unknown key "${name}.${key}"`);
  }
  return { ...defaults, ...given };
}

function requireString(value, where) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`"${where}" is required`);
  }
  if (value.includes('<') || value.includes('>')) {
    throw new ConfigError(`"${where}" still holds the example placeholder ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function requirePositiveInt(value, where) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`"${where}" must be a positive whole number`);
  }
  return value;
}

function requireBoolean(value, where) {
  if (typeof value !== 'boolean') throw new ConfigError(`"${where}" must be true or false`);
  return value;
}

/**
 * Loads and validates the config. Rejects unknown keys, because a typo in a
 * limit is a limit that silently is not applied.
 *
 * The SQL password is read from the BRIDGE_SQL_PASSWORD environment variable in
 * preference to the file, so the file the client's IT keeps on disk need carry
 * no secret at all. Nothing in this module logs or returns the password.
 */
function loadConfig(configPath, env) {
  const environment = env || process.env;
  const resolved = path.resolve(configPath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config at ${resolved}: ${err.code || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config at ${resolved} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('the config must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL.has(key)) throw new ConfigError(`unknown top-level key "${key}"`);
  }

  const config = {
    configPath: resolved,
    server: mergeSection('server', DEFAULTS.server, parsed.server),
    access: mergeSection('access', DEFAULTS.access, parsed.access),
    sql: mergeSection('sql', DEFAULTS.sql, parsed.sql),
    limits: mergeSection('limits', DEFAULTS.limits, parsed.limits),
    log: mergeSection('log', DEFAULTS.log, parsed.log),
    health: mergeSection('health', DEFAULTS.health, parsed.health)
  };

  if (environment.BRIDGE_PORT) config.server.port = Number(environment.BRIDGE_PORT);
  if (environment.BRIDGE_SQL_PASSWORD) config.sql.password = environment.BRIDGE_SQL_PASSWORD;

  config.server.host = requireString(config.server.host, 'server.host');
  if (config.server.host !== '127.0.0.1' && config.server.host !== '::1') {
    throw new ConfigError(
      `"server.host" is ${JSON.stringify(config.server.host)}; the bridge binds to loopback only`
    );
  }
  requirePositiveInt(config.server.port, 'server.port');
  requirePositiveInt(config.server.maxBodyBytes, 'server.maxBodyBytes');

  config.access.teamDomain = requireString(config.access.teamDomain, 'access.teamDomain').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(config.access.teamDomain)) {
    throw new ConfigError('"access.teamDomain" must look like https://your-team.cloudflareaccess.com');
  }
  config.access.audience = requireString(config.access.audience, 'access.audience');
  requirePositiveInt(config.access.jwksCacheSeconds, 'access.jwksCacheSeconds');

  config.sql.server = requireString(config.sql.server, 'sql.server');
  config.sql.database = requireString(config.sql.database, 'sql.database');
  config.sql.user = requireString(config.sql.user, 'sql.user');
  if (typeof config.sql.password !== 'string' || config.sql.password.length === 0) {
    throw new ConfigError('the SQL password is not set; put it in BRIDGE_SQL_PASSWORD or in "sql.password"');
  }
  if (config.sql.password.includes('<')) {
    throw new ConfigError('"sql.password" still holds the example placeholder');
  }
  requirePositiveInt(config.sql.port, 'sql.port');
  requireBoolean(config.sql.encrypt, 'sql.encrypt');
  requireBoolean(config.sql.trustServerCertificate, 'sql.trustServerCertificate');
  if (config.sql.encrypt !== true) {
    throw new ConfigError('"sql.encrypt" must be true; the bridge does not open an unencrypted connection');
  }
  requirePositiveInt(config.sql.connectTimeoutMs, 'sql.connectTimeoutMs');
  requirePositiveInt(config.sql.poolMax, 'sql.poolMax');

  requirePositiveInt(config.limits.rowCap, 'limits.rowCap');
  requirePositiveInt(config.limits.queryTimeoutMs, 'limits.queryTimeoutMs');
  requirePositiveInt(config.limits.maxStatementLength, 'limits.maxStatementLength');
  requirePositiveInt(config.limits.rateLimitPerMinute, 'limits.rateLimitPerMinute');

  config.log.path = requireString(config.log.path, 'log.path');
  requirePositiveInt(config.log.maxBytes, 'log.maxBytes');
  requirePositiveInt(config.log.keep, 'log.keep');
  requireBoolean(config.log.includeStatementText, 'log.includeStatementText');
  requireBoolean(config.health.requireAccessJwt, 'health.requireAccessJwt');

  let entries = [];
  if (Array.isArray(parsed.allowlist)) entries = entries.concat(parsed.allowlist);
  else if (parsed.allowlist !== undefined) throw new ConfigError('"allowlist" must be an array');

  if (parsed.allowlistFile) {
    const file = path.resolve(path.dirname(resolved), parsed.allowlistFile);
    let fileEntries;
    try {
      fileEntries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`cannot read allowlistFile at ${file}: ${err.message}`);
    }
    if (!Array.isArray(fileEntries)) throw new ConfigError(`allowlistFile at ${file} must hold a JSON array`);
    entries = entries.concat(fileEntries);
  }
  if (entries.length === 0) {
    throw new ConfigError('the allowlist is empty; the bridge would refuse every statement');
  }
  try {
    config.allowlist = buildAllowlist(entries);
  } catch (err) {
    throw new ConfigError(err.message);
  }

  return config;
}

/** Safe to print and to put in a log line. Carries no password. */
function describeConfig(config) {
  return {
    configPath: config.configPath,
    listen: `${config.server.host}:${config.server.port}`,
    accessTeamDomain: config.access.teamDomain,
    accessAudience: `${config.access.audience.slice(0, 6)}...`,
    sql: `${config.sql.user}@${config.sql.server}:${config.sql.port}/${config.sql.database}`,
    encrypt: config.sql.encrypt,
    trustServerCertificate: config.sql.trustServerCertificate,
    limits: config.limits,
    allowlistSize: config.allowlist.size,
    logPath: config.log.path
  };
}

module.exports = { loadConfig, describeConfig, ConfigError, DEFAULTS };
