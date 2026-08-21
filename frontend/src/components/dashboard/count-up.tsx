"use client";

import { useEffect, useRef, useState } from "react";

import { formatRupees } from "@/lib/money";

/**
 * The recovered figure counts up on arrival.
 *
 * Motion signals state change, not decoration (PRD 5.1): this is the one number
 * on the page that is allowed to move, because watching it climb is the whole
 * pitch. Renders the final value on the server so there is no flash of zero and
 * no hydration mismatch - the animation only starts once mounted.
 */
export function CountUpRupees({
  paise,
  durationMs = 1100,
  className = "",
}: {
  paise: number;
  durationMs?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(paise);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setShown(paise);
      return;
    }

    const start = performance.now();
    setShown(0);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic: fast off the line, settles on the number.
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(paise * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [paise, durationMs]);

  return (
    <span className={`tabular ${className}`}>
      <span className="opacity-70">₹</span>
      {formatRupees(shown)}
    </span>
  );
}
