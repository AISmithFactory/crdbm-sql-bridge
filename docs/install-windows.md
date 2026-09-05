# Installing the bridge as a Windows service

Written for the CONIX IT team. This is step 4 of "Your IT team" in the
implementation plan: *install the bridge as a Windows service and confirm it
answers on localhost*. It is about half an hour, no reboot, and nothing here
opens an inbound port.

Every value in angle brackets is a placeholder for you to fill in.

## 0. What you need first

- Node.js LTS (20 or 22) installed on the machine. `node --version` should
  answer. The bridge has no native modules, so there is no compiler to install.
- The `hub_reader` SQL login created (step 3 of the plan) with SELECT on the
  allowlisted tables and nothing else.
- The list of tables you have approved.
- The Cloudflare Access team domain and application AUD tag, which AI Smith
  sends you with the tunnel token.

`cloudflared` is a separate install and is step 5, not this document.

## 1. Put the files on the machine

```
C:\Program Files\crdbm-sql-bridge\     the repository contents
C:\ProgramData\crdbm-sql-bridge\       config, query log, service logs
```

From an administrator PowerShell:

```powershell
git clone https://github.com/AISmithFactory/crdbm-sql-bridge.git "C:\Program Files\crdbm-sql-bridge"
cd "C:\Program Files\crdbm-sql-bridge"
npm ci --omit=dev
New-Item -ItemType Directory -Force "C:\ProgramData\crdbm-sql-bridge"
Copy-Item config\bridge.config.example.json "C:\ProgramData\crdbm-sql-bridge\bridge.config.json"
Copy-Item config\allowlist.example.json     "C:\ProgramData\crdbm-sql-bridge\allowlist.json"
```

If you would rather not run `git` on the server, download the release zip and
unpack it to the same place.

## 2. Fill in the config

Edit `C:\ProgramData\crdbm-sql-bridge\bridge.config.json`. The bridge refuses to
start if a placeholder is left in it, if a key is misspelled, or if the
allowlist is empty, so a typo shows up now rather than as a limit that is
quietly not applied.

- `server.host` must stay `127.0.0.1`. The bridge refuses any other value.
- `access.teamDomain` and `access.audience` come from AI Smith.
- `sql.server`, `sql.port`, `sql.database`, `sql.user` are yours.
- `allowlistFile` should point at `allowlist.json`; put your approved tables
  there as `schema.table`, one per line of the JSON array. A name with no schema
  is rejected at startup and a statement with no schema is refused at query time.
- `limits` are the plan's proposals (5,000 rows, 30 seconds, 60 requests a
  minute) and are yours to change.
- `log.path` is where the query log goes. Point it wherever your retention
  policy wants it.

## 3. The SQL password

Two options. Neither puts the password in this repository.

**Option A, an environment variable.** Simplest, and readable by any local
administrator:

```powershell
setx /M BRIDGE_SQL_PASSWORD "<the hub_reader password>"
```

The service reads it at start. Restart the service after changing it.

**Option B, the config file, ACL'd. This is the recommendation.** Put the
password in `sql.password` in `bridge.config.json`, then take the file off the
default inheritance:

```powershell
icacls "C:\ProgramData\crdbm-sql-bridge\bridge.config.json" /inheritance:r
icacls "C:\ProgramData\crdbm-sql-bridge\bridge.config.json" /grant "SYSTEM:(R)" "Administrators:(F)"
```

If you run the service under a dedicated account rather than `SYSTEM`, grant
read to that account instead.

`BRIDGE_SQL_PASSWORD` wins over the config file when both are set.

## 4. Check it before installing the service

```powershell
cd "C:\Program Files\crdbm-sql-bridge"
node src\index.js --check --config "C:\ProgramData\crdbm-sql-bridge\bridge.config.json"
```

`--check` opens no listening socket. It validates the config, prints what it
read (with no password and no full audience tag), confirms the log directory is
writable, fetches the Cloudflare Access certificates, and connects to SQL Server
over TLS and runs `SELECT 1`. It exits 0 when everything passed and 1 otherwise,
naming what failed.

If the SQL Server certificate is self-signed and not trusted by the machine, the
connection fails here. See "The TLS override" below.

One thing `--check` cannot prove: Cloudflare serves a certificates document for
any `<name>.cloudflareaccess.com`, so a typo in `access.teamDomain` still passes
the certificates line and then refuses every real request with
`wrong-access-issuer`. The check that closes that gap is AI Smith's test query
in step 6 of the plan, which is the first request to arrive through Access.

## 5. Install the service

The bridge is installed with [WinSW](https://github.com/winsw/winsw). The binary
is deliberately **not** vendored in this repository: download it yourself so
that what runs on your server is a file you fetched and can verify.

1. Download `WinSW-x64.exe` from the WinSW releases page.
2. Rename it to `crdbm-sql-bridge.exe` and put it in
   `C:\Program Files\crdbm-sql-bridge\service\`.
3. Copy `service\crdbm-sql-bridge.xml.example` to
   `service\crdbm-sql-bridge.xml` and fill in the four paths at the top.
4. Install and start:

```powershell
cd "C:\Program Files\crdbm-sql-bridge\service"
.\crdbm-sql-bridge.exe install
.\crdbm-sql-bridge.exe start
.\crdbm-sql-bridge.exe status
```

NSSM works equally well if that is what you already use; the service simply runs
`node src\index.js --config <path>` with a working directory of the install
folder and restarts on failure.

## 6. Confirm it answers on localhost

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

You should get `status: ok` with the version. That is the whole of the plan's
step 4. `/health` deliberately needs no Access assertion, because you have to be
able to confirm the service is up before the tunnel exists; it is reachable only
from the machine itself and returns nothing but the status, the version and the
uptime.

A query, by contrast, is refused without a valid Cloudflare Access assertion:

```powershell
Invoke-WebRequest -Method Post -Uri http://127.0.0.1:8787/query `
  -ContentType 'application/json' `
  -Body '{"statement":"SELECT 1"}'
# 403 access-denied, reason missing-access-assertion
```

That 403 is the correct answer and is what you should see from the machine
itself. Only a request that has come through Cloudflare Access carries the
assertion.

## 7. Log rotation and retention

The bridge writes the query log itself, as one JSON object per line, and rotates
it: `query.jsonl` becomes `query.jsonl.1` at `log.maxBytes` (10 MB by default),
keeping `log.keep` generations (10 by default). At the default settings that is
about 100 MB at most. Change either number, or point `log.path` at a location
your backup and retention policy already covers.

The service's own stdout and stderr are rotated separately by WinSW, into
`logpath` in the service XML. They carry startup and shutdown lines, not queries.

## Uninstalling

```powershell
cd "C:\Program Files\crdbm-sql-bridge\service"
.\crdbm-sql-bridge.exe stop
.\crdbm-sql-bridge.exe uninstall
```

Then delete `C:\Program Files\crdbm-sql-bridge`, and
`C:\ProgramData\crdbm-sql-bridge` once you no longer want the logs. Removing the
service is one of the three independent ways to sever the connection; the other
two are dropping the `hub_reader` login and asking AI Smith to revoke the Access
service token. None requires the others.

## The TLS override

`sql.encrypt` is `true` and cannot be turned off: the bridge will not open an
unencrypted connection to SQL Server, and it refuses to start if you set it to
`false`.

`sql.trustServerCertificate` is `false` by default, which means the server's
certificate is validated. If your SQL Server presents a self-signed certificate
that the machine does not trust, you have two options:

1. **Trust the certificate** on the machine (import it into the Local Computer
   Trusted Root store). The connection is then encrypted and authenticated.
2. **Set `"trustServerCertificate": true`** in the config. The connection stays
   encrypted but the server is no longer authenticated, so an attacker already
   positioned between the bridge and SQL Server could impersonate it. Since both
   ends are on your own network, and usually on the same machine, that is
   frequently an acceptable trade; it is stated here so that it is your decision
   and not a default someone did not notice.

Option 1 is the better one where you have the certificate to hand.
