import { isIPv4, isIPv6 } from 'node:net'

// IP address parsing as Python's ipaddress module does it (strict dotted quads, no zone ids).

function v4(s: string): bigint | null {
  if (!isIPv4(s)) return null
  const parts = s.split('.')
  if (parts.some((p) => p.length > 1 && p.startsWith('0'))) return null
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n)
}

function v6(s: string): bigint | null {
  if (!isIPv6(s) || s.includes('%')) return null
  let text = s
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const n = v4(dotted[1])
    if (n === null) return null
    text = `${text.slice(0, -dotted[1].length)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, null]
  const a = head ? head.split(':') : []
  const b = rest ? rest.split(':') : []
  const fill = rest === null ? 0 : 8 - a.length - b.length
  if (fill < 0) return null
  const groups = [...a, ...Array<string>(fill).fill('0'), ...b]
  if (groups.length !== 8 || groups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n)
}

export function isIpAddress(s: string): boolean {
  return v4(s) !== null || v6(s) !== null
}

function fmt6(n: bigint): string {
  const g = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn))
  let best = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && g[j] === 0) j++
    if (j - i > bestLen && j - i > 1) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = g.map((x) => x.toString(16))
  if (best < 0) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`
}

/** str(ipaddress.ip_network(s, strict=False)): host bits cleared, prefix always shown. Throws on garbage. */
export function normalizeNetwork(s: string): string {
  const [addr, prefixText, extra] = s.split('/')
  if (extra !== undefined) throw new Error(`invalid network ${s}`)
  const n4 = v4(addr)
  const n6 = n4 === null ? v6(addr) : null
  if (n4 === null && n6 === null) throw new Error(`invalid network ${s}`)
  const bits = n4 !== null ? 32 : 128
  let prefix = bits
  if (prefixText !== undefined) {
    if (!/^\d+$/.test(prefixText) || Number(prefixText) > bits) throw new Error(`invalid prefix ${s}`)
    prefix = Number(prefixText)
  }
  const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n)
  const net = (n4 ?? n6)! & mask
  if (n4 !== null) {
    return `${[24n, 16n, 8n, 0n].map((sh) => String((net >> sh) & 255n)).join('.')}/${prefix}`
  }
  return `${fmt6(net)}/${prefix}`
}
