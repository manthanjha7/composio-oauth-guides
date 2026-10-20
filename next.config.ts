import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Seed guides and the verification ledger are read from ./data at request time.
  outputFileTracingIncludes: {
    "/**": ["./data/**/*.json"],
  },
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
