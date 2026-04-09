import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
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
