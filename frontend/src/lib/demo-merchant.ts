/**
 * The one seeded demo merchant.
 *
 * Single-tenant by design for the buildathon (PRD 6.1): there is no signup, no
 * password reset and no tenant switcher. Credentials live here rather than in
 * env so the login form can pre-fill exactly what the API will accept - a demo
 * that fails because the two drifted apart is worse than a hardcoded secret
 * that never leaves test mode.
 */
export const DEMO_MERCHANT = {
  username: "demo@tugboat.dev",
  password: "tugboat-demo",
  displayName: "Demo Merchant",
} as const;
