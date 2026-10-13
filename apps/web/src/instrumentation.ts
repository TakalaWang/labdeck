// Runs once when the server starts (see instrumentation-node.ts).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await (await import('./instrumentation-node')).loadSettings()
}
