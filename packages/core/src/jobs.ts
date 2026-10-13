// Jobs in human terms: a one-line description from a job's kind and args (job list, job page, Discord), and a
// plain-language summary of common Ansible failures (job page, Discord). Display only: nothing here is trusted.

const LEGACY: Record<string, string> = { power: '電源控制（已停用）', shutdown: '排程關機（已停用）', bmc_check: '檢查 IPMI（已停用）' }

const some = (xs: string[], unit: string, max = 3) => (xs.length > max ? `${xs.slice(0, max).join('、')} 等 ${xs.length} ${unit}` : xs.join('、'))

type Entry = { username?: unknown; state?: unknown; remove_home?: unknown }

/** e.g. 「指派 xiaoming @gpu01」「刪除 oldgrad @gpu01」「金鑰部署 alice @gpu01、gpu02」「收集資料（全部主機）」. */
export function describeJob(kind: string, args: Record<string, unknown> | null | undefined, autoConfirm = false): string {
  const th = String(args?.target_hosts ?? '')
  const hosts = th === 'all' ? [] : th.split(',').filter(Boolean)
  const at = hosts.length ? ` @${some(hosts, '台')}` : '（全部主機）'
  if (kind === 'collect') return `收集資料${at}`
  if (kind === 'agents') return `安裝監控${at}`
  if (kind !== 'users') return LEGACY[kind] ?? kind
  if (typeof args?.only_user === 'string') return `指派 ${args.only_user}${at}`
  const accounts = args?.accounts && typeof args.accounts === 'object' ? (args.accounts as Record<string, Entry[]>) : {}
  const entries = Object.values(accounts).flatMap((v) => (Array.isArray(v) ? v : []))
  const who = some([...new Set(entries.map((e) => String(e.username)))], '人')
  if (entries.length && entries.every((e) => e.state === 'absent')) {
    return `刪除 ${who}${entries.some((e) => e.remove_home) ? '（含家目錄）' : ''}${at}`
  }
  return `${autoConfirm ? '金鑰部署' : '帳號同步'} ${who}${at}`
}

export type FailureKind = 'network' | 'stale' | 'hostkey' | 'publickey' | 'unreachable' | 'sudo' | 'permission' | 'other'
export type Failure = { kind: FailureKind; hosts: string[]; text: string }

const RULES: [FailureKind, RegExp, string][] = [
  ['network', /\[runner\] 所有主機的監控都無回應/, '監控主機連不到任何主機（VPN／網路可能中斷），工作沒有執行'],
  ['stale', /\[runner\] 狀態已變更/, '預覽之後帳號狀態又變了，工作沒有套用；請重新同步'],
  ['hostkey', /Host key verification failed|host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    '主機尚未 bootstrap 或無法連線（監控主機不認得它的 SSH host key）'],
  ['publickey', /UNREACHABLE![^\n]*Permission denied \(publickey/, '主機尚未 bootstrap 或無法連線（bot 帳號的 SSH 金鑰被拒）'],
  ['unreachable', /UNREACHABLE!/, '主機尚未 bootstrap 或無法連線'],
  ['sudo', /Missing sudo password|Incorrect sudo password|sudo: a password is required|waiting for privilege escalation prompt/i,
    'sudo 失敗：bot 帳號的 sudo 密碼不符（請重跑 bootstrap）'],
  ['permission', /Permission denied/, '權限不足（Permission denied）'],
]

/** The first common cause found in a job's output, and the hosts it names (fatal: [host]: …). Null when none matches. */
export function failureHint(output: string | null | undefined): Failure | null {
  const text = output ?? ''
  for (const [kind, re, message] of RULES) {
    if (!re.test(text)) continue
    const hosts = new Set<string>()
    for (const m of text.matchAll(/^fatal: \[([^\]]+)\]: (UNREACHABLE!|FAILED!)(.*)$/gm)) {
      if (kind === 'network' || kind === 'stale' || re.test(m[0])) hosts.add(m[1])
    }
    return { kind, hosts: [...hosts], text: message }
  }
  return null
}

/** A one-line summary for a failed job (or a failed preview), e.g. 「預檢無法連線到 gpu01，未產生預覽，請修正後重新排程」. */
export function failureSummary(output: string | null | undefined, preview = false): string {
  const f = failureHint(output)
  const where = f?.hosts.length ? f.hosts.join('、') : null
  if (preview) {
    const reach = f && ['hostkey', 'publickey', 'unreachable'].includes(f.kind)
    return reach
      ? `預檢無法連線到 ${where ?? '主機'}，未產生預覽，請修正後重新排程（${f.text}）`
      : `預檢失敗${f ? `：${f.text}` : ''}，未產生預覽，請修正後重新排程`
  }
  if (!f) return '工作失敗，請看下方輸出'
  return where ? `${where}：${f.text}` : f.text
}
