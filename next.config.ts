import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // OpenAI-compatible clients use base_url .../v1 — map to App Router /api/v1/*
  async rewrites() {
    return [
      { source: '/v1/:path*', destination: '/api/v1/:path*' },
      { source: '/v1', destination: '/api/v1' },
    ]
  },
}

export default nextConfig
