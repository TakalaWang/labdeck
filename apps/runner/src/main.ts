// Runner entry point: `node apps/runner/src/main.ts` (Node 24 runs the TypeScript directly).
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { config, db, initDb, now, openDb } from '@labdeck/core'
import { sendDue } from './outbox.ts'
import { SSH_KEY, runJob, scheduled, writeInventory, writePrivate, writeTargets } from './runner.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Personal notifications on their own connection and timer: a 2 h job never delays them, a slow SMTP never a job. */
async function deliver(): Promise<never> {
  const con = openDb()
  for (;;) {
    try {
      await sendDue(con)
    } catch (e) {
      console.error('notifications:', e instanceof Error ? e.name : 'Error')
    }
    await sleep(5000)
  }
}

async function main(): Promise<void> {
  initDb()
  for (const leftover of readdirSync(config.jobsDir)) rmSync(path.join(config.jobsDir, leftover), { force: true }) // may hold a temp password
  if (existsSync('/run/secrets/ssh_key')) {
    mkdirSync(path.dirname(SSH_KEY), { recursive: true, mode: 0o700 })
    writePrivate(SSH_KEY, readFileSync('/run/secrets/ssh_key', 'utf8'))
  }
  const con = db()
  con.tx(() => con.run(`UPDATE jobs SET status='failed', finished_at=?,
                        output=COALESCE(output, '') || char(10) || '[runner] runner restarted' WHERE status='running'`, now()))
  console.log('runner started')
  void deliver()
  // ponytail: single global job loop; a long job (≤2h timeout) delays the rest. Upgrade: a worker per kind.
  for (;;) {
    for (const [what, write] of [['targets.json', writeTargets], ['inventory', writeInventory]] as const) {
      try {
        write(con)
      } catch (e) {
        console.error(`write ${what}:`, e)
      }
    }
    let job: Record<string, any> | undefined
    try {
      await scheduled(con, new Date())
      job = con.get("SELECT * FROM jobs WHERE (status='queued' AND run_at <= ?) OR status='confirmed' ORDER BY id LIMIT 1", now())
      if (job) {
        console.log(`job #${job.id} ${job.kind}`)
        await runJob(con, job)
        continue
      }
    } catch (e) {
      console.error('runner loop:', e)
      if (job) {
        const msg = `[runner] ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
        con.tx(() => con.run("UPDATE jobs SET status='failed', output=?, finished_at=? WHERE id=? AND status='running'", msg, now(), job!.id))
      }
    }
    await sleep(5000)
  }
}

process.on('SIGTERM', () => process.exit(0))
await main()
