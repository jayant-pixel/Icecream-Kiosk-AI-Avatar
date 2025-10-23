import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  productionBrowserSourceMaps: true,
  turbopack: {
    // ...
  },
};

export default nextConfig;
