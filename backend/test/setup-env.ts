/**
 * Hermetic test environment.
 *
 * `??=` means a real .env never overrides these, and their presence means the
 * suite runs on a machine that has no .env at all — the values are syntactic
 * placeholders, and nothing in the unit or e2e suites opens a connection. That
 * last clause is load-bearing: anything that would dial out belongs in the
 * integration tier, not here.
 */
process.env.NODE_ENV ??= "test";
process.env.PORT ??= "4001";
process.env.DATABASE_URL ??= "postgresql://tugboat:tugboat@localhost:5432/tugboat_test";
// REDIS_URL is deliberately absent. With no Redis configured the app builds the
// deterministic in-memory queue, which is what this tier wants; a placeholder
// URL here made BullMQ retry a connection to a Redis that does not exist and
// hung the whole suite (B-17).
process.env.JWT_SECRET ??= "test-only-signing-key-not-a-real-secret";
process.env.FRONTEND_ORIGIN ??= "http://localhost:3000";
