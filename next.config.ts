import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Native speaker-recognition addon: load with Node's require instead of bundling.
  serverExternalPackages: ["sherpa-onnx-node", "sherpa-onnx-win-x64"],
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
