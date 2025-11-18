import path from "path";
import type { NextConfig } from "next";

const repoRoot = path.resolve(__dirname, "..");

const nextConfig: NextConfig = {
  reactStrictMode: false,
  productionBrowserSourceMaps: true,
  turbopack: {
    // Explicitly tell Next.js the monorepo root so Turbopack doesn't guess incorrectly.
    root: repoRoot,
  },
};

export default nextConfig;
