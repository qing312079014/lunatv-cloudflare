/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

const path = require('path');

// Cloudflare 构建：由 CI 或本地 build:cloudflare 注入 BUILD_TARGET
const isCloudflare =
  process.env.CF_PAGES === '1' || process.env.BUILD_TARGET === 'cloudflare';

const nextConfig = {
  // OpenNext/Cloudflare 不支持 standalone 产物
  output: isCloudflare ? undefined : 'standalone',
  eslint: {
    dirs: ['src'],
    // 边缘构建阶段不做 lint，避免无关告警阻断部署
    ignoreDuringBuilds: isCloudflare,
  },

  reactStrictMode: false,
  swcMinify: false,

  experimental: {
    // Workers 上没有 Next 的 instrumentation 生命周期，关掉
    instrumentationHook: process.env.NODE_ENV === 'production' && !isCloudflare,
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config, { isServer }) {
    if (isCloudflare) {
      // Workers 没有 Node 原生 TCP / 文件系统：把这些实现替换成显式报错的 shim，
      // 既避免打包 node-redis / better-sqlite3 失败，也能在上线后快速定位误用。
      const unsupported = path.resolve(
        __dirname,
        'src/lib/cloudflare-shims/node-unsupported.ts'
      );
      config.resolve.alias = {
        ...config.resolve.alias,
        redis: unsupported,
        'better-sqlite3': unsupported,
      };
    }

    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    // D1 只在服务端使用，别进客户端 bundle
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@/lib/d1.db': false,
        '@/lib/d1-adapter': false,
      };
    }

    return config;
  },
};

// next-pwa 会额外跑一轮 webpack，Cloudflare 构建不需要，且容易导致构建失败
if (isCloudflare) {
  module.exports = nextConfig;
} else {
  const withPWA = require('next-pwa')({
    dest: 'public',
    disable: process.env.NODE_ENV === 'development',
    register: true,
    skipWaiting: true,
  });

  module.exports = withPWA(nextConfig);
}
