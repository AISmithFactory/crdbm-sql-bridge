# crdbm-sql-bridge

The bridge from the CONIX hub to your SQL Server. This is the repository the
implementation plan promises you can read before installing anything: it is
public for that reason, and there is nothing in it but the source, the tests and
the install instructions. No credentials, no connection strings, no data.

> A small Node.js service, source in a repository you can read before
> installing. It listens on `127.0.0.1` only, so it is unreachable from your
> LAN. It accepts one statement per request and enforces: SELECT only, a single
> statement, no `EXEC`, `xp_`, `sp_`, `OPENROWSET` or `OPENQUERY`, a table
> allowlist you approve, a row cap (proposed 5,000), a query timeout (proposed
> 30 seconds), and a rate limit. It verifies the Cloudflare Access assertion on
> every request, so a request that somehow reached it without passing Access is
> refused. It logs every query with timestamp, statement, row count and duration
> to a local file you own.
>
> -- *The CONIX hub: implementation plan*, Part 1

This repository is that service, built to that paragraph. If you find something
here that the plan does not promise, or a promise the code does not keep, that
is a defect and we want to hear about it.

## What it does, in order

Every request takes exactly this path, and each step happens before the next one
is reached.

1. **Cloudflare Access.** The request must carry a `Cf-Access-Jwt-Assertion`
   header that verifies against your own team's certificates endpoint, for the
   audience tag of the Access application. There is no other way in: no shared
   secret, no API key, no address allowlist. A request without a valid assertion
   is refused with 403 **before the body is read**, so an unauthenticated caller
   never gets a statement parsed on its behalf.
2. **The rate limit.** 60 requests a minute per caller by default, answered with
   429 and a `Retry-After` header.
3. **The guard.** The statement is checked against the rules in the table below.
   A refusal is a 400 naming the rule that refused it.
4. **The query.** Run as `hub_reader` over TLS, streamed, stopped at the row cap
   and cancelled at the timeout.
5. **The log.** One JSON line, whatever the outcome.

## What it refuses

Every refusal names one rule. The name is what goes in the log and in the 400,
so "it said no" is always answerable with "it said no because of this".

| Rule | Refuses |
|---|---|
| `empty-statement` | nothing to run |
| `statement-too-long` | over `limits.maxStatementLength`, 8,000 characters by default |
| `multiple-statements` | anything after a semicolon, and any batch the parser reads as more than one statement |
| `banned-exec` | `EXEC`, `EXECUTE` |
| `banned-xp-prefix` | any name beginning `xp_` |
| `banned-sp-prefix` | any name beginning `sp_` |
| `banned-openrowset` | `OPENROWSET` |
| `banned-openquery` | `OPENQUERY` |
| `banned-rowset-function` | `OPENDATASOURCE`, `OPENXML`, `OPENJSON` |
| `banned-write-verb` | `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `RECONFIGURE`, `CHECKPOINT`, `KILL`, `DBCC`, `BULK` |
| `banned-control-flow` | `USE`, `DECLARE`, `SET`, `WAITFOR`, `BEGIN`, `COMMIT`, `ROLLBACK`, `PRINT`, `THROW`, `GOTO`, `WHILE`, `RETURN`, `REVERT`, `SETUSER` |
| `banned-batch-separator` | `GO` |
| `banned-select-into` | `SELECT ... INTO`, which is a write |
| `banned-variable` | `@variable` and `@@GLOBAL` |
| `unterminated-literal`, `unterminated-identifier`, `unterminated-comment` | a statement that ends inside a quote, a bracket or a comment |
| `parse-failed` | anything that is not valid T-SQL |
| `not-a-select` | anything the parser reads as a statement other than a SELECT |
| `unqualified-table` | a table named without its schema |
| `table-not-allowlisted` | a table you have not approved, wherever it appears: in the FROM, in a JOIN, in a subquery, or inside a CTE |

A semicolon or the word `EXEC` **inside a string literal** is not a refusal. The
guard blanks literals and comments before it looks for either, so
`WHERE note = 'a;b'` is an ordinary query.

### Two layers, and why

The bans are enforced twice: lexically, by a T-SQL-aware scanner in
[`src/tokeniser.js`](src/tokeniser.js), and structurally, by parsing the
statement with [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser)
in `transactsql` mode. Both must pass.

This is not belt and braces for its own sake. Measured on 5 September 2026
against node-sql-parser 5.4.0: `SELECT * FROM OPENROWSET(a,b,c)` parses cleanly
as a plain SELECT **with an empty table list**, so neither the statement-type
check nor the allowlist sees it. A parser is the right tool for "which tables
does this statement read", which is the question the allowlist asks and which
regular expressions answer badly. It is the wrong tool for "does this statement
name something we have banned outright". So each layer is used for what it is
good at, and the file says so at the top.

## What it does not do

Stated so you do not have to infer it from the absence of code.

- **It cannot write.** Not because it is asked politely: `INSERT`, `UPDATE`,
  `DELETE`, `MERGE` and `SELECT ... INTO` are refused by name, anything the
  parser does not read as a SELECT is refused, and `hub_reader` has no write
  grant anyway. The bridge's checks are the second line; the SQL login is the
  first.
- **It takes no parameters.** The body is `{"statement": "SELECT ..."}` and
  nothing else. Values are inlined in the statement by the caller and the guard
  parses the whole thing.
- **It does not do Windows authentication.** The plan says Windows
  authentication works equally, with the bridge under a dedicated service
  account; this build does SQL authentication only. If you would rather use a
  service account, say so and we will add it -- it is a small change and it is
  better made against your preference than guessed.
- **It listens on loopback only** and refuses to start on any other address.
- **It never opens an unencrypted connection to SQL Server.** `sql.encrypt` is
  `true` and setting it to `false` is a startup error.

## Installing

[`docs/install-windows.md`](docs/install-windows.md) is the whole procedure:
prerequisites, config, the SQL password, `--check`, the WinSW service, the
localhost confirmation, log retention, and uninstalling.

The short version:

```powershell
npm ci --omit=dev
node src\index.js --check --config C:\ProgramData\crdbm-sql-bridge\bridge.config.json
```

`--check` opens no socket. It validates the config, confirms the log directory
is writable, fetches your Cloudflare Access certificates, and connects to SQL
Server over TLS and runs `SELECT 1`. Exit code 0 means every check passed.

## Configuration

[`config/bridge.config.example.json`](config/bridge.config.example.json) is a
complete example with a placeholder in every field. Unknown keys and misspelled
keys are startup errors, because a typo in a limit is a limit that silently is
not applied.

| Key | Default | What it is |
|---|---|---|
| `server.host` | `127.0.0.1` | loopback only; any other value is refused |
| `server.port` | `8787` | the port `cloudflared` forwards to |
| `server.maxBodyBytes` | `65536` | larger bodies get a 413 |
| `access.teamDomain` | -- | `https://<your-team>.cloudflareaccess.com` |
| `access.audience` | -- | the Access application AUD tag |
| `sql.server`, `sql.port`, `sql.database`, `sql.user` | -- , `1433`, -- , -- | your server and the `hub_reader` login |
| `sql.password` | -- | better set as `BRIDGE_SQL_PASSWORD`; see the install doc |
| `sql.encrypt` | `true` | cannot be turned off |
| `sql.trustServerCertificate` | `false` | the documented override for a self-signed server certificate |
| `limits.rowCap` | `5000` | the plan's proposal |
| `limits.queryTimeoutMs` | `30000` | the plan's proposal |
| `limits.maxStatementLength` | `8000` | characters |
| `limits.rateLimitPerMinute` | `60` | per caller. **The plan proposes a rate limit without a number; 60 a minute is this build's default and is a proposal, like the others** |
| `allowlist` / `allowlistFile` | -- | schema-qualified table names you approve |
| `log.path`, `log.maxBytes`, `log.keep` | -- , `10485760`, `10` | the query log and its rotation |
| `log.includeStatementText` | `true` | set false to log the SHA-256 of the statement and not its text |
| `health.requireAccessJwt` | `false` | see below |

The allowlist is matched case-insensitively and past brackets, so
`dbo.Projects`, `DBO.PROJECTS` and `[dbo].[Projects]` are the same entry. An
entry without a schema is rejected at startup.

`/health` returns the status, the version and the uptime, and nothing else. It
needs no Access assertion by default, so that you can confirm the service is
running before the tunnel exists -- which is step 4 of your list in the plan, and
it has to be answerable then. It is reachable only from the machine itself. Set
`health.requireAccessJwt` to `true` if you would rather it were behind Access as
well.

## The log

One JSON object per line, at `log.path`, on a file you own. Every request is
logged whatever its outcome, including the ones that were refused.

```json
{"time":"2026-09-05T14:02:11.883Z","event":"query","caller":"hub-edge-function.access",
 "statementSha256":"9f2c...","tables":["dbo.projects"],"rowCount":42,"truncated":false,
 "durationMs":68,"outcome":"ok","rule":null,"error":null,
 "statement":"SELECT TOP 100 id, name FROM dbo.Projects"}
```

- `caller` is the identity from the Access assertion: the service token's name
  for the hub's edge function, or the user's email address for a person.
- `outcome` is `ok`, `refused`, `timeout` or `error`; `rule` names the rule when
  something was refused.
- `truncated` is true when the row cap cut the result short.
- `statement` is the text; `statementSha256` is its hash, which is there so two
  runs of the same query are comparable in the log even if you turn the text
  off. Set `log.includeStatementText` to `false` and only the hash is kept.

Rotation is by size: `query.jsonl` becomes `query.jsonl.1` at `log.maxBytes`,
keeping `log.keep` generations. Nothing rotates away without your say-so beyond
that; point `log.path` wherever your retention policy already reaches.

To read yesterday's refusals:

```powershell
Get-Content C:\ProgramData\crdbm-sql-bridge\query.jsonl |
  ConvertFrom-Json | Where-Object outcome -eq 'refused' |
  Select-Object time, caller, rule, statement
```

## Severing the connection

From the plan, unchanged. Any one of these breaks it completely and
immediately, and none requires the others:

- stop or uninstall the `cloudflared` service;
- disable or drop the `hub_reader` login;
- ask AI Smith to revoke the Access service token.

Stopping this service is a fourth.

## Reviewing the source

It is about 1,300 lines of source and 800 of tests. In the order worth reading:

| File | What to check |
|---|---|
| [`src/tokeniser.js`](src/tokeniser.js) | the lexical pass: comments, literals, quoted identifiers |
| [`src/guard.js`](src/guard.js) | every rule, and the allowlist check against the parsed table set |
| [`src/access.js`](src/access.js) | Cloudflare Access verification |
| [`src/server.js`](src/server.js) | the request path, in order |
| [`src/db.js`](src/db.js) | the connection, the streaming row cap, the timeout |
| [`src/config.js`](src/config.js) | what is validated at startup |
| [`test/`](test/) | the corpus of accepted and refused statements |

The tests are the shortest way to see what the guard does: `test/guard.test.js`
is a list of statements and the rule each one is refused by, and it is meant to
be read rather than only run. If a statement you care about is not in it, tell
us and it will be.

```bash
npm ci
npm test     # unit tests, no SQL Server and no network needed
npm run lint
```

The tests need neither a database nor a Cloudflare account: the SQL layer is
exercised through a stand-in for the driver's request object, and the JWT tests
generate their own key pair at run time. There is no key material in this
repository.

## What AI Smith sees

Query metadata and the rows returned, for the duration of a request. We store
neither the rows nor a copy of your database. Our side logs the same metadata
this file logs and nothing more.

## Licence

MIT. See [LICENSE](LICENSE).
