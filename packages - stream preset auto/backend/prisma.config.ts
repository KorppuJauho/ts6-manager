// Prisma CLI configuration (replaces the deprecated package.json#prisma block).
// Unlike the old mechanism, the CLI no longer auto-loads .env when this file
// exists — dotenv keeps local `prisma migrate` / `db push` working.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
