import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The analyse route reads the bundled Sandbox job at runtime (Task 12b adds the route).
  outputFileTracingIncludes: { '/api/analyze': ['./dist/sandbox-job.mjs'] },
};

export default nextConfig;
