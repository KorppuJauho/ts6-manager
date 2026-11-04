// Prints the row count of every table, then SQLite's integrity and
// foreign-key checks, one line each. Used around a schema upgrade that drops
// tables or columns: run it before and after and compare (see
// docs/deploying.md). Reads DATABASE_URL like the app; changes nothing.
//
//   node prisma/table-counts.mjs
import prismaPkg from '../generated/prisma/index.js';

const prisma = new prismaPkg.PrismaClient();
try {
  const tables = await prisma.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name",
  );
  for (const { name } of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`);
    console.log(`${name} ${Number(n)}`);
  }
  const integrity = await prisma.$queryRawUnsafe('PRAGMA integrity_check');
  console.log(`integrity_check ${integrity.map((r) => Object.values(r)[0]).join(', ')}`);
  const fk = await prisma.$queryRawUnsafe('PRAGMA foreign_key_check');
  console.log(`foreign_key_check ${fk.length === 0 ? 'ok' : JSON.stringify(fk)}`);
} finally {
  await prisma.$disconnect();
}
