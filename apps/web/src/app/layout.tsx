import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import type { ReactNode } from 'react'

import { ClientRoot } from './client-root'
import './globals.css'

export const metadata: Metadata = {
  title: 'LabDeck',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }], apple: '/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, colorScheme: 'light dark' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page is rendered per request: Next.js puts the CSP nonce from src/proxy.ts on its scripts.
  await headers()
  return (
    <html lang="zh-Hant-TW" suppressHydrationWarning>
      <body>
        <ClientRoot>{children}</ClientRoot>
      </body>
    </html>
  )
}
