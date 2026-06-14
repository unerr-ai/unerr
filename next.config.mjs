import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Security headers. Docs is a static, read-only site — a tight CSP would need
// nonces for Next's inlined scripts, so we keep frame-ancestors-only for now
// and revisit if we embed third-party content.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

/** @type {import('next').NextConfig} */
const config = {
  // Standalone output so the Docker runner can boot with `node server.js`.
  output: "standalone",
  reactStrictMode: true,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // The site has no landing page — `/` goes straight to the docs.
  async redirects() {
    return [{ source: "/", destination: "/docs", permanent: true }];
  },
};

export default withMDX(config);
