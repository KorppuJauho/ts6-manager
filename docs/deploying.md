# Deploying from the repository

How to move a deployment that builds from an unpacked ZIP onto a git
checkout, and how to update it afterwards. Written for a NAS or small server
running Docker Compose.

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
Schema changes are additive, but a backup costs seconds and makes a bad
upgrade a two-minute rollback instead of a bad evening.

```bash
docker compose stop backend
cp -a /volume2/docker/ts6-fork/backend-data \
      /volume2/docker/ts6-fork/backend-data.bak-$(date +%F)
```

Adjust the path to match your own `volumes:` entry.

## Upgrade

```bash
cd /volume2/docker/ts6-manager && git pull
cd /volume2/docker && docker compose up -d --build
```

`--build` is required: without it Compose reuses the existing images and the
new code never reaches the containers.

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
of the source and into **Settings → Streaming**, and the bot's reply language
into **Settings → Music Commands**.

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
it again.

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

Building on the NAS compiles `@discordjs/opus` and `cpu-features` from source
every time the dependency layer changes. It is slow, and it fails in ways CI
never sees — the host toolchain is not the one CI tested. The **Publish
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
deploying a branch that touches `schema.prisma`.

### Building on the host is still supported

`docker-compose.yml` still builds from the working tree, and is the right
choice when testing an uncommitted change. The two files must be kept in step
when one gains a service, a port or an environment variable.
