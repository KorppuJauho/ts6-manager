# Quick start

Runs the manager with Docker. Requirements, hardware encoding and every
environment variable are in [Configuration](configuration.md).

1. Clone the repository and create `.env` at its root:

   ```bash
   echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
   echo "SIDECAR_TOKEN=$(openssl rand -base64 32)" >> .env
   ```

   Keep `ENCRYPTION_KEY` safe and never change it on an existing install: it
   encrypts the bots' identities.

2. Start it, built here or from prebuilt images:

   ```bash
   docker compose up -d --build
   docker compose -f docker-compose.ghcr.yml up -d
   ```

3. Open `http://localhost:3000/setup` and create the admin account. Add your
   TeamSpeak server under **Settings → Servers** (a name and its address),
   then create a bot on the **Music Bots** page.

The bot joins the server as an ordinary client. Control it from TeamSpeak
with [chat commands](chat-commands.md), or from the web UI.

Upgrading an install from before the bot-only version needs a database
backup and a one-off step: see
[Upgrading to the bot-only version](deploying.md#upgrading-to-the-bot-only-version).
Running it from source instead of Docker is in [Development](development.md).
