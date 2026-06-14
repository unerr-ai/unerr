import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";
import { appName, gitConfig } from "./shared";

// Shared nav/branding for both the home and docs layouts.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Clicking the brand goes straight to the docs (the site has no landing).
      url: "/docs",
      // Branded lockup: the unerr icon + wordmark asset, then "docs" in plain text.
      title: (
        <>
          <Image
            src="/icon-wordmark.svg"
            alt={appName}
            width={100}
            height={24}
            priority
          />
          <span className="font-heading text-fd-muted-foreground text-[15px] font-medium">
            docs
          </span>
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      {
        text: "Home",
        url: "https://unerr.dev",
        active: "none",
      },
    ],
  };
}
