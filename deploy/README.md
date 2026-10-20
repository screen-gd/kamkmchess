# Server deployment

Vercel serves the frontend at `https://chess.khalil.mageed.net`. The Go API is
`https://chess-api.agent.soft-magic.com`. The frontend calls that API directly;
Vercel's `/v1/*` rewrite preserves compatibility with same-origin API clients.
Vercel also runs the stateless `api/provider-relay.ts` Node function for remote
custom AI endpoints that do not support browser CORS, such as Ollama Cloud.
It forwards each request's API key and streams the provider response without
storing or logging either. Public HTTPS destinations on port 443 are checked
and pinned to public DNS addresses; local networks and redirects are rejected.
The same handler runs in Vite development and preview. A static-only `dist/`
deployment cannot serve the relay. No database credential or shared provider
key is needed for this function, and the Go API deployment is unchanged.

The server deployment directory is `/home/agentsoftmagic/kamkmchess`.
Apache owns HTTPS and proxies the API's cPanel document root through
`api.htaccess` to `127.0.0.1:18081`. The API container runs as UID 65532 with a
read-only filesystem. PostgreSQL 16 has no published host port. It is reachable
only through the dedicated Docker network, using SCRAM passwords and verified
TLS for the runtime role. The network alias matches the AutoSSL certificate.
Migrations and backups use a separate administrative role inside the container.

## Online update delivery

Online fetch-SSE uses the configured direct API origin, bypassing Vercel's
compatibility rewrite. See the [online update contract](../docs/architecture/online-updates.md).
The participant `/v1/online/matches/{matchID}/updates` route accepts bearer or
guest credentials in headers and `Last-Event-ID` for reconnects. Keep those
headers allowed only on the online API; private account sync retains its
existing CORS policy.

Before enabling online play, inspect the actual Apache route with an
authorized participant session. Confirm the initial snapshot and heartbeat
comments arrive before the response ends, each stream ends within 20 seconds
or credential expiry, and a renewed stream obtains fresh authorization.
Disable compression or buffering for `text/event-stream` if it delays frames.
Verify the same snapshot through the JSON polling path, denied origins and
revoked membership, then measure concurrent streams against the existing host
and database pool. Go's flush calls and response headers do not prove Apache
delivery or hosting capacity. Record these checks in KHA-83 before rollout.

## Build and start

Build static Linux amd64 binaries from the repository using Go 1.26 or newer.
The following commands use a POSIX shell; in PowerShell set the equivalent
`GOOS`, `GOARCH`, and `CGO_ENABLED` environment variables before building.

```sh
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/kamkmchess-api ./cmd/server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/kamkmchess-migrate ./cmd/migrate
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o bin/khabackup ./backend/backup/cmd/khabackup
```

Upload the deployment files and `bin/` into the private server directory. Upload
`api.dockerignore` as `.dockerignore`. The API and database subdomains must
already exist in cPanel with AutoSSL enabled. Place `api.htaccess` in
`/home/agentsoftmagic/public_html/chess-api/.htaccess`. No credentials or
deployment binaries belong in that document root.

```sh
python3 bootstrap-secrets.py
python3 sync-postgres-tls.py
docker compose -f postgres.compose.yml up -d --wait
python3 provision-runtime.py
docker compose -f postgres.compose.yml -f api.compose.yml up -d --build --wait
```

`postgres.env`, `runtime.env`, `api.env`, and `backup.env` have mode 0600 and
remain on the server. Provisioning preserves existing credentials. The runtime
role can read and mutate only the five application tables; it cannot own the
schema, create roles or databases, or bypass row security. The API uses a pool
of at most four connections. A browser build receives only the three public
`KAMKM_PUBLIC_*` settings from `.env.example`.

## Backups and certificates

`backup.sh` creates and authenticates encrypted daily and weekly logical
exports, retaining seven daily and four weekly bundles. It uses the matching
PostgreSQL 16 tools in the database container. The daily cron entry runs the
certificate sync first, then the backup, and appends results to `operations.log`.
`sync-postgres-tls.py` follows certificate cross-signatures, verifies the full
chain and hostname, and reloads PostgreSQL after an AutoSSL renewal. The API's
public certificate is managed directly by cPanel.

The backup passphrase is in the server's private `backup.env`. An operator
recovery copy and encrypted bundles are kept outside the server under
`~/.config/kamkmchess/`. Keep that recovery directory private. The local copy is
an initial recovery copy, not a continuously synchronized offsite backup.

To run a backup or inspect service state:

```sh
./backup.sh
docker compose -f postgres.compose.yml -f api.compose.yml ps
docker compose -f postgres.compose.yml -f api.compose.yml logs --tail=50 api
```

Restore into a separate database first. Initialize it with the migration binary,
then run `khabackup restore` inside the PostgreSQL container, using a process
environment with that database's URL and the escrowed passphrase. Include newer
daily bundles with `--newer-ledger` so an old weekly export cannot resurrect
deleted games. Never point a rehearsal at the live database. The detailed
container format and recovery contract are in
[`MVP-operations.md`](../docs/implementation/MVP-operations.md).

## Identity and release checks

Clerk application `app_3KsNBjdK2nyfmuRJ4gnk8z2LwhB` has separate development
and production instances. The production issuer is
`https://clerk.chess.khalil.mageed.net`. Its frontend, account portal, and mail
DNS records are in the delegated `khalil.mageed.net` zone. Email code sign-in
is enabled. Google sign-in uses a dedicated web OAuth client named
`Kamkm Chess production` in Google Cloud project `wise-reporter-479504-e5`.
Its authorized origin is `https://chess.khalil.mageed.net` and its callback is
`https://clerk.chess.khalil.mageed.net/v1/oauth_callback`. It requests only
OpenID, email and basic profile scopes. The public privacy policy is
[`https://chess.khalil.mageed.net/privacy.html`](https://chess.khalil.mageed.net/privacy.html),
with its source in `public/privacy.html`. The Account screen links to it.

Release verification covers real Clerk sessions, isolated owners, create/read,
atomic commits and idempotent retries, takeover epochs, stale-write rejection,
deletion, denied origins, missing credentials, HTTPS, and backup restoration.
Evidence for this deployment is recorded in
[`server-deployment.md`](../docs/evidence/server-deployment.md).
