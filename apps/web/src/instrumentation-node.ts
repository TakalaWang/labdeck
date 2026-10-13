/** Load the settings at startup: a production server without a valid SESSION_SECRET exits instead of failing every API request. */
export async function loadSettings(): Promise<void> {
  try {
    await import('@labdeck/core')
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
