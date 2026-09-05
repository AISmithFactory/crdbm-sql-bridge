#!/usr/bin/env node

'use strict';

const path = require('path');
const { loadConfig, describeConfig, ConfigError } = require('./config');
const { AccessVerifier } = require('./access');
const { QueryLog } = require('./log');
const { createServer } = require('./server');
const { createPool } = require('./db');
const { runCheck } = require('./check');
const { version } = require('../package.json');

const USAGE = `crdbm-sql-bridge ${version}

  crdbm-sql-bridge [--config <path>]     start the bridge
  crdbm-sql-bridge --check [--config ..] validate config, connect, SELECT 1, exit
  crdbm-sql-bridge --version
  crdbm-sql-bridge --help

Config path defaults to BRIDGE_CONFIG, then ./config/bridge.config.json.
The SQL password is read from BRIDGE_SQL_PASSWORD when it is set, in preference
to the config file.
`;

function parseArgs(argv) {
  const args = { check: false, help: false, version: false, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--config' || arg === '-c') {
      i += 1;
      args.config = argv[i];
    } else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return args;
}

function resolveConfigPath(fromArgs, env) {
  if (fromArgs) return fromArgs;
  if (env.BRIDGE_CONFIG) return env.BRIDGE_CONFIG;
  return path.join(process.cwd(), 'config', 'bridge.config.json');
}

async function main(argv, env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  let config;
  try {
    config = loadConfig(resolveConfigPath(args.config, env), env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (args.check) {
    const outcome = await runCheck(config);
    return outcome.ok ? 0 : 1;
  }

  const queryLog = new QueryLog(config.log).open();
  const verifier = new AccessVerifier(config.access);
  const pool = await createPool(config);
  const server = createServer({
    config,
    verifier,
    queryLog,
    requestFactory: () => pool.request()
  });

  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
  queryLog.write({ time: new Date().toISOString(), event: 'started', version, ...describeConfig(config), allowlist: undefined });
  process.stdout.write(`crdbm-sql-bridge ${version} listening on ${config.server.host}:${config.server.port}\n`);

  const shutdown = async (signal) => {
    process.stdout.write(`\n${signal}: stopping\n`);
    queryLog.write({ time: new Date().toISOString(), event: 'stopping', signal });
    server.close();
    await pool.close().catch(() => {});
    queryLog.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return null;
}

if (require.main === module) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      if (code !== null && code !== undefined) process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`fatal: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}

module.exports = { main, parseArgs, resolveConfigPath, USAGE };
