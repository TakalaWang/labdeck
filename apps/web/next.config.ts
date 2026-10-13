import path from 'node:path'
import type { NextConfig } from 'next'

// UI + JSON API in one Next.js server (docs/design.md 約定 G). Built as a standalone server for the web image.
const config: NextConfig = {
  output: 'standalone',
  // monorepo: trace packages/core into the standalone output
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  outputFileTracingIncludes: { '/**': ['../../packages/core/schema.sql', '../../packages/core/guide.md'] },
  transpilePackages: ['@labdeck/core'],
  // node:sqlite / node:child_process stay Node built-ins
  serverExternalPackages: [],
  poweredByHeader: false,
  reactStrictMode: true,
  // The API sets its own headers (no-store, CSP default-src 'none'); pages get theirs from src/proxy.ts.
  typescript: { tsconfigPath: './tsconfig.json' },
}

export default config
