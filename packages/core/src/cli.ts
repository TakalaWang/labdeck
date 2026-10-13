// Admin CLI (in the web or runner container):
//   node packages/core/src/cli.ts init-db | add-admin <sso_id> <linux_username> | demote-admin <linux_username>
// demote-admin is the only way to take admin rights away: the web and the API can promote but never demote
// (docs/admin-guide.md, emergency procedure).
import { SSO_ID_RE, config, validUsername } from './config.ts'
import { DB, initDb } from './db.ts'
import { notify } from './io.ts'
import { audit } from './store.ts'
import { now } from './time.ts'

/** 'ok' | 'missing' | 'not_admin' | 'last' (the only active admin: add another one first). */
function demoteAdmin(con: DB, username: string): 'ok' | 'missing' | 'not_admin' | 'last' {
  return con.tx(() => {
    const p = con.get<{ id: number; role: string }>('SELECT id, role FROM people WHERE username=?', username)
    if (!p) return 'missing'
    if (p.role !== 'admin') return 'not_admin'
    if (!con.value<number>("SELECT COUNT(*) FROM people WHERE role='admin' AND status='active' AND id != ?", p.id)) return 'last'
    con.run("UPDATE people SET role='member' WHERE id=?", p.id)
    audit(con, 'cli', 'admin_demote', username)
    return 'ok'
  })
}

async function main(args: string[]): Promise<number> {
  initDb()
  if (args.length === 1 && args[0] === 'init-db') {
    console.log(`initialized ${config.dbPath}`)
    return 0
  }
  if (args.length === 3 && args[0] === 'add-admin' && SSO_ID_RE.test(args[1]) && validUsername(args[2])) {
    const [, ssoId, username] = args
    const con = new DB(config.dbPath)
    con.tx(() => {
      const row = con.get<{ id: number }>('SELECT id FROM people WHERE username=?', username)
      if (row) con.run("UPDATE people SET sso_id=?, role='admin', status='active', removed_at=NULL WHERE id=?", ssoId, row.id)
      else {
        con.run("INSERT INTO people(username, sso_id, role, status, created_at) VALUES (?,?,'admin','active',?)", username, ssoId, now())
      }
      audit(con, 'cli', 'add_admin', username, { sso_id: ssoId })
    })
    con.close()
    console.log(`${username} (${ssoId}) is now an admin`)
    return 0
  }
  if (args.length === 2 && args[0] === 'demote-admin') {
    const username = args[1]
    const con = new DB(config.dbPath)
    const result = demoteAdmin(con, username)
    con.close()
    if (result === 'missing') console.error(`no person named ${username}`)
    else if (result === 'not_admin') console.error(`${username} is not an admin`)
    else if (result === 'last') {
      console.error(`${username} is the only active admin; add another one first (labdeck add-admin <sso_id> <linux_username>)`)
    } else {
      await notify(`[管理員] ${username} 的管理員權限已由伺服器指令（labdeck demote-admin）移除`)
      console.log(`${username} is no longer an admin`)
      return 0
    }
    return 1
  }
  console.error('usage: labdeck init-db | add-admin <sso_id> <linux_username> | demote-admin <linux_username>')
  return 1
}

process.exitCode = await main(process.argv.slice(2))
