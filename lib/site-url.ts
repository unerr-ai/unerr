// Runtime base URL — read on the SERVER at request time, never inlined.
//
// We deliberately avoid NEXT_PUBLIC_* for the site URL: those are baked into
// the client bundle at build time, so a single Docker image could not serve
// more than one environment. `SITE_URL` is injected at runtime by the ECS task
// definition (same approach as unerr-web-service's lib/app-url.ts) and read
// here on the server only.
export function getSiteUrl(): string {
  return process.env.SITE_URL ?? "https://docs.unerr.dev";
}
