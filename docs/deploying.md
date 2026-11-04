# Deploying from the repository

How to move a deployment that builds from an unpacked ZIP onto a git
checkout, how to update it afterwards, and the one upgrade that needs more
than a pull: the move to the bot-only version. Written for a NAS or small
server running Docker Compose.

## Upgrading to the bot-only version

**Read this before you start any version that contains the bot-only change
on an existing database.** That version drops the tables and columns of the
features it removed, and the backend will not start on the old database until
you run one command by hand. A fresh install is not affected: on an empty data
volume the normal start creates the schema.

### Why it is not automatic

The backend applies the schema with `prisma db push` at every container
start. Until now that only ever added tables and columns. This version
removes some, and Prisma refuses a push that would drop data unless it is
given `--accept-data-loss`. The start command deliberately does not pass that
flag: deleting data should be a step you choose after taking a backup, not a
side effect of a restart.

Instead the container exits when the push is refused, and with
`restart: unless-stopped` it keeps restarting, each time logging Prisma's
warning, which ends with `Use the --accept-data-loss flag`. Nothing is lost in
that state; the old tables are still there and the app simply does not run.
Earlier versions started the app even when the push failed, which would have
run this build against the old tables, so the start command was changed to
stop instead.

### What is removed, and what is kept

Removed for users:

- **Server management.** The pages that administered TeamSpeak servers over
  WebQuery (dashboard, virtual servers, channels, clients, groups,
  permissions, bans, tokens, complaints, messages, server logs, instance) and
  the bot's `!channels`, `!move`, `!moveall` and `!notif` commands. The bot
  never used WebQuery: it connects as an ordinary client on the voice port.
- **Bot flows, the Discord bridge, the connection journal, server widgets,
  the Files page and the music bot's player widget.**
- **MFA, trusted devices, SAML SSO and web bans.** Sign-in is username and
  password only. A user who had MFA signs in with the password alone. A user
  created by SSO has no password and cannot sign in until an admin sets one
  (Settings → Users → Reset Password). Stored web bans are not enforced.
- **Languages other than English**, in the UI and in the bot's replies. A bot
  set to Finnish, or any other language, now answers in English.
- **The command group restriction.** The music and admin command groups no
  longer limit who may command a bot: anyone who can message it can. Decide
  that with TeamSpeak's own channel permissions instead.

Kept, with their data: music bots with their identities and avatars, the
music library, playlists, radio stations, music requests, IPTV and `!tv`,
video streaming and its hardware encoding settings, Spotify, lyrics, YouTube
cookies, users with their admin and viewer roles, the password policy, rate
limits and the reverse proxy hop count.

Dropped from the database: the tables `BotFlow`, `BotVariable`,
`BotExecution`, `BotExecutionLog`, `Widget`, `DiscordSettings`,
`ConnectionLog`, `SAMLSettings`, `TrustedDevice`, `WebBan` and `StreamSession`;
the MFA, language and SSO columns of `User`; the WebQuery, SSH and `enabled`
columns of `TsServerConfig`; the language and command group columns of
`MusicCommandSettings`; and `streamPublic` in `StreamSettings`. SQLite cannot
drop a column in place, so Prisma rebuilds those four tables and copies their
rows across. Every other kept table is left untouched.

### Before you start

Run every command below in the directory that holds your compose file and
`.env`. The compose file needs `.env` even for one-off commands, because it
refuses to start anything without `JWT_SECRET`, `ENCRYPTION_KEY` and
`SIDECAR_TOKEN`.

The commands use `$DC` for the compose invocation, so the same steps work
whether you build on the host or pull images built by CI. Set it once, to one
of these, in the shell you will use:

```bash
DC="docker compose"                              # building on the host (docker-compose.yml)
DC="docker compose -f docker-compose.ghcr.yml"   # CI-built images from GHCR
```

`$DC run --rm --no-deps backend <command>` runs one command in a throwaway
container of the **new** backend image, with the real data volume mounted and
`DATABASE_URL` set from the compose file. `--no-deps` keeps it from starting
the sidecar and frontend, and `run` publishes no ports, so nothing serves
traffic while you work. The working directory inside is
`/app/packages/backend`, which is why the paths below start with `prisma/`.

### Step 0: get the new image without starting it

Note what you are running now; it is the rollback target.

Building on the host:

```bash
git -C ts6-manager rev-parse HEAD     # note this commit
git -C ts6-manager pull
$DC build                             # builds only; running containers are untouched
```

Adjust `ts6-manager` to wherever the checkout is.

CI-built images:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ts6-backend
# note this commit: the rollback tag is sha-<that commit>
$DC pull                              # downloads only; running containers are untouched
```

If you set `TS6_IMAGE_TAG` in `.env`, set it to the tag you are upgrading to
before pulling.

### Step 1: back up the data directory (mandatory)

Stop the backend so nothing writes to the database while it is copied:

```bash
$DC stop backend
```

Copy the **whole** backend data directory, not only the database file: it
holds `ts6webui.db`, any `ts6webui.db-journal` or `ts6webui.db-wal` file that
belongs with it, the bot avatars in `bot-avatars/` and the uploaded YouTube
cookies.

With a bind mount (a host path in your `volumes:` entry):

```bash
cp -a /volume2/docker/ts6-fork/backend-data \
      /volume2/docker/ts6-fork/backend-data.bak-$(date +%F)
ls -la /volume2/docker/ts6-fork/backend-data.bak-$(date +%F)
```

With the named volume `backend-data` that the repository's compose files use,
copy it out through the backend image, as root so the files keep their owner:

```bash
mkdir ts6-backup-$(date +%F)
$DC run --rm --no-deps --user root -v "$PWD/ts6-backup-$(date +%F)":/backup \
  backend sh -c 'cp -a data/. /backup/ && ls -la /backup'
```

Either way, check the listing before going on: `ts6webui.db` must be there
and must not be 0 bytes. An empty or missing copy is not a backup. Do not
continue until you have one.

### Step 2: count the rows before

```bash
$DC run --rm --no-deps -T backend node prisma/table-counts.mjs | tee counts-before.txt
```

`table-counts.mjs` prints one line per table with its row count, then SQLite's
`integrity_check` and `foreign_key_check`. It changes nothing. Both checks
should say `ok` here already; if they do not, the database had a problem
before the upgrade, and that is worth understanding first.

### Step 3 (optional): dry run

```bash
$DC run --rm --no-deps -T backend sh -c \
  'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script'
```

The single quotes matter: `$DATABASE_URL` has to be expanded inside the
container, where the compose file sets it, not by your shell, where it is
empty.

This prints the SQL the push would run, and runs none of it. Expect a
`DROP TABLE` for each of the eleven tables listed above, and a rebuild for
`User`, `TsServerConfig`, `MusicCommandSettings` and `StreamSettings` only:
`CREATE TABLE "new_User"`, `INSERT INTO "new_User" … SELECT … FROM "User"`,
`DROP TABLE "User"`, `ALTER TABLE "new_User" RENAME TO "User"`, and the same
for the other three. The `DROP TABLE` inside a rebuild comes after its rows
were copied. A drop or rebuild of any other table means the database is not
the one this procedure expects; stop there.

### Step 4: apply the schema, once

With the backend still stopped:

```bash
$DC run --rm --no-deps backend npx prisma db push --skip-generate --accept-data-loss
```

Prisma lists what it drops, applies the change and reports that the database
is now in sync with the schema.

### Step 5: count the rows after

```bash
$DC run --rm --no-deps -T backend node prisma/table-counts.mjs | tee counts-after.txt
diff counts-before.txt counts-after.txt
```

The only differences should be the eleven dropped tables missing from the
second list. Every kept table must show the same count as before, and
`integrity_check` and `foreign_key_check` must both say `ok`. If anything else
differs, do not start the backend: roll back as described below.

### Step 6: start normally

```bash
$DC up -d
$DC logs backend | grep -i "in sync"
```

The backend log says `The database is already in sync with the Prisma schema`:
the start's own push now has nothing to do, so it passes without the flag.
`up -d` also recreates the sidecar and frontend from the new images.

### If you started it before step 4

The backend restart-loops with Prisma's data-loss warning in its log. Nothing
was lost. Stop it with `$DC stop backend` and begin at step 1.

### Check after upgrading

- **Sign in.** Password only. Users who cannot sign in because they never had
  a password (SSO) need one set under **Settings → Users → Reset Password**.
- **Settings → Servers** (formerly Connections). A server is now a name and a
  host; the WebQuery port, API key, HTTPS and SSH fields are gone with their
  columns. Check that each host is the address the bots should connect to.
  The voice port is set on each bot under **Music Bots**, not on the server.
- **Settings → Users.** Besides their own account settings, a viewer sees only
  **Music Request History**, which is
  their landing page, and only for the servers an admin grants them. Check
  the Servers column for every viewer and grant what they should see; a
  viewer with no server sees no requests. Admins see every server and land on
  **Music Bots**.
- **The bots.** Start one, and check that it joins, plays and answers commands
  in English. If you relied on the command groups to keep strangers from
  controlling it, set that up with TeamSpeak channel permissions now.
- **A stream**, if you use video: see the encoder check under "After upgrading
  from a pre-settings version" below.

The rehearsal of this procedure, on a copy of a realistic database with its
before and after row counts, is in [Fork changes](fork-changes.md).

### Rolling back this upgrade

Rolling back is restoring the backup and running the previous image, in that
order. The previous image alone is not enough: its own start would try to add
the dropped columns back to tables that already have rows, which it cannot do
for the required ones, and the dropped data would not come back anyway.

Stop the backend and put the backup back.

With a bind mount:

```bash
$DC stop backend
mv /volume2/docker/ts6-fork/backend-data /volume2/docker/ts6-fork/backend-data.failed
cp -a /volume2/docker/ts6-fork/backend-data.bak-<date> /volume2/docker/ts6-fork/backend-data
```

With the named volume:

```bash
$DC stop backend
$DC run --rm --no-deps --user root -v "$PWD/ts6-backup-<date>":/backup \
  backend sh -c 'find data -mindepth 1 -delete && cp -a /backup/. data/ && ls -la data'
```

Then run the version you noted in step 0.

Building on the host:

```bash
git -C ts6-manager checkout <the commit from step 0>
docker compose up -d --build
```

CI-built images:

```bash
TS6_IMAGE_TAG=sha-<the commit from step 0> docker compose -f docker-compose.ghcr.yml pull
TS6_IMAGE_TAG=sha-<the commit from step 0> docker compose -f docker-compose.ghcr.yml up -d
```

## Why bother

Building from a folder means nothing records which version is running. A
checkout answers that with `git log -1`, updates with `git pull`, and rolls
back to an exact commit when something goes wrong.

## One-time: switch the build context

Clone beside the existing folder rather than over it — the old one is the
rollback path.

```bash
cd /volume2/docker          # wherever the compose file lives
git clone https://github.com/KorppuJauho/ts6-manager.git
```

Then point each service's build context at the clone. In `docker-compose.yml`,
three places change:

```yaml
  backend:
    build:
      context: ./ts6-manager          # was ./ts6-manager-main
      dockerfile: Dockerfile.backend

  sidecar:
    build:
      context: ./ts6-manager          # was ./ts6-manager-main
      dockerfile: Dockerfile.sidecar

  frontend:
    build:
      context: ./ts6-manager          # was ./ts6-manager-main
      dockerfile: Dockerfile.frontend
```

Nothing else in the compose file needs to change. Ports, volumes, container
names, `devices` and `group_add` all stay as they are.

## Back up the database first

The backend runs `prisma db push` on start, which alters the schema in place.
A change that only adds tables or columns is applied without asking. A change
that would drop data is refused, and the backend then stops instead of
starting; the bot-only upgrade above is that case, and has its own procedure.
Either way a backup costs seconds and makes a bad upgrade a two-minute
rollback instead of a bad evening.

```bash
docker compose stop backend
cp -a /volume2/docker/ts6-fork/backend-data \
      /volume2/docker/ts6-fork/backend-data.bak-$(date +%F)
```

Adjust the path to match your own `volumes:` entry. For a named volume, see
step 1 of the bot-only upgrade.

## Upgrade

```bash
cd /volume2/docker/ts6-manager && git pull
cd /volume2/docker && docker compose up -d --build
```

`--build` is required: without it Compose reuses the existing images and the
new code never reaches the containers.

If the backend then restart-loops and its log ends with
`Use the --accept-data-loss flag`, the new version drops data and needs the
manual step; for the bot-only version that is the procedure at the top.

## After upgrading from a pre-settings version

**Hardware encoding turns itself off.** Versions before the settings work
hardcoded the encoder; it is now a stored setting that defaults to software
VP8 — correct for a fresh install on a host with no GPU, wrong for a
deployment that was already using one.

Set it back in **Settings → Streaming**:

| | |
|---|---|
| Use hardware encoding | on |
| Encoding device | `/dev/dri/renderD128` |
| Video codec | VP9, or H.264 |

While you are there, the IPTV playlist URL and channel filter also moved out
of the source and into **Settings → Streaming**.

Confirm on the first stream:

```bash
docker compose logs -f sidecar | grep FFmpeg
```

`[FFmpeg] Starting: … encoder=vp9_vaapi` (or `h264_vaapi`) is what you want.
A software encoder there means the fallback fired, and the line above it says
why.

## Rolling back

The old folder is still there, so rollback is one edit and one rebuild:

```yaml
      context: ./ts6-manager-main     # back to the previous code
```

```bash
docker compose up -d --build
```

If the database also needs reverting — only if a schema change caused the
problem — stop the backend, restore the directory you copied above, and start
it again. Going back from the bot-only version to an older one always needs
the database restored first; see "Rolling back this upgrade" above.

## Pinning a version

`git pull` takes whatever is on the default branch, which is fine when you are
the only one pushing. To hold a known-good commit instead:

```bash
cd /volume2/docker/ts6-manager
git log --oneline -5          # find the commit
git checkout <commit>
```

`git checkout main && git pull` returns to tracking the branch.

## Deploying a branch from CI-built images

Building on the NAS reinstalls every dependency each time the dependency layer
changes. It is slow, and it fails in ways CI never sees — the host toolchain is
not the one CI tested. The **Publish
images** workflow builds all three images on every push and pushes them to
GHCR, so the host pulls a build that has already been tested instead of
repeating it.

### Pulling needs no setup

A package inherits the visibility of the repository that published it, and
this repository is public, so the images are public too — verified by fetching
a GHCR token with no credentials and reading all three manifests. The NAS
needs no `docker login`.

That changes if the repository is ever made private. The images follow it, and
the host then needs a personal access token with the `read:packages` scope:
`docker login ghcr.io -u <your-github-username>`, pasting the token as the
password.

### Deploying

`docker-compose.ghcr.yml` is `docker-compose.yml` with `image:` in place of
`build:` — same ports, same volumes, same GPU passthrough. Point it at a tag:

```bash
cd /volume2/docker/ts6-manager
TS6_IMAGE_TAG=claude-my-branch docker compose -f docker-compose.ghcr.yml pull
TS6_IMAGE_TAG=claude-my-branch docker compose -f docker-compose.ghcr.yml up -d
```

Set `TS6_IMAGE_TAG` in `.env` instead to avoid repeating it. Back to the
default branch: `TS6_IMAGE_TAG=main`, pull, up.

### Which tag

| Tag | Moves? | Use for |
|---|---|---|
| `main` | On every push to main | Normal running |
| `latest` | Same as `main` | Same as `main` |
| `<branch>` | On every push to that branch | Testing a branch |
| `sha-<full commit>` | Never | Pinning, and rollback |

A branch tag has slashes replaced by dashes: `claude/my-branch` publishes as
`claude-my-branch`. The workflow run's log prints the exact tags it pushed.

Rolling back is a tag change and a pull — the previous `sha-` tag is still in
the registry, so nothing has to be rebuilt.

**The database is not part of this.** Images carry code; `backend-data` is a
volume. Moving between branches does not revert a schema change that
`prisma db push` already applied, so take the backup described above before
deploying a branch that touches `schema.prisma`. Moving from an image with the
bot-only change back to one without it needs that backup restored.

### Building on the host is still supported

`docker-compose.yml` still builds from the working tree, and is the right
choice when testing an uncommitted change. The two files must be kept in step
when one gains a service, a port or an environment variable.
