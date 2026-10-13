// Ansible dynamic inventory (約定 C) read straight from the DB, for the cli service: a host added on the web is
// targetable at once. (The runner itself writes inventory.json right before each of its own runs.)
import { ansibleInventory, openDb } from '@labdeck/core'

export function scriptInventory(inv: ReturnType<typeof ansibleInventory>) {
  const out: Record<string, unknown> = {}
  const hostvars: Record<string, Record<string, unknown>> = {}
  for (const [group, { hosts }] of Object.entries(inv.all.children)) {
    out[group] = { hosts: Object.keys(hosts) }
    for (const [h, vars] of Object.entries(hosts)) hostvars[h] = { ...(hostvars[h] ?? {}), ...vars }
  }
  return { ...out, _meta: { hostvars } }
}

if (import.meta.main) {
  if (process.argv[2] === '--host') {
    console.log('{}') // everything is in _meta
  } else {
    const con = openDb()
    try {
      console.log(JSON.stringify(scriptInventory(ansibleInventory(con))))
    } finally {
      con.close()
    }
  }
}
