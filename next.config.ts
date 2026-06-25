import type { NextConfig } from "next";
import path from "path";

// The quant catalog is read from disk at runtime (readFileSync of CATALOG_FILE),
// which Next can't statically trace — so force-include the catalog JSON (and the
// dummy CSVs the DuckDB provider reads) into the serverless bundle. CATALOG_FILE
// is read at build time from the Vercel env so a private deployment bundles its
// own prod catalog without hardcoding the path here.
const catalogIncludes = ["./config/**/*.json", "./data/dummy_data/**"];
if (process.env.CATALOG_FILE) {
  catalogIncludes.push("./" + process.env.CATALOG_FILE.replace(/^\.?\//, ""));
}

const nextConfig: NextConfig = {
  // DuckDB ships platform-specific .node bindings via dynamic require; let the
  // server runtime load them at runtime instead of having webpack try to bundle
  // every per-platform variant.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  outputFileTracingIncludes: {
    "/**": catalogIncludes,
  },
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
