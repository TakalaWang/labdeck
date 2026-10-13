import type { DB, Row } from './db.ts'
import { ValueErr } from './util.ts'

// 約定 C: the hosts table is the only host inventory (web, runner, Ansible, Prometheus).

export type InvHost = { ip: string; groups: string[]; monitored: boolean }

/** {name: {ip, groups, monitored}} from the hosts table, ordered by group then name. */
export function inventory(con: DB): Map<string, InvHost> {
  const out = new Map<string, InvHost>()
  for (const r of con.all('SELECT * FROM hosts ORDER BY group_name, name')) {
    out.set(r.name, {
      ip: r.address,
      groups: [r.group_name],
      monitored: Boolean(r.monitored),
    })
  }
  return out
}

/** A host named like a group would turn a one-host job into a group-wide one; call inside the write transaction. */
export function checkHostNames(con: DB): void {
  const clash = con.get<{ name: string }>('SELECT name FROM hosts WHERE name IN (SELECT group_name FROM hosts)')
  if (clash) throw new ValueErr(`主機名稱與群組名稱相同：${clash.name}`)
}

/**
 * The Ansible inventory the runner writes before every run (and whenever the hosts change) for ansible-playbook -i
 * and the cli service: YAML-plugin JSON. Hostvars: ansible_host, ansible_ssh_retries 0 for ssh_no_retry hosts;
 * never ansible_user (the runner passes -e ansible_user=$BOT_USER).
 */
export function ansibleInventory(con: DB) {
  let rows: Row[]
  try {
    rows = con.all('SELECT name, address, group_name, ssh_no_retry FROM hosts ORDER BY name')
  } catch {
    // a DB not migrated yet (no ssh_no_retry column)
    rows = con.all('SELECT name, address, group_name, 0 AS ssh_no_retry FROM hosts ORDER BY name')
  }
  const children: Record<string, { hosts: Record<string, Record<string, unknown>> }> = {}
  for (const r of rows) {
    const vars: Record<string, unknown> = { ansible_host: r.address }
    if (r.ssh_no_retry) vars.ansible_ssh_retries = 0 // the host bans IPs opening SSH often: override ansible.cfg retries
    ;(children[r.group_name] ??= { hosts: {} }).hosts[r.name] = vars
  }
  return { all: { children } }
}

/** {group: [hosts], _meta.hostvars} view of ansibleInventory (what `ansible-inventory --list` shows). */
export function inventoryHostvars(con: DB): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const g of Object.values(ansibleInventory(con).all.children)) {
    for (const [h, vars] of Object.entries(g.hosts)) out[h] = { ...(out[h] ?? {}), ...vars }
  }
  return out
}
