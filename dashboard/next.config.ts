import type { NextConfig } from "next";

// Next 16 forbids `turbopack.root` mismatching `outputFileTracingRoot`.
// Vercel auto-sets `outputFileTracingRoot` to the monorepo root, so we
// don't pin `turbopack.root` here and let Next/Vercel agree on the value.

// Security headers (NFR-SEC-3). The CSP is intentionally limited to the
// directives that harden the app without breaking Next's inline runtime:
// clickjacking protection, base-uri pinning, and no plugin content.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
