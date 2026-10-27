import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Test builds go to their own folder (SUNDAY_DIST_DIR=.next-test) so they never replace the
  // build the running SUNDAY is serving — that left her "thinking" forever.
  distDir: process.env.SUNDAY_DIST_DIR || ".next",
  devIndicators: false,
  // Native speaker-recognition addon: load with Node's require instead of bundling.
  serverExternalPackages: [
    "sherpa-onnx-node",
    "sherpa-onnx-win-x64",
    // Claude Code's agent runs as a bundled native binary — keep it out of the bundle.
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/claude-agent-sdk-win32-x64",
  ],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
