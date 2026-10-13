import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync, constants } from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  type DB, PLAYBOOKS, PromError, type Row, STALE_USERS_JOB, ValueErr, addMinutes, ansibleInventory, audit, cmp, config,
  daysBetween, describeJob, enqueue, failureSummary, ingest, localIso, notifications as nt, notify, now, parseIso, prom, pyJson,
  usersJobStale, validateJob,
} from '@labdeck/core'

// Job runner: executes queued jobs one at a time and runs the daily schedule (約定 F). The only process that
// holds the SSH key and the vault; it runs nothing but the allowlisted playbooks.

export const SSH_KEY = '/home/app/.ssh/id_ed25519'
const MAX_OUTPUT = 200_000
const TIMEOUT_MS = 2 * 3600_000
/** The bot's sudo password differs per host (set by bootstrap_bot.yaml): one host can't reveal another's. */
const BECOME_PASSWORD = "{{ (vault_bot_become_password ~ inventory_hostname) | hash('sha256') }}"

/** ansible-playbook command line exactly per 約定 F (an argv list, never a shell string). */
export function argv(kind: string, jobFile: string, check = false): string[] {
  if (!Object.hasOwn(PLAYBOOKS, kind)) throw new ValueErr(`unknown job kind '${kind}'`)
  return ['ansible-playbook', '-i', config.inventoryPath, `${config.ansibleDir}/${PLAYBOOKS[kind]}`,
    '--private-key', SSH_KEY, '--vault-password-file', '/run/secrets/vault_pass',
    '-e', '@/run/secrets/vault.yml', '-e', `ansible_user=${config.botUser}`,
    '-e', `ansible_become_password=${BECOME_PASSWORD}`,
    '-e', `@${jobFile}`, ...(check ? ['--check', '--diff'] : [])]
}

/** † fields (約定 F): from config at execution time; never web input, never stored in jobs.args_json. */
export function injected(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'collect':
      return { data_mount_glob: config.dataMountGlob }
    case 'agents':
      return { data_mount_glob: config.dataMountGlob, node_exporter_port: config.nodeExporterPort, monitoring_source: config.monitoringSource }
    case 'users':
      return { reserved_users: [...config.reserved].sort(cmp) }
    default:
      return {}
  }
}

/** Create `file` with `mode` (0600) before any data lands in it, replacing an older one and never following a symlink. */
export function writePrivate(file: string, data: string, mode = 0o600): void {
  rmSync(file, { force: true })
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
  try {
    fchmodSync(fd, mode) // the umask may have narrowed it
    writeFileSync(fd, data)
  } finally {
    closeSync(fd)
  }
}

/** Atomically replace `file` when its content changed; an unchanged file still gets `mode`. */
function writeIfChanged(file: string, data: string, mode: number): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === data) {
    if ((statSync(file).mode & 0o777) !== mode) chmodSync(file, mode)
    return false
  }
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file.replace(/\.json$/, '.tmp')
  writePrivate(tmp, data, mode)
  renameSync(tmp, file)
  return true
}

export type RunResult = { rc: number; out: string }
type RunOptions = { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }

/** Run a command, stdout and stderr merged in arrival order (stderr=STDOUT); invalid UTF-8 becomes U+FFFD. */
function runProcess(cmd: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.stdout.on('data', (b: Buffer) => chunks.push(b))
    child.stderr.on('data', (b: Buffer) => chunks.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks).toString('utf8')
      resolve(timedOut ? { rc: -1, out: `${out}\n[runner] timeout after 2h` } : { rc: code ?? -1, out })
    })
  })
}

/** Ways out of the runner that tests replace (the former tests patched subprocess.run). */
export const runnerIo = { run: runProcess }

/** Prometheus file_sd (約定 C) for monitored hosts; atomic rename, only when the content changed. */
export function writeTargets(con: DB): boolean {
  const port = config.nodeExporterPort
  const targets = con.all('SELECT name, address, group_name FROM hosts WHERE monitored=1 ORDER BY name').map((r) => ({
    targets: [r.address.includes(':') ? `[${r.address}]:${port}` : `${r.address}:${port}`], // IPv6
    labels: { instance: r.name, group: r.group_name },
  }))
  return writeIfChanged(path.join(config.promSdDir, 'targets.json'), `${JSON.stringify(targets, null, 1)}\n`, 0o644) // prometheus runs as another user
}

/** The Ansible inventory (約定 C) from the hosts table, for the runner's ansible-playbook -i and the cli service. */
export function writeInventory(con: DB): boolean {
  return writeIfChanged(config.inventoryPath, `${JSON.stringify(ansibleInventory(con), null, 1)}\n`, 0o600)
}

/**
 * The part of the runner's environment ansible-playbook may see: the basics, ANSIBLE_*, and what the playbooks read
 * with lookup('env', …) (bootstrap_bot.yaml: BOT_USER, MONITORING_SOURCE, KNOWN_HOSTS). Never SESSION_SECRET,
 * OAUTH_*, DISCORD_*, SMTP_* — a playbook (or a module it runs) has no business with them.
 */
const PLAYBOOK_ENV = /^(PATH|HOME|TZ|LANG|LC_[A-Z_]+|ANSIBLE_[A-Z0-9_]+|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|BOT_USER|MONITORING_SOURCE|KNOWN_HOSTS)$/

export function playbookEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(from).filter(([k]) => PLAYBOOK_ENV.test(k)))
}

/**
 * Run one playbook with a 0600 job file that is deleted afterwards.
 * The job file is JSON under one YAML `!unsafe` tag: Ansible never templates any value in it, so a `{{ … }}` that
 * slipped into a payload stays literal (tagging each string instead would turn "2027-07-31" into a date —
 * Ansible re-resolves the implicit type of every !unsafe scalar).
 */
export async function play(con: DB, kind: string, args: Record<string, unknown>, jobId: number, check = false): Promise<RunResult> {
  const file = `${config.jobsDir}/${jobId}.yml`
  writeInventory(con)
  writePrivate(file, `!unsafe ${JSON.stringify(args)}`)
  const env: NodeJS.ProcessEnv = {
    ...playbookEnv(), ANSIBLE_CONFIG: `${config.ansibleDir}/ansible.cfg`, ANSIBLE_HOST_KEY_CHECKING: 'True', ANSIBLE_NOCOLOR: '1',
    DATA_DIR: config.dataDir,
    // One SSH connection per host for a whole job: with a short ControlPersist, each task pass over many hosts
    // reopens every connection (hundreds per job), which campus firewalls / sshd MaxStartups throttle.
    ANSIBLE_SSH_ARGS: `-o UserKnownHostsFile=${config.dataDir}/known_hosts -o StrictHostKeyChecking=yes`
      + ' -o ControlMaster=auto -o ControlPersist=30m -o ServerAliveInterval=30',
  }
  let r: RunResult
  try {
    r = await runnerIo.run(argv(kind, file, check), { cwd: config.ansibleDir, env, timeoutMs: TIMEOUT_MS })
  } finally {
    rmSync(file, { force: true })
  }
  const out = r.out.length <= MAX_OUTPUT ? r.out : `[前段輸出已截斷]\n${r.out.slice(-MAX_OUTPUT)}`
  return { rc: r.rc, out }
}

/** person_ids (null = unknown) of users-job entries that will create a new account. */
function creating(con: DB, args: { accounts: Record<string, { username: string; state: string }[]> }): Set<number | null> {
  const found = new Set<number | null>()
  for (const [host, entries] of Object.entries(args.accounts)) {
    for (const e of entries) {
      if (e.state !== 'present') continue
      const r = con.get('SELECT exists_on_host, person_id FROM accounts WHERE host=? AND username=?', host, e.username)
      if (!r || r.exists_on_host !== 1) found.add(r ? r.person_id : null)
    }
  }
  return found
}

const SSH_KINDS = new Set(['collect', 'agents', 'users'])

/**
 * Prometheus has node targets and none is up → this box is off campus / VPN dropped. SSH from here would only pile
 * up failed logins (labbot's key is from=-restricted), which gets the IP banned by the campus IDS.
 */
export async function networkDown(): Promise<boolean> {
  try {
    return (await prom('sum(up{job="node"}) == 0')).length > 0
  } catch (e) {
    if (e instanceof PromError) return false
    throw e
  }
}

/** 「指派 xiaoming @gpu01（#12）」: how the admin channel names a job. */
function jobTitle(con: DB, jobId: number): string {
  const j = con.get('SELECT kind, args_json, auto_confirm FROM jobs WHERE id=?', jobId)
  return `${j ? describeJob(j.kind, JSON.parse(j.args_json), Boolean(j.auto_confirm)) : 'job'}（#${jobId}）`
}

/** Only a running job is ever finished (a cancel or restart may have changed it meanwhile). */
export async function finish(con: DB, jobId: number, status: string, output: string): Promise<void> {
  con.tx(() => con.run("UPDATE jobs SET status=?, output=?, finished_at=? WHERE id=? AND status='running'", status, output, now(), jobId))
  if (status === 'failed') {
    await notify(`[失敗] ${jobTitle(con, jobId)}：${failureSummary(output)}\n${config.publicUrl}/admin/jobs/${jobId}`)
  }
}

export async function runJob(con: DB, job: Row): Promise<void> {
  const jobId = job.id as number
  const kind = job.kind as string
  const args = JSON.parse(job.args_json)
  if (con.tx(() => con.run("UPDATE jobs SET status='running' WHERE id=? AND status=?", jobId, job.status).changes) !== 1) return // cancelled meanwhile
  if (!Object.hasOwn(PLAYBOOKS, kind)) {
    // power / shutdown / bmc_check: removed, their old rows stay for the history but never run
    return finish(con, jobId, 'failed', `[runner] 已停用的工作類型 ${kind}，未執行`)
  }
  try {
    validateJob(kind, args, con)
  } catch (e) {
    if (!(e instanceof ValueErr)) throw e
    return finish(con, jobId, 'failed', `[runner] payload rejected: ${e.message}`)
  }
  if (SSH_KINDS.has(kind) && (await networkDown())) {
    return finish(con, jobId, 'failed', '[runner] 所有主機的監控都無回應（VPN／網路可能中斷），未執行以免連續 SSH 失敗被學校封鎖')
  }
  const runArgs: Record<string, unknown> = { ...args, ...injected(kind) }
  // only_user: the job an admin queued by assigning one host to one person (enqueueHostAccount records it)
  const scoped = kind === 'users' && 'only_user' in args
  if (scoped && !(job.auto_confirm && con.get(
    `SELECT 1 FROM assignments a JOIN people p ON p.id = a.person_id
     WHERE a.job_id=? AND a.host=? AND p.username=? AND p.status='active'`, jobId, args.target_hosts, args.only_user))) {
    return finish(con, jobId, 'failed', '[runner] 單一帳號的 job 沒有對應的管理員指派紀錄，未執行')
  }
  if (kind === 'users' && job.auto_confirm && !scoped) runArgs.keys_only = true // † nobody previewed it: only keys of existing accounts

  if (kind === 'users' && job.status === 'queued' && !job.auto_confirm) {
    const { rc, out } = await play(con, kind, runArgs, jobId, true)
    // ansible-playbook: 0 = ok, 2 = a task failed on a host (still a preview to read); anything else (4 unreachable,
    // 1 / 3 / 5 errors…) produced no preview at all, so there is nothing to confirm
    const previewed = rc === 0 || rc === 2
    const checkOutput = `[rc=${rc}]\n${out}`
    con.tx(() => con.run("UPDATE jobs SET status=?, check_output=?, finished_at=? WHERE id=? AND status='running'",
      previewed ? 'awaiting' : 'check_failed', checkOutput, previewed ? null : now(), jobId))
    const link = `${config.publicUrl}/admin/jobs/${jobId}`
    await notify(previewed
      ? `[待確認] ${jobTitle(con, jobId)}預覽完成（rc=${rc}）：${link}`
      : `[預檢失敗] ${jobTitle(con, jobId)}：${failureSummary(out, true)}\n${link}`)
    return
  }

  let password: string | null = null
  let note = ''
  let fresh = new Set<number | null>()
  if (kind === 'users') {
    if (usersJobStale(con, args)) return finish(con, jobId, 'failed', `[runner] ${STALE_USERS_JOB}`) // e.g. a key revoked after the preview
    fresh = creating(con, args)
    if (fresh.size && job.auto_confirm && !scoped) {
      return finish(con, jobId, 'failed', '[runner] 自動確認的 job 不可建立帳號，請改用「同步」（需預覽）')
    }
    if (fresh.size === 1 && !fresh.has(null)) {
      // ponytail: one temp password per job, so only single-person creations get one; others are key-only.
      const pid = [...fresh][0]
      // pending until a job creating this person's account succeeds: the owner only sees a password that works
      con.tx(() => con.run('UPDATE people SET temp_password=?, temp_password_pending=1 WHERE id=? AND temp_password IS NULL',
        randomBytes(12).toString('base64url'), pid))
      password = con.value<string>('SELECT temp_password FROM people WHERE id=?', pid) ?? null
    } else if (fresh.size) {
      note = '[runner] 此 job 同時為多人建立帳號，未設定臨時密碼（僅 SSH key 登入）\n'
    }
  }

  const started = Date.now() / 1000
  let { rc, out } = await play(con, kind, password ? { ...runArgs, temp_password: password } : runArgs, jobId)
  if (password) out = out.replaceAll(password, '********')
  await finish(con, jobId, rc === 0 ? 'ok' : 'failed', note + out)
  if (kind === 'collect') ingest(con, started - 5) // partial success still leaves fresh files for the reachable hosts
  if (kind === 'agents') {
    // per host: one unreachable host must not keep the installed ones out of Prometheus
    const done = recapOk(out, String(args.target_hosts).split(','))
    if (done.length) agentsDone(con, done.join(','))
  }
  if (kind === 'users') {
    con.tx(() => {
      if (rc === 0) {
        // the account now exists with the temp password: show it to its owner (an assignment's rerun counts too,
        // e.g. after a run that created the account but failed later)
        const owners = [...fresh].filter((p): p is number => p !== null)
        if (scoped) owners.push(con.value<number>('SELECT person_id FROM assignments WHERE job_id=?', jobId)!)
        for (const pid of owners) con.run('UPDATE people SET temp_password_pending=0 WHERE id=? AND temp_password IS NOT NULL', pid)
      }
      enqueue(con, 'runner', 'collect', { collect_dir: config.collectDir, target_hosts: args.target_hosts })
    })
  }
}

/** Hosts that finished the play without failures ("ignored" ones count as fine), from the PLAY RECAP. */
export function recapOk(output: string, hosts: string[]): string[] {
  const ok = new Set([...output.matchAll(/^(\S+)\s+: ok=\d+\s+changed=\d+\s+unreachable=0\s+failed=0\b/gm)].map((m) => m[1]))
  return hosts.filter((h) => ok.has(h))
}

/** Monitoring agents are installed → list these hosts in Prometheus (約定 F). */
export function agentsDone(con: DB, targetHosts: string): void {
  con.tx(() => {
    for (const h of targetHosts.split(',')) con.run('UPDATE hosts SET monitored=1 WHERE name=?', h)
    audit(con, 'runner', 'host_monitored', targetHosts)
  })
}

/** Idempotent daily tasks; state lives in the DB / backup dir so restarts don't repeat them. `t` is local time. */
export async function scheduled(con: DB, t: Date): Promise<void> {
  const today = localIso(t).slice(0, 10)
  if (t.getHours() >= 3 && !con.get("SELECT 1 FROM jobs WHERE kind='collect' AND actor='scheduler' AND created_at >= ?", today)) {
    // monitored hosts only: an un-bootstrapped or dead host would just add failed SSH logins every night
    const hosts = con.all('SELECT name FROM hosts WHERE monitored = 1 ORDER BY name').map((r) => r.name)
    if (hosts.length) con.tx(() => enqueue(con, 'scheduler', 'collect', { collect_dir: config.collectDir, target_hosts: hosts.join(',') }))
  }

  if (t.getHours() >= 9) {
    const lines: string[] = []
    for (const p of con.all("SELECT * FROM people WHERE status='active' AND expires_at IS NOT NULL")) {
      const days = daysBetween(today, p.expires_at)
      const threshold = [30, 7, 0].filter((x) => days <= x).sort((a, b) => a - b)[0] ?? null
      const detail = { expires_at: p.expires_at, threshold }
      if (threshold === null || con.get("SELECT 1 FROM audit WHERE action='expiry_reminder' AND target=? AND detail_json=?",
        `people/${p.id}`, pyJson(detail, { sortKeys: true, ensureAscii: false }))) continue
      lines.push(`- ${p.username}：${p.expires_at}（${days > 0 ? `剩 ${days} 天）` : '已到期）'}`)
      con.tx(() => {
        audit(con, 'scheduler', 'expiry_reminder', `people/${p.id}`, detail)
        nt.expiry(con, p, days, threshold)
      })
    }
    if (lines.length) await notify(`[帳號到期提醒]\n${lines.join('\n')}`)
  }

  // Maintenance windows: a personal reminder 24 h before the start (none if announced later).
  for (const a of con.all(`SELECT id, starts_at, created_at FROM announcements WHERE reminded_at IS NULL
                           AND hosts IS NOT NULL AND starts_at > ? AND starts_at <= ?`,
  localIso(t), localIso(addMinutes(t, 24 * 60)))) {
    con.tx(() => {
      con.run('UPDATE announcements SET reminded_at=? WHERE id=?', now(), a.id)
      if (parseIso(a.created_at).getTime() < parseIso(a.starts_at).getTime() - 24 * 3600_000) nt.announcement(con, a.id, 'reminder')
    })
  }

  const file = path.join(config.backupDir, `portal-${today.replaceAll('-', '')}.db`)
  if (t.getHours() >= 4 && !existsSync(file)) {
    const tmp = file.replace(/\.db$/, '.tmp')
    writePrivate(tmp, '') // 0600 before any data lands in it
    await backup(con.raw, tmp)
    const dst = new DatabaseSync(tmp)
    try {
      dst.exec('PRAGMA secure_delete=ON') // zero the cleared values instead of leaving them in free pages
      dst.exec('BEGIN; UPDATE people SET temp_password=NULL; COMMIT') // shown to its owner once; backups never keep it
    } finally {
      dst.close()
    }
    renameSync(tmp, file)
    const old = readdirSync(config.backupDir).filter((f) => /^portal-.*\.db$/.test(f)).sort(cmp)
    for (const f of old.slice(0, -14)) rmSync(path.join(config.backupDir, f))
  }
}

