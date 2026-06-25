import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // DuckDB ships platform-specific .node bindings via dynamic require; let the
  // server runtime load them at runtime instead of having webpack try to bundle
  // every per-platform variant.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  webpack: (config, { isServer, webpack: webpackApi }) => {
    config.plugins.push(
      new webpackApi.NormalModuleReplacementPlugin(
        /vega-canvas[\\/]build[\\/]vega-canvas\.node\.js$/,
        path.resolve(
          process.cwd(),
          "node_modules/vega-canvas/build/vega-canvas.browser.js",
        ),
      ),
    );
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        canvas: false,
      };
    }
    return config;
  },
};

export default nextConfig;
