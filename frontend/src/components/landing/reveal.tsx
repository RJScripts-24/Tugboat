"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Fades content in as it scrolls into view and back out once it leaves,
 * so the effect replays on the way back up.
 */
function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return [ref, inView] as const;
}

type Props = {
  children: ReactNode;
  /** Stagger, in ms, against its siblings. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
};

function classes(inView: boolean, className?: string) {
  return `reveal${inView ? " is-visible" : ""}${className ? ` ${className}` : ""}`;
}

export function Reveal({ children, delay = 0, className, style }: Props) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={classes(inView, className)}
      style={{ ...style, transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

export function RevealItem({ children, delay = 0, className, style }: Props) {
  const [ref, inView] = useInView<HTMLLIElement>();
  return (
    <li
      ref={ref}
      className={classes(inView, className)}
      style={{ ...style, transitionDelay: `${delay}ms` }}
    >
      {children}
    </li>
  );
}
