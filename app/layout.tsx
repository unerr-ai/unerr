import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import type { Metadata } from "next";
import { appName } from "@/lib/shared";
import { getSiteUrl } from "@/lib/site-url";

// Distinct variable names so they never self-reference the Tailwind theme
// tokens (--font-sans / --font-mono / --font-heading) that global.css maps.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const heading = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: `${appName} docs`,
    template: `%s — ${appName} docs`,
  },
  description:
    "Documentation for unerr — the operational memory layer for coding agents.",
  icons: { icon: "/icon.svg" },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${heading.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
