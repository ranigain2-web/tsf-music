import type { NextConfig } from "next";
import pkg from "./package.json";

const nextConfig: NextConfig = {
  env: {
    // Single source of truth for the on-screen version badge. It has drifted
    // before (badge showed v0.4.0 while the release was 0.4.1), so derive it
    // from package.json instead of hand-copying it into a component.
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  // Pin the Turbopack workspace root to THIS project. Without it, Next walks
  // up the directory tree and any stray package.json in a parent folder
  // (e.g. ~/package.json from an unrelated project) makes that folder the
  // workspace root — picking up foreign middleware/src files and breaking
  // the build with "Middleware is missing expected function export name".
  turbopack: {
    root: __dirname,
  },
  output: "standalone",
  // Desktop (macOS/Linux) packaging builds into an ISOLATED dist dir so a
  // production build never clobbers the .next dir of a running `next dev`.
  distDir: process.env.TSF_DIST_DIR || ".next",
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
