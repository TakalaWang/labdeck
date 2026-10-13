// Dev-only fixture API (NEXT_PUBLIC_MOCK=1 next dev). Patches window.fetch for /api/* so the SPA can be
// built and reviewed without the backend. Never imported by production builds.
//
// URL switches (persisted in localStorage):
//   ?mock_role=anon|identity|member|admin   who is "logged in" (default admin)
//   ?mock_metrics=down|up                   simulate Prometheus outage (502)
import type { AccountRequest, Host, HostAccount, HostInput, JobDetail, NotifySettings, Person, Range, Session } from '@/lib/types'

import * as d from './data'

type Role = 'anon' | 'identity' | 'member' | 'admin'
type Result = { status: number; body?: unknown; text?: string }

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // ignore
    }
  },
}

function readSwitches() {
  const p = new URLSearchParams(location.search)
  const role = p.get('mock_role')
  if (role) ls.set('mock:role', role)
  const metrics = p.get('mock_metrics')
  if (metrics) ls.set('mock:metrics', metrics)
}

const role = (): Role => (ls.get('mock:role') as Role | null) ?? 'admin'
const metricsDown = () => ls.get('mock:metrics') === 'down'
const me = () => (role() === 'admin' ? d.people[0] : d.people[1])
let tempPassword: string | null = 'Tq4-mZ8r-Kx2w'
const notify: NotifySettings = {
  events: [
    { key: 'expiry', label: '帳號即將到期（30／7／0 天前）' },
    { key: 'maintenance', label: '我有帳號的主機排定關機／維護' },
  ],
  discord: { available: true, linked: true, name: 'Alice' },
  email: { available: true, address: 'alice@example.edu', sso_address: 'alice@example.edu', pending: null },
  prefs: { discord: ['maintenance'], email: ['expiry', 'maintenance'] },
}

const GUIDE_VALUES: Record<string, string> = { site_name: 'LabDeck', oauth_name: 'SSO', public_url: location.origin }

const ok = (body: unknown): Result => ({ status: 200, body })
const err = (status: number, error: string): Result => ({ status, body: { error } })
let nextJob = Math.max(...d.jobs.map((j) => j.id)) + 1
function newJob(kind: string, target: string[], extra: Partial<JobDetail> = {}): number {
  const id = nextJob++
  const t = new Date().toISOString()
  d.jobs.unshift({ id, kind, target_hosts: target, status: 'queued', actor: me().username, created_at: t, run_at: t, finished_at: null, auto_confirm: true, args: { target_hosts: target.join(',') }, check_output: null, output: null, summary: `${kind} @${target.join('、')}`, scoped: false, failure: null, ...extra })
  return id
}

function session(): Session {
  const r = role()
  const user = r === 'admin' || r === 'member' ? me() : null
  return {
    site: { name: 'LabDeck', oauth_name: 'SSO' },
    csrf: 'mock-csrf-token',
    user: user
      ? { id: user.id, username: user.username, name: user.name, email: user.email, sso_id: user.sso_id, role: user.role, status: user.status, expires_at: user.expires_at }
      : null,
    identity: r === 'anon' ? null : { sso_id: user?.sso_id ?? 'newbie06', email: user?.email ?? 'newbie@example.org' },
  }
}

function asSeenBy(h: Host): Host {
  const primary_users = d.hostAccounts(h.name).filter((a) => a.primary).map((a) => ({ username: a.username, name: a.person?.name ?? null }))
  return { ...h, primary_users }
}

/** api.md: a person's name / Discord name only for admins, or on a primary user's row. */
function accountSeenBy(a: HostAccount, isAdmin: boolean): HostAccount {
  return isAdmin || a.primary || !a.person ? a : { ...a, person: { id: a.person.id, username: a.person.username } }
}

/** PUT/POST body → the host, as the backend stores it. */
function applyHostInput(h: Host, b: HostInput) {
  Object.assign(h, b, { ssh_no_retry: !!b.ssh_no_retry })
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const GROUP_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

function route(method: string, url: URL, body: Record<string, unknown> | undefined): Result {
  const p = url.pathname
  const r = role()
  const isAdmin = r === 'admin'
  const isMember = r === 'admin' || r === 'member'
  d.tickJobs()

  // public
  if (p === '/api/session') return ok(session())
  if (p === '/api/announcements') return ok(d.announcements)
  if (p === '/api/logout' && method === 'POST') {
    ls.set('mock:role', 'anon')
    return ok({})
  }
  if (r === 'anon') return err(401, '請先登入')

  // identity: registration (登記)
  if (p === '/api/register') {
    const sso = isMember ? me().sso_id : 'newbie06'
    const mine = d.requests.filter((x) => x.kind === 'account' && x.sso_id === sso)
    const pending = mine.find((x) => x.status === 'pending')
    if (method === 'POST' || method === 'PUT') {
      if (isMember) return err(403, '你已有實驗室帳號，不需登記')
      const t = new Date().toISOString()
      const fields = { name: String(body?.name), username: String(body?.username), purpose: String(body?.purpose), gpus: Number(body?.gpus),
        min_vram_gb: body?.min_vram_gb == null ? null : Number(body.min_vram_gb), until: String(body?.until), updated_at: t }
      if (method === 'PUT') {
        if (!pending) return err(404, '沒有等待中的登記')
        Object.assign(pending, fields)
        return ok(pending)
      }
      if (pending) return err(409, '你已經登記過，等待指派中；可以修改登記內容')
      const r: AccountRequest = { id: 100 + d.requests.length, kind: 'account', person_id: null, sso_id: 'newbie06', email: 'newbie@example.org',
        hosts: [], status: 'pending', created_at: t, decided_by: null, decided_at: null, job_id: null, jobs: [], reject_reason: null, ...fields }
      d.requests.unshift(r)
      return ok(r)
    }
    return ok({ registration: mine[0] ?? null, can_register: !isMember && !pending })
  }
  if (p === '/api/guide') {
    const fill = (t: string) => t.replace(/\{\{\s*(site_name|oauth_name|public_url)\s*\}\}/g, (_, k: string) => GUIDE_VALUES[k])
    return ok({ markdown: fill(d.guide.source), members_markdown: isMember && d.guide.members ? fill(d.guide.members) : null, updated_at: d.guide.updated_at, updated_by: d.guide.updated_by, is_default: d.guide.updated_at === null })
  }
  if (!isMember) return err(403, '尚未開通實驗室帳號')

  // member
  if (p === '/api/summary') {
    const board = d.gpuBoard()
    const gpus = board.hosts.flatMap((h) => h.gpus)
    const down = metricsDown()
    return ok({
      hosts_total: d.hosts.length,
      hosts_up: down ? null : d.hosts.filter((h) => d.specs.get(h.name)?.up && h.monitored).length,
      // api.md: total and idle from the same source — the GPU board, or the collected facts while metrics are down
      gpus_total: down ? d.hosts.reduce((n, h) => n + (h.gpu_count ?? 0), 0) : gpus.length,
      gpus_idle: down ? null : gpus.filter((g) => g.idle).length,
      announcements: d.announcements,
      metrics_ok: !down,
    })
  }
  if (p === '/api/hosts') return ok(d.hosts.map((h) => asSeenBy(d.hostWithStatus(h, metricsDown()))))
  let m = p.match(/^\/api\/hosts\/([^/]+)$/)
  if (m) {
    const h = d.hosts.find((x) => x.name === decodeURIComponent(m![1]))
    if (!h) return err(404, '找不到主機')
    const s = d.specs.get(h.name)!
    const facts = h.facts_at
      ? {
          os: h.os, kernel: h.kernel, cpu_model: h.cpu_model, cpu_count: h.cpu_count, mem_mb: 257587, nvidia_driver: h.nvidia_driver, cuda: h.cuda, gpu_pci_count: s.count,
          gpus: Array.from({ length: s.smi ?? s.count }, (_, i) => ({ index: i, name: s.model, uuid: `GPU-${h.name}-${i}a1b2c3d4`, memory_mb: s.memGiB * 1024 })),
          disks: [
            { name: 'nvme0n1', size_bytes: 1.92e12, model: 'SAMSUNG MZQL21T9HCJR', serial: 'S64GNE0R000001', rota: false },
            { name: 'sda', size_bytes: 1.6e13, model: 'ST16000NM001G', serial: 'ZL2000A1', rota: true },
            { name: 'sdb', size_bytes: 1.6e13, model: 'ST16000NM001G', serial: 'ZL2000A2', rota: true },
          ],
          mounts: [
            { mountpoint: '/', size_bytes: 9.4e11, used_bytes: 5.6e11 },
            { mountpoint: '/home', size_bytes: 1.8e12, used_bytes: 1.3e12 },
            { mountpoint: '/data0', size_bytes: 3.2e13, used_bytes: 2.7e13 },
          ],
        }
      : {} // never collected: the backend passes an empty object through
    return ok({
      ...asSeenBy(d.hostWithStatus(h, metricsDown())),
      facts,
      accounts: d.hostAccounts(h.name).map((a) => accountSeenBy(a, isAdmin)),
      bootstrap_command: isAdmin
        ? `docker compose run --rm cli ansible-playbook playbooks/bootstrap_bot.yaml -l ${h.name} -u <既有管理帳號> --ask-pass --ask-become-pass -e @/run/secrets/vault.yml -e monitoring_host_ip=<監控主機 IP>`
        : undefined,
    })
  }
  m = p.match(/^\/api\/metrics\/hosts\/([^/]+)\/gpu-hours$/)
  if (m) {
    if (metricsDown()) return err(502, '監控資料暫時無法取得')
    const name = decodeURIComponent(m[1])
    const users = d.hostAccounts(name).filter((a) => a.exists && !a.locked).map((a, i) => ({ user: a.username, gpu_hours: Math.round((name.length * 97 + i * 211) % 480) + 0.5 }))
    return ok({ days: 30, users: users.filter((u) => u.user !== 'olduser').sort((a, b) => b.gpu_hours - a.gpu_hours) })
  }
  m = p.match(/^\/api\/metrics\/hosts\/([^/]+)\/users$/)
  if (m) {
    if (metricsDown()) return err(502, '監控資料暫時無法取得')
    const name = decodeURIComponent(m[1])
    return d.hosts.some((h) => h.name === name) ? ok(d.hostLoad(name)) : err(404, '找不到主機')
  }
  m = p.match(/^\/api\/metrics\/hosts\/([^/]+)$/)
  if (m) {
    if (metricsDown()) return err(502, '監控資料暫時無法取得')
    const range = (url.searchParams.get('range') ?? '6h') as Range
    return ok(d.hostMetrics(decodeURIComponent(m[1]), range))
  }
  if (p === '/api/metrics/users') return metricsDown() ? err(502, '監控資料暫時無法取得') : ok(d.userLoad())
  if (p === '/api/metrics/gpus') return metricsDown() ? err(502, '監控資料暫時無法取得') : ok(d.gpuBoard())
  if (p === '/api/metrics/disk') return metricsDown() ? err(502, '監控資料暫時無法取得') : ok(d.diskUsage())
  if (p.startsWith('/api/metrics/') && metricsDown()) return err(502, '監控資料暫時無法取得')
  if (p === '/api/metrics/fleet') return ok(d.fleetHistory((url.searchParams.get('range') ?? '24h') as Range))
  if (p === '/api/metrics/history/gpus') return ok(d.gpuHistory())
  if (p === '/api/metrics/history/hosts') return ok(d.hostHistory())
  if (p === '/api/metrics/disk/filesystems') return ok(d.filesystems())
  if (p === '/api/metrics/disk/trend') return ok(d.diskTrend(Number(url.searchParams.get('days') ?? 30)))
  if (p === '/api/metrics/gpu-monthly') {
    if (metricsDown()) return err(502, '監控資料暫時無法取得')
    const month = url.searchParams.get('month') ?? new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 7)
    return ok(d.gpuMonthly(month))
  }
  if (p === '/api/calendar') {
    const start = new Date(`${url.searchParams.get('start')}T00:00`).getTime()
    const end = new Date(`${url.searchParams.get('end')}T23:59:59`).getTime()
    const events = d.announcements.filter((a) => {
      const s0 = new Date(a.starts_at ?? 0).getTime()
      const e0 = a.ends_at ? new Date(a.ends_at).getTime() : s0
      return s0 <= end && e0 >= start
    })
    return ok({ start: url.searchParams.get('start'), end: url.searchParams.get('end'), events, subscribe_url: `${location.origin}/api/calendar.ics?token=${me().id}.mock0123456789abcdef` })
  }
  if (p === '/api/me/temp-password/ack' && method === 'POST') {
    tempPassword = null
    return ok({})
  }
  if (p === '/api/me') {
    const u = me()
    return ok({ person: session().user, accounts: d.myAccounts(u.username), keys: u.id === 1 ? d.keys : [], temp_password: tempPassword, account_setup: null })
  }
  if (p === '/api/me/notifications' && method === 'PUT') {
    notify.prefs = { discord: (body?.discord as string[]) ?? [], email: (body?.email as string[]) ?? [] }
    return ok(notify)
  }
  if (p === '/api/me/notifications') return ok(notify)
  if (p === '/api/me/discord/unlink' && method === 'POST') {
    notify.discord = { ...notify.discord, linked: false, name: null }
    return ok(notify)
  }
  if (p === '/api/me/email' && method === 'POST') {
    notify.email = { ...notify.email, pending: String(body?.email ?? '') }
    return ok(notify)
  }
  if (p === '/api/me/email/verify' && method === 'POST') {
    if (body?.code !== '123456') return err(400, '驗證碼不正確')
    notify.email = { ...notify.email, address: notify.email.pending, pending: null }
    return ok(notify)
  }
  if (p === '/api/me/host-requests') {
    const u = me()
    if (method === 'POST') {
      if (d.requests.some((x) => x.kind === 'hosts' && x.person_id === u.id && x.status === 'pending')) return err(409, '你已有等待指派的主機申請')
      const t = new Date().toISOString()
      const req: AccountRequest = { id: 100 + d.requests.length, kind: 'hosts', person_id: u.id, sso_id: u.sso_id ?? '', email: u.email, name: null,
        username: u.username, purpose: String(body?.purpose), gpus: Number(body?.gpus), min_vram_gb: body?.min_vram_gb == null ? null : Number(body.min_vram_gb),
        until: String(body?.until), hosts: [], status: 'pending', created_at: t, updated_at: t, decided_by: null, decided_at: null, job_id: null, jobs: [], reject_reason: null }
      d.requests.unshift(req)
      return ok(req)
    }
    const mine = d.requests.filter((x) => x.kind === 'hosts' && x.person_id === u.id)
    return ok({ requests: mine, can_request: !mine.some((x) => x.status === 'pending') })
  }
  if (p === '/api/me/usage') {
    const u = me().username
    return ok({
      cpu_mem: d.userLoad().hosts.flatMap((h) => h.users.filter((x) => x.user === u && x.processes != null).map((x) => ({ host: h.host, cpu_cores: x.cpu_cores, mem_bytes: x.mem_bytes, processes: x.processes }))),
      gpu_processes: d.gpuBoard().hosts.flatMap((h) => h.gpus.flatMap((g) => g.processes.filter((x) => x.user === u).map((x) => ({ host: h.host, gpu: g.index, pid: x.pid, comm: x.comm, mem_bytes: x.mem_bytes })))),
      disk: d.diskUsage().rows.filter((x) => x.owner === u).map((x) => ({ host: x.host, path: x.path, bytes: x.bytes })),
    })
  }
  if (p === '/api/me/keys' && method === 'POST') {
    const pub = String(body?.pubkey ?? '').trim()
    if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) AAAA/.test(pub)) return err(400, '無法辨識的 public key 格式')
    const key = { id: d.keys.length + 1, fingerprint: `SHA256:mock${Date.now().toString(36)}`, type: pub.startsWith('ssh-ed25519') ? 'ED25519' : pub.startsWith('ssh-rsa') ? 'RSA' : 'ECDSA', comment: pub.split(' ')[2] ?? null, state: 'active' as const, added_at: new Date().toISOString() }
    d.keys.unshift(key)
    return ok({ key, job_id: newJob('users', ['gpu01', 'gpu02']) })
  }
  m = p.match(/^\/api\/me\/keys\/(\d+)\/revoke$/)
  if (m && method === 'POST') {
    const k = d.keys.find((x) => x.id === Number(m![1]))
    if (k) k.state = 'revoked'
    return ok({ job_id: newJob('users', ['gpu01', 'gpu02']) })
  }
  if (!isAdmin) return err(403, '權限不足')

  // admin
  if (p === '/api/admin/hosts' && method === 'POST') {
    const b = body as unknown as HostInput
    if (!b.name || !HOST_RE.test(b.name)) return err(400, '主機名稱格式不正確')
    if (!GROUP_RE.test(b.group)) return err(400, '群組名稱格式不正確')
    if (d.hosts.some((h) => h.name === b.name)) return err(409, `主機 ${b.name} 已存在`)
    const h: Host = {
      ...d.hosts[0], name: b.name, monitored: false, facts_at: null, status: null, os: null, kernel: null, cpu_model: null, cpu_count: null,
      mem_gb: null, nvidia_driver: null, cuda: null, gpu_summary: null, gpu_count: null, gpu_pci_count: null, disk_count: null,
    }
    applyHostInput(h, b)
    d.hosts.push(h)
    d.specs.set(h.name, { model: '', count: 0, memGiB: 0, up: false, nvidiaOk: false, monitored: false, group: h.group })
    return ok(h)
  }
  if (p === '/api/admin/hosts/import' && method === 'POST') {
    const lines = String(body?.csv ?? '').split('\n')
    const added: string[] = []
    const skipped: { name: string; reason: string }[] = []
    const errors: { line: number; error: string }[] = []
    lines.forEach((raw, i) => {
      const line = raw.trim()
      if (!line || (i === 0 && line.startsWith('name,'))) return
      const [name, address, group] = line.split(',').map((x) => x.trim())
      if (!name || !HOST_RE.test(name)) errors.push({ line: i + 1, error: '主機名稱格式不正確' })
      else if (!address) errors.push({ line: i + 1, error: '缺少位址' })
      else if (!group || !GROUP_RE.test(group)) errors.push({ line: i + 1, error: '群組名稱格式不正確' })
      else if (d.hosts.some((h) => h.name === name)) skipped.push({ name, reason: '已存在' })
      else added.push(name)
    })
    return ok({ added: errors.length ? [] : added, skipped, errors })
  }
  m = p.match(/^\/api\/admin\/hosts\/([^/]+)(?:\/(agents|collect))?$/)
  if (m) {
    const name = decodeURIComponent(m[1])
    const h = d.hosts.find((x) => x.name === name)
    if (!h) return err(404, '找不到主機')
    if (m[2]) return ok({ job_id: newJob(m[2], [name]) })
    if (method === 'PUT') {
      applyHostInput(h, body as unknown as HostInput)
      return ok(h)
    }
    if (method === 'DELETE') {
      if (body?.confirm !== name) return err(400, '確認文字不符')
      // backend rule: every managed account revoked (desired locked) and locked or gone on the host
      const busy = d.hostAccounts(name).filter((a) => a.managed && !(a.desired === 'locked' && (!a.exists || a.locked)))
      if (busy.length) return err(409, `此主機仍有未停用的受管帳號：${busy.map((a) => a.username).join('、')}；請先在人員頁取消開通並同步，等主機上已鎖定後再刪除`)
      d.hosts.splice(d.hosts.indexOf(h), 1)
      return ok({})
    }
  }
  m = p.match(/^\/api\/admin\/hosts\/([^/]+)\/accounts\/([^/]+)\/primary$/)
  if (m && method === 'PUT') {
    const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`
    if (body?.primary) d.primaryUsers.add(key)
    else d.primaryUsers.delete(key)
    return ok({ primary: !!body?.primary })
  }
  if (p === '/api/admin/primary-users' && method === 'PUT') {
    const items = (body?.items ?? []) as { host: string; username: string }[]
    d.primaryUsers.clear()
    for (const it of items) d.primaryUsers.add(`${it.host}/${it.username}`)
    return ok({ items })
  }
  if (p === '/api/admin/accounts') {
    const tab = url.searchParams.get('tab') ?? 'all'
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const days = Number(url.searchParams.get('days') ?? 365)
    let rows = d.adminAccountRows()
    if (q) rows = rows.filter((x) => x.username.includes(q) || x.host.includes(q))
    if (tab === 'drift') rows = rows.filter((x) => x.drift.length)
    if (tab === 'unmanaged') rows = rows.filter((x) => !x.managed)
    if (tab === 'idle') rows = rows.filter((x) => !x.last_active || Date.now() - new Date(x.last_active).getTime() > days * 86400000)
    const conflicts =
      tab === 'uid'
        ? [
            { kind: 'same_name', key: 'bob', entries: [{ host: 'gpu01', username: 'bob', uid: 20002 }, { host: 'gpu02', username: 'bob', uid: 1005 }] },
            { kind: 'same_uid', key: '1002', entries: [{ host: 'gpu02', username: 'guest', uid: 1002 }, { host: 'gpu03', username: 'labuser', uid: 1002 }] },
          ]
        : []
    if (tab === 'uid') rows = rows.filter((x) => x.username === 'bob' || x.uid === 1002)
    return ok({ tab, rows, conflicts })
  }
  if (p === '/api/admin/accounts/adopt' && method === 'POST') return ok({ person_id: (body?.person_id as number | undefined) ?? 4 })
  if (p === '/api/admin/accounts/suggestions') return ok({ groups: d.adoptGroups, conflicts: d.adoptConflicts })
  if (p === '/api/admin/accounts/adopt-bulk' && method === 'POST') {
    const items = (body?.items ?? []) as { username: string; hosts: string[]; person_id?: number }[]
    const adopted: { username: string; person_id: number; hosts: string[] }[] = []
    const errors: { username: string; error: string }[] = []
    for (const it of items) {
      const g = d.adoptGroups.find((x) => x.username === it.username)
      if (!g) errors.push({ username: it.username, error: '已不符合批次認領條件（UID 不一致、已受管理或為保留帳號），請到「UID 衝突」分頁逐台處理' })
      else if ((it.person_id ?? null) !== (g.existing_person?.id ?? null)) errors.push({ username: it.username, error: '已有同名人員，請重新整理後再確認' })
      else {
        d.adoptGroups.splice(d.adoptGroups.indexOf(g), 1)
        adopted.push({ username: g.username, person_id: g.existing_person?.id ?? 100 + adopted.length, hosts: it.hosts })
      }
    }
    return ok({ adopted, errors })
  }
  if (p === '/api/admin/people') return ok(d.people)
  m = p.match(/^\/api\/admin\/people\/(\d+)(?:\/(grants|sync|promote))?$/)
  if (m) {
    const person = d.people.find((x) => x.id === Number(m![1]))
    if (!person) return err(404, '找不到人員')
    if (m[2] === 'sync') return ok({ job_id: newJob('users', d.myAccounts(person.username).map((a) => a.host)) })
    if (m[2] === 'grants') return ok({ errors: (body?.hosts as string[]).includes('gpu04') ? [{ host: 'gpu04', error: '主機離線，稍後同步時再套用' }] : [] })
    if (m[2] === 'promote') {
      // api.md: active members only; idempotent; no way back on the web
      if (person.status !== 'active' || (person.expires_at && person.expires_at < new Date().toISOString().slice(0, 10))) {
        return err(400, `${person.username} 已鎖定或到期，不能設為管理員`)
      }
      ;(person as Person).role = 'admin'
      return ok(person)
    }
    if (method === 'PUT') {
      if (body && 'role' in body && body.role !== person.role) return err(403, '角色不能在這裡修改')
      Object.assign(person, body)
      return ok(person)
    }
    const accounts = d.myAccounts(person.username)
    return ok({
      person,
      accounts,
      keys: person.id === 1 ? d.keys : [],
      hosts: d.hosts.map((h) => ({ name: h.name, group: h.group, granted: accounts.some((a) => a.host === h.name && a.desired === 'present'), exists: d.hostAccounts(h.name).some((a) => a.username === person.username) })),
    })
  }
  if (p === '/api/admin/sync' && method === 'POST') return ok({ job_id: newJob('users', d.hosts.map((h) => h.name)) })
  if (p === '/api/admin/requests') return ok([...d.requests].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending')))
  m = p.match(/^\/api\/admin\/requests\/(\d+)\/(assign|reject)$/)
  if (m && method === 'POST') {
    const req = d.requests.find((x) => x.id === Number(m![1]))
    if (!req) return err(404, '找不到申請')
    if (req.status !== 'pending') return err(409, '申請已處理')
    req.decided_by = me().username
    req.decided_at = new Date().toISOString()
    if (m[2] === 'reject') {
      req.status = 'rejected'
      return ok(req)
    }
    const hosts = (body?.hosts as string[]) ?? []
    if (req.kind === 'account' && typeof body?.username === 'string' && d.people.some((x) => x.username === body.username)) {
      return err(409, `帳號名稱 ${body.username} 已被使用（人員或主機上的帳號）；若是同一人請改用「連結既有帳號」`)
    }
    req.status = 'approved'
    req.hosts = hosts
    req.person_id = (body?.person_id as number | undefined) ?? req.person_id ?? 4
    // api.md: one scoped, auto-confirmed job per host
    req.jobs = hosts.map((h) => ({ host: h, job_id: newJob('users', [h]), status: 'queued' as const }))
    return ok({ person_id: req.person_id, jobs: req.jobs.map(({ host, job_id }) => ({ host, job_id })) })
  }
  if (p === '/api/admin/assign-hosts') {
    const pid = Number(url.searchParams.get('person_id') ?? 0)
    const person = d.people.find((x) => x.id === pid)
    const board = new Map(d.gpuBoard().hosts.map((h) => [h.host, h]))
    const fs = new Map(d.filesystems().hosts.map((h) => [h.host, h.filesystems]))
    const down = metricsDown()
    return ok({
      metrics_ok: !down,
      hosts: d.hosts.map((h) => {
        const live = !down && h.monitored ? board.get(h.name) : undefined
        const disks = !down && h.monitored ? fs.get(h.name) : undefined
        const accounts = d.hostAccounts(h.name)
        const utils = live?.gpus.map((g) => g.util_pct).filter((v): v is number => v !== null) ?? []
        return {
          name: h.name, group: h.group, monitored: h.monitored, up: live ? live.up : null, gpu_summary: h.gpu_summary, gpu_count: h.gpu_count,
          gpu_vram_gb: live?.gpus[0]?.mem_total_bytes ? Math.round(live.gpus[0].mem_total_bytes / 2 ** 30) : null,
          gpus_free: live ? live.gpus.filter((g) => g.idle).length : null,
          gpu_util_avg: utils.length ? Math.round((10 * utils.reduce((a, v) => a + v, 0)) / utils.length) / 10 : null,
          users: accounts.filter((a) => a.exists && !a.locked).length,
          primary_users: accounts.filter((a) => a.primary).map((a) => ({ username: a.username, name: a.person?.name ?? null })),
          root_free_bytes: disks?.find((x) => x.mountpoint === '/')?.avail_bytes ?? null,
          data_free_bytes: disks ? disks.filter((x) => x.mountpoint.startsWith('/data')).reduce((a, x) => a + x.avail_bytes, 0) || null : null,
          granted: person ? d.myAccounts(person.username).some((a) => a.host === h.name && a.desired === 'present') : false,
        }
      }),
    })
  }
  m = p.match(/^\/api\/admin\/people\/(\d+)\/assign$/)
  if (m && method === 'POST') {
    const hosts = (body?.hosts as string[]) ?? []
    if (!hosts.length) return err(400, '請選擇主機')
    return ok({ jobs: hosts.map((h) => ({ host: h, job_id: newJob('users', [h]) })) })
  }
  m = p.match(/^\/api\/admin\/hosts\/([^/]+)\/accounts\/([^/]+)\/delete$/)
  if (m && method === 'POST') {
    if (body?.remove_home && String(body?.confirm ?? '').trim() !== decodeURIComponent(m[2])) return err(400, `確認文字不符：刪除家目錄請輸入 ${decodeURIComponent(m[2])}`)
    return ok({ job_id: newJob('users', [decodeURIComponent(m[1])], { status: 'awaiting', auto_confirm: false }) })
  }
  if (p === '/api/admin/jobs') return ok(d.jobs.map((j) => ({ id: j.id, kind: j.kind, target_hosts: j.target_hosts, status: j.status, actor: j.actor, created_at: j.created_at, run_at: j.run_at, finished_at: j.finished_at, auto_confirm: j.auto_confirm })))
  m = p.match(/^\/api\/admin\/jobs\/(\d+)(?:\/(confirm|cancel))?$/)
  if (m) {
    const j = d.jobs.find((x) => x.id === Number(m![1]))
    if (!j) return err(404, '找不到工作')
    if (m[2] === 'confirm') {
      if (j.status !== 'awaiting') return err(409, '只有待確認的工作可以確認')
      j.status = 'confirmed'
    }
    if (m[2] === 'cancel') {
      if (!['queued', 'awaiting', 'confirmed'].includes(j.status)) return err(409, '工作已開始或已結束，無法取消')
      j.status = 'cancelled'
      j.finished_at = new Date().toISOString()
    }
    return ok(j)
  }
  if (p === '/api/admin/health') return ok(d.healthBoard(metricsDown()))
  if (p === '/api/admin/announcements') {
    if (method === 'POST') {
      const b = body as { title: string; body: string; starts_at: string | null; ends_at: string | null; hosts?: string[] }
      const a = { id: d.announcements.length + 10, title: b.title, body: b.body, starts_at: b.starts_at ?? new Date().toISOString(), ends_at: b.ends_at, created_by: me().username, hosts: d.hosts.map((h) => h.name).filter((n) => b.hosts?.includes(n)) }
      d.announcements.unshift(a)
      return ok(a)
    }
    return ok(d.announcements)
  }
  if (p === '/api/admin/guide/members' && method === 'PUT') {
    d.guide.members = String(body?.source ?? '').replace(/\r\n/g, '\n').trim()
    return ok({ source: d.guide.source, default: d.defaultGuide, placeholders: GUIDE_VALUES, members_source: d.guide.members, updated_at: d.guide.updated_at, updated_by: d.guide.updated_by, is_default: d.guide.updated_at === null })
  }
  if (p === '/api/admin/guide') {
    if (method === 'PUT') {
      const src = String(body?.source ?? '').replace(/\r\n/g, '\n').trim()
      if (!src) return err(400, '請填寫指南內容')
      const isDefault = src === d.defaultGuide.trim()
      Object.assign(d.guide, { source: isDefault ? d.defaultGuide : src, updated_at: isDefault ? null : new Date().toISOString(), updated_by: isDefault ? null : me().username })
    }
    return ok({ source: d.guide.source, default: d.defaultGuide, placeholders: GUIDE_VALUES, members_source: d.guide.members, updated_at: d.guide.updated_at, updated_by: d.guide.updated_by, is_default: d.guide.updated_at === null })
  }
  if (p === '/api/admin/audit') return ok(d.auditPage(Math.max(1, Number(url.searchParams.get('page')) || 1)))

  return err(404, `mock: 未實作 ${method} ${p}`)
}

export function installMocks() {
  readSwitches()
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return real(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250))
    const res = route(method, url, body)
    return new Response(res.text ?? JSON.stringify(res.body ?? {}), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  console.info('[mock] fixture API enabled — role=%s, metrics=%s', role(), metricsDown() ? 'down' : 'up')
}
