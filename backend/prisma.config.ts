import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma CLI configuration (Prisma 7).
 *
 * The URL here is used by `migrate`, `db push`, `studio` and `introspect` only.
 * It points at Neon's DIRECT endpoint because Prisma Migrate takes a session-level
 * advisory lock, which PgBouncer in transaction mode cannot hold. The running
 * application never uses this value — PrismaService is handed the pooled URL.
 *
 * Prisma 7 no longer loads .env implicitly, hence the dotenv import above.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DIRECT_URL"),
  },
  migrations: {
    seed: "ts-node prisma/seed.ts",
  },
});
