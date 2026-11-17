import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The analyse route reads the bundled Sandbox job at runtime; the analyse and viewer routes read the
  // static gallery from disk (public/ files are served from the CDN, not bundled into functions).
  outputFileTracingIncludes: {
    '/api/analyze': ['./dist/sandbox-job.mjs', './public/gallery/**/*'],
    '/api/analysis/[owner]/[name]': ['./public/gallery/**/*'],
  },
};

export default nextConfig;
