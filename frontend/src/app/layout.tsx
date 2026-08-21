import type { Metadata } from "next";
import { Anton, Figtree } from "next/font/google";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  display: "swap",
});

const anton = Anton({
  variable: "--font-anton",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "Tugboat — We bring your revenue back home",
  description:
    "Tugboat (Boa) detects revenue at risk, diagnoses the root cause, and executes the right recovery workflow — across failed payments, abandoned checkouts, bounced mandates, and overdue invoices.",
  icons: {
    icon: "/media/tugboat-mark.png",
    apple: "/media/tugboat-mark.png",
  },
  openGraph: {
    title: "Tugboat — We bring your revenue back home",
    description:
      "An AI revenue recovery agent that detects, diagnoses, decides, executes and measures — bounded, compliant, audited.",
    images: ["/media/hero-tugboat-poster.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the head script below stamps `js` onto <html>
    // before React hydrates, so this one element legitimately differs from SSR.
    <html
      lang="en"
      className={`${figtree.variable} ${anton.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Runs before paint: the reveal styles only hide content once
            the script that reveals it is known to be running. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js')",
          }}
        />
      </head>
      <body className="page-grain bg-ink-900 antialiased">{children}</body>
    </html>
  );
}
