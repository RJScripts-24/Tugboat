"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import {
  AlertIcon,
  EyeIcon,
  EyeOffIcon,
  HelmIcon,
  LockIcon,
  SpinnerIcon,
  TugboatMarkIcon,
} from "./icons";

type Pending = "none" | "credentials" | "demo";

const FIELD =
  "peer w-full rounded-[12px] border border-white/[0.09] bg-[#040c17]/85 py-[var(--auth-field)] pl-[46px] text-[15px] text-cream outline-none transition placeholder:text-[#5b6675] focus:border-gold-500/55 focus:bg-[#050e19] focus:ring-2 focus:ring-gold-500/15";

const FIELD_ICON =
  "pointer-events-none absolute left-[15px] top-1/2 h-[19px] w-[19px] -translate-y-1/2 text-[#68748a] transition-colors peer-focus:text-gold-400";

const LABEL = "text-[12px] font-semibold uppercase tracking-[0.14em] text-[#8b95a5]";

export function AuthCard() {
  const router = useRouter();

  // Pre-filled: there is exactly one seeded merchant, and a demo that stalls on
  // a typo helps nobody. The password is a test-mode secret by construction.
  const [username, setUsername] = useState<string>(DEMO_MERCHANT.username);
  const [password, setPassword] = useState<string>(DEMO_MERCHANT.password);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>("none");
  const [refusing, setRefusing] = useState(false);

  function refuse(message: string) {
    setError(message);
    setRefusing(true);
    setPending("none");
  }

  async function signIn(mode: "credentials" | "demo") {
    if (pending !== "none") return;

    if (mode === "credentials" && (!username.trim() || !password)) {
      refuse("Enter the merchant username and password.");
      return;
    }

    setError(null);
    setRefusing(false);
    setPending(mode);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "demo" ? { mode } : { username, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        refuse(body?.error ?? "Sign-in failed. Try again.");
        return;
      }

      // Stay pending through the navigation: the button must not spring back to
      // "ready" while the Control Tower is still loading.
      router.replace("/dashboard");
      router.refresh();
    } catch {
      refuse("Couldn't reach the API. Check that the server is running.");
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void signIn("credentials");
  }

  const busy = pending !== "none";

  return (
    <div
      className={`relative w-full max-w-[424px] rounded-[20px] border border-white/[0.08] backdrop-blur-xl${
        refusing ? " shake" : ""
      }`}
      style={{
        padding: "var(--auth-card-pad)",
        background:
          "radial-gradient(125% 78% at 50% 0%, rgba(240,172,42,0.11) 0%, transparent 62%), linear-gradient(180deg, rgba(6,15,28,0.93) 0%, rgba(3,10,20,0.95) 100%)",
        boxShadow: "0 34px 90px -34px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.05)",
      }}
      onAnimationEnd={(event) => {
        if (event.animationName === "shake") setRefusing(false);
      }}
    >
      {/* Lamplight along the top edge of the card */}
      <span
        className="pointer-events-none absolute inset-x-10 top-0 h-px bg-[linear-gradient(to_right,transparent,rgba(240,172,42,0.55),transparent)]"
        aria-hidden
      />

      {/* Boa's watch light */}
      <div className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.09] bg-[#101a2c]/70 py-[7px] pl-3 pr-4">
        <span className="relative flex h-[7px] w-[7px]" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold-400 opacity-70" />
          <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-gold-400" />
        </span>
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[#c3cad9]">
          Boa is on duty
        </span>
      </div>

      <h1
        className="font-display leading-[1.04] tracking-[-0.005em] text-cream"
        style={{ marginTop: "var(--auth-step)", fontSize: "var(--auth-title)" }}
      >
        Welcome aboard.
      </h1>
      <p
        className="text-[15px] leading-[1.55] text-[#93a0b0]"
        style={{ marginTop: "calc(var(--auth-step) * 0.5)" }}
      >
        Sign in to open the Control Tower and see what Boa has towed back today.
      </p>

      <form style={{ marginTop: "calc(var(--auth-step) * 1.6)" }} onSubmit={onSubmit} noValidate>
        <label htmlFor="username" className={LABEL}>
          Username
        </label>
        <div className="relative mt-2">
          <input
            id="username"
            name="username"
            type="text"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@merchant.in"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
            className={`${FIELD} pr-3.5`}
          />
          <HelmIcon className={FIELD_ICON} />
        </div>

        <label
          htmlFor="password"
          className={`${LABEL} block`}
          style={{ marginTop: "var(--auth-step)" }}
        >
          Password
        </label>
        <div className="relative mt-2">
          <input
            id="password"
            name="password"
            type={revealed ? "text" : "password"}
            autoComplete="current-password"
            placeholder="Your merchant password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            className={`${FIELD} pr-[46px]`}
          />
          <LockIcon className={FIELD_ICON} />
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute right-[13px] top-1/2 -translate-y-1/2 rounded-md p-1 text-[#68748a] transition-colors hover:text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
          >
            {revealed ? (
              <EyeOffIcon className="h-[19px] w-[19px]" />
            ) : (
              <EyeIcon className="h-[19px] w-[19px]" />
            )}
          </button>
        </div>

        {/* Mounted even when empty so the live region exists before it fills. */}
        <div aria-live="polite">
          {error ? (
            <p
              style={{ marginTop: "var(--auth-step)" }}
              className="flex items-start gap-2.5 rounded-[11px] border border-[#f0596a]/30 bg-[#f0596a]/[0.09] px-3.5 py-2.5 text-[13.5px] leading-[1.5] text-[#f2a6b0]"
            >
              <AlertIcon className="mt-[1px] h-[16px] w-[16px] shrink-0 text-[#f0596a]" />
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={busy}
          style={{ marginTop: "calc(var(--auth-step) * 1.2)" }}
          className="btn-gold w-full justify-center gap-2.5 px-6 py-[calc(var(--auth-field)+2px)] text-[16px]"
        >
          {pending === "credentials" ? (
            <>
              <SpinnerIcon className="h-[18px] w-[18px] animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in to Control Tower"
          )}
        </button>
      </form>

      <div
        className="flex items-center gap-3.5"
        style={{ marginBlock: "calc(var(--auth-step) * 1.2)" }}
        aria-hidden
      >
        <span className="h-px flex-1 bg-white/[0.08]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#68748a]">or</span>
        <span className="h-px flex-1 bg-white/[0.08]" />
      </div>

      <button
        type="button"
        onClick={() => void signIn("demo")}
        disabled={busy}
        className="btn-ghost w-full gap-2.5 px-6 py-[calc(var(--auth-field)+1px)] text-[15px]"
      >
        {pending === "demo" ? (
          <>
            <SpinnerIcon className="h-[18px] w-[18px] animate-spin text-gold-400" />
            Casting off…
          </>
        ) : (
          <>
            <TugboatMarkIcon className="h-[21px] w-[21px] text-gold-500" />
            Enter as demo merchant
          </>
        )}
      </button>
      <p
        className="border-t border-white/[0.06] text-center text-[12.5px] text-[#68748a]"
        style={{ marginTop: "calc(var(--auth-step) * 1.1)", paddingTop: "calc(var(--auth-step) * 0.8)" }}
      >
        Demo merchant · Razorpay test mode
      </p>
    </div>
  );
}
