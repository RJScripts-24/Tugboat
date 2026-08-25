/**
 * Environment for the INTEGRATION suite, which must reach a real database.
 *
 * `.env` is loaded first and deliberately: the hermetic setup (`setup-env.ts`)
 * fills DATABASE_URL with a localhost placeholder when none is set, and because
 * Jest runs setupFiles before the test file, that placeholder would win over a
 * dotenv import inside the spec — leaving the suite quietly pointed at a
 * database that does not exist.
 */
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Integration tests need a real DATABASE_URL. Copy .env.example to .env and fill it in, " +
      "or run the hermetic suites instead: npm test / npm run test:e2e",
  );
}

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "integration-only-signing-key-not-a-real-secret";
process.env.FRONTEND_ORIGIN ??= "http://localhost:3000";
