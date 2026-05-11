import type { NextConfig } from "next";

// Next 16 forbids `turbopack.root` mismatching `outputFileTracingRoot`.
// Vercel auto-sets `outputFileTracingRoot` to the monorepo root, so we
// don't pin `turbopack.root` here and let Next/Vercel agree on the value.
const nextConfig: NextConfig = {};

export default nextConfig;
