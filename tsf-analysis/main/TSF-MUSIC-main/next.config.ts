import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to THIS project. Without it, Next walks
  // up the directory tree and any stray package.json in a parent folder
  // (e.g. ~/package.json from an unrelated project) makes that folder the
  // workspace root — picking up foreign middleware/src files and breaking
  // the build with "Middleware is missing expected function export name".
  turbopack: {
    root: __dirname,
  },
  output: "standalone",
  // Hide the floating dev-tools indicator: it overlays the player bar and
  // intercepts clicks (and looks nothing like Spotify).
  devIndicators: false,
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
