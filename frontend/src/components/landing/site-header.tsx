"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b border-white/[0.06] bg-ink-950/85 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <div className="shell flex h-[80px] items-center justify-between lg:h-[136px]">
        <Link href="/" className="shrink-0" aria-label="Tugboat home">
          <Image
            src="/media/tugboat-logo.png"
            alt="Tugboat"
            width={640}
            height={233}
            priority
            className="h-[52px] w-auto lg:h-[94px]"
          />
        </Link>

        <Link
          href="/login"
          className="btn-gold px-7 py-2.5 text-[15px] lg:px-8 lg:py-3 lg:text-[17px]"
        >
          Login
        </Link>
      </div>
    </header>
  );
}
