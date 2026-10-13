import { handle } from '@/server'

// /auth/callback (OAuth), /auth/discord/start and /auth/discord/callback: browser redirects, same dispatcher as /api/*.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// No HEAD export: Next.js then routes HEAD to GET, and handle() answers HEAD with 405.

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as OPTIONS }
