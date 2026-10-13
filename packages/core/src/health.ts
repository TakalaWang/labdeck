import type { Row } from './db.ts'
import { type Labels, PromError, prom, promql } from './prom.ts'
import { isoOf, localIso } from './time.ts'
import { pyFixed } from './util.ts'

// /api/admin/health (api.md 主機健康).

export const HEALTH_LABELS: Record<string, string> = {
  reachable: '連線', collect_age: '資料收集', apt: 'apt 套件來源', reboot_required: '待重開機',
  disk_root: '根目錄空間', disk_any: '最滿的磁碟', smart: '硬碟 SMART', gpu_missing: 'GPU 數量',
  driver_drift: 'NVIDIA driver', os_eol: 'OS 支援期',
}
/** Ubuntu LTS end of standard support (the first month without updates). */
const UBUNTU_EOL: Record<string, string> = { '16.04': '2021-05', '18.04': '2023-06', '20.04': '2025-06', '22.04': '2027-06', '24.04': '2029-06' }
const SEVERITY: Record<string, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 }

type Check = [string, string]
type Fs = [number | null, number | null, number | null]
export type Live = {
  up: boolean | null
  fs: Map<string | undefined, Fs>
  smart: Map<string | undefined, boolean>
  pci?: number
  smi?: number
  smi_ok?: boolean
}

const gb = (v: number | null) => (v !== null ? `${pyFixed(v / 1e9, 1)} GB` : '?')

function daysText(secs: number): string {
  const d = secs / 86400
  return d >= 1 ? `${pyFixed(d, 0)} 天` : `${pyFixed(secs / 3600, 0)} 小時`
}

function driverMajor(v: unknown): string | null {
  const m = /^(\d+)\./.exec(typeof v === 'string' ? v : '')
  return m ? m[1] : null
}

/**
 * [status, detail] of one filesystem: full, or ≥ 80 % used and filling within days (predict_linear over 6 h);
 * the forecast is shown only then, and only when it is under 30 days.
 */
export function diskCheck(mount: string | undefined, pct: number | null, avail: number | null, days: number | null): Check {
  if (pct === null) return ['unknown', `${mount}：沒有資料`]
  const soon = pct >= 80 && days !== null && days < 30 ? days : null
  const status = pct >= 95 || (soon !== null && soon < 3) ? 'bad' : pct >= 85 || (soon !== null && soon < 7) ? 'warn' : 'ok'
  return [status, `${mount} 已用 ${pyFixed(pct, 0)}%，剩 ${gb(avail)}${soon !== null ? `，照目前速度約 ${pyFixed(soon, 1)} 天後寫滿` : ''}`]
}

const fmtCount = (v: number) => pyFixed(v, 0)

/** [{key, status, label, detail}] of one hosts row; `live` is this host's Prometheus data or null (outage). */
export function hostHealth(r: Row, facts: Record<string, any>, nowTs: number, live: Live | null | undefined, fleetMajor: string | null) {
  const checks: Record<string, Check> = {}
  const monitored = Boolean(r.monitored)
  const noLive = !monitored ? '未監控' : live === null || live === undefined ? '監控資料暫時無法取得' : null

  const up = live ? live.up : live
  checks.reachable = noLive
    ? ['unknown', noLive]
    : up === null || up === undefined
      ? ['unknown', '尚未抓取到資料']
      : up
        ? ['ok', 'node_exporter 正常回應']
        : ['bad', 'node_exporter 抓不到（關機、斷網或服務停止）']

  const at = r.facts_at as number | null
  const age = at ? nowTs - at : null
  checks.collect_age =
    age === null
      ? ['bad', '從未收集資料']
      : [age > 7 * 86400 ? 'bad' : age > 2 * 86400 ? 'warn' : 'ok', `${daysText(Math.max(0, age))}前收集`]

  if (!('apt_check_ok' in facts)) checks.apt = ['unknown', '尚無資料（收集腳本更新後的下一次收集才有）']
  else if (facts.apt_check_ok === false) {
    checks.apt = ['bad', 'apt-get check 失敗：套件相依損壞或 dpkg 中斷，需執行 dpkg --configure -a']
  } else if (!facts.apt_update_at) checks.apt = ['unknown', '沒有 apt update 成功的紀錄']
  else {
    const stale = (at ?? 0) - facts.apt_update_at
    checks.apt = [
      stale > 14 * 86400 ? 'bad' : stale > 3 * 86400 ? 'warn' : 'ok',
      `最後一次成功 apt update：${daysText(Math.max(0, stale))}前${stale > 3 * 86400 ? '（apt 來源可能壞掉：金鑰過期、套件庫不存在或網路不通）' : ''}`,
    ]
  }

  if (!('reboot_required' in facts)) checks.reboot_required = ['unknown', '尚無資料（收集腳本更新後的下一次收集才有）']
  else {
    const pkgs: string[] = facts.reboot_pkgs || []
    const uptime = facts.uptime_s
    const upText = uptime ? `已開機 ${daysText(uptime)}` : ''
    checks.reboot_required = facts.reboot_required
      ? ['warn', `需要重新開機${pkgs.length ? `（${pkgs.slice(0, 5).join('、')}${pkgs.length > 5 ? ' 等' : ''}）` : ''}${upText ? `；${upText}` : ''}`]
      : ['ok', upText || '不需重開機']
  }

  const fs = live?.fs ?? new Map<string | undefined, Fs>()
  if (noLive || !fs.size) {
    checks.disk_root = checks.disk_any = ['unknown', noLive || '沒有檔案系統資料']
  } else {
    const disks = new Map([...fs].map(([m, v]) => [m, diskCheck(m, ...v)]))
    checks.disk_root = disks.get('/') ?? ['unknown', '沒有 / 的資料']
    let worst: string | undefined
    let best: [number, number] | null = null
    for (const [m, v] of fs) {
      const k: [number, number] = [SEVERITY[disks.get(m)![0]], v[0] ?? 0]
      if (best === null || k[0] > best[0] || (k[0] === best[0] && k[1] > best[1])) {
        best = k
        worst = m
      }
    }
    checks.disk_any = disks.get(worst)!
  }

  const smart = live?.smart ?? new Map<string | undefined, boolean>()
  checks.smart = noLive
    ? ['unknown', noLive]
    : !smart.size
      ? ['unknown', '沒有 SMART 資料']
      : [...smart.values()].some((ok) => !ok)
        ? ['bad', `未通過：${[...smart].filter(([, ok]) => !ok).map(([d]) => String(d)).sort().join('、')}`]
        : ['ok', `${smart.size} 顆硬碟正常`]

  const l = live ?? ({} as Partial<Live>)
  const pci: number | null = 'pci' in l && l.pci !== undefined ? l.pci : (facts.gpu_pci_count ?? null)
  const smi: number | null = 'smi' in l && l.smi !== undefined ? l.smi : 'gpus' in facts ? (facts.gpus?.length ?? 0) : null
  if (pci === null && smi === null) checks.gpu_missing = ['unknown', '沒有 GPU 資料']
  else if (l.smi_ok === false && pci) checks.gpu_missing = ['bad', `nvidia-smi 執行失敗（lspci 看到 ${fmtCount(pci)} 張）`]
  else if (smi !== null && pci !== null && smi < pci) checks.gpu_missing = ['bad', `lspci 看到 ${fmtCount(pci)} 張，nvidia-smi 只看到 ${fmtCount(smi)} 張`]
  else checks.gpu_missing = ['ok', pci || smi ? `${fmtCount(Math.max(pci ?? 0, smi ?? 0))} 張` : '這台沒有 GPU（純 CPU 主機）']

  const drv = facts.nvidia_driver
  const major = driverMajor(drv)
  if (!major) checks.driver_drift = pci ? ['unknown', '讀不到 NVIDIA driver 版本'] : ['ok', '不適用：這台沒有 GPU']
  else if (fleetMajor && major !== fleetMajor) checks.driver_drift = ['warn', `${drv}（多數主機為 ${fleetMajor} 版）`]
  else checks.driver_drift = ['ok', drv]

  const osName = facts.os
  const m = /^Ubuntu (\d+\.\d+)/.exec(typeof osName === 'string' ? osName : '')
  const eol = m ? UBUNTU_EOL[m[1]] : undefined
  const today = localIso(new Date(nowTs * 1000)).slice(0, 7)
  checks.os_eol = !eol
    ? ['unknown', osName || '沒有 OS 資料']
    : eol <= today
      ? ['warn', `${osName}：標準支援已於 ${eol} 前結束，不再有安全更新`]
      : ['ok', `${osName}（支援到 ${eol}）`]

  return Object.entries(HEALTH_LABELS).map(([key, label]) => ({ key, status: checks[key][0], label, detail: checks[key][1] }))
}

/** {instance: {up, fs: {mount: [pct, avail, days]}, smart: {device: ok}, pci, smi, smi_ok}} from Prometheus. */
export async function healthLive(names: string[]): Promise<Map<string, Live>> {
  const live = new Map<string, Live & { fsRaw: Map<string | undefined, Fs> }>(
    names.map((n) => [n, { up: null, fs: new Map(), smart: new Map(), fsRaw: new Map() }]),
  )
  const [upRes, pctRes, availRes, daysRes, rawRes] = await Promise.all(
    ['status.up', 'health.fs_pct', 'health.fs_avail', 'health.fs_days', 'health.raw'].map((k) => prom(promql(k)) as Promise<[Labels, number | null][]>),
  )
  const each = (res: [Labels, number | null][], fn: (h: Live & { fsRaw: Map<string | undefined, Fs> }, l: Record<string, string | undefined>, v: number | null) => void) => {
    for (const [labels, v] of res) {
      const h = labels.instance !== undefined ? live.get(labels.instance) : undefined
      if (h) fn(h, labels, v)
    }
  }
  each(upRes, (h, _l, v) => {
    h.up = v === null ? null : v === 1
  })
  ;[pctRes, availRes, daysRes].forEach((res, i) =>
    each(res, (h, l, v) => {
      if (!h.fsRaw.has(l.mountpoint)) h.fsRaw.set(l.mountpoint, [null, null, null])
      h.fsRaw.get(l.mountpoint)![i] = v
    }),
  )
  const raw: Record<string, 'pci' | 'smi' | 'smi_ok'> = { lab_gpu_pci_count: 'pci', lab_gpu_smi_count: 'smi', lab_nvidia_smi_ok: 'smi_ok' }
  each(rawRes, (h, l, v) => {
    if (l.__name__ === 'lab_smart_healthy') h.smart.set(l.device, v === 1)
    else if (v !== null && l.__name__ && l.__name__ in raw) {
      if (l.__name__ === 'lab_nvidia_smi_ok') h.smi_ok = v === 1
      else h[raw[l.__name__] as 'pci' | 'smi'] = v
    }
  })
  const out = new Map<string, Live>()
  for (const [name, { fsRaw, ...h }] of live) {
    // a mount seen only in the forecast query has no usage: drop it
    out.set(name, { ...h, fs: new Map([...fsRaw].filter(([, v]) => v[0] !== null)) })
  }
  return out
}

/** /api/admin/health body for hosts rows; a Prometheus outage only turns the live checks unknown. */
export async function health(rows: Row[]) {
  const facts = new Map(rows.map((r) => [r.name as string, JSON.parse(r.facts_json || '{}') as Record<string, any>]))
  const majors = [...facts.values()].map((f) => driverMajor(f.nvidia_driver)).filter((m): m is string => m !== null)
  const counts = new Map<string, number>()
  for (const m of majors) counts.set(m, (counts.get(m) ?? 0) + 1)
  let fleet: string | null = null
  for (const [m, c] of counts) {
    if (fleet === null || c > counts.get(fleet)! || (c === counts.get(fleet)! && Number(m) > Number(fleet))) fleet = m
  }
  let live: Map<string, Live> | null
  try {
    live = await healthLive(rows.filter((r) => r.monitored).map((r) => r.name))
  } catch (e) {
    if (!(e instanceof PromError)) throw e
    live = null
  }
  const nowTs = Date.now() / 1000
  return {
    updated_at: isoOf(new Date(nowTs * 1000)),
    metrics_ok: live !== null,
    fleet_driver: fleet,
    hosts: rows.map((r) => ({
      host: r.name,
      group: r.group_name,
      checks: hostHealth(r, facts.get(r.name)!, nowTs, live && live.get(r.name), fleet),
    })),
  }
}
