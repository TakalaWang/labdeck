import type { HostLoad, UserLoad } from '@/lib/types'

/** A user above this share of a host's CPU cores or RAM is highlighted. */
export const HEAVY_SHARE = 0.5

/** Share (0–1) of the host's CPU cores and RAM a user takes; null when either side is unknown.
 *  RSS sums count shared memory once per process, so the RAM share can exceed 1. */
export function userShares(h: HostLoad, u: UserLoad): { cpu: number | null; mem: number | null } {
  return {
    cpu: u.cpu_cores != null && h.cpu_count ? u.cpu_cores / h.cpu_count : null,
    mem: u.mem_bytes != null && h.mem_total_bytes ? u.mem_bytes / h.mem_total_bytes : null,
  }
}

export function isHeavy(h: HostLoad, u: UserLoad): boolean {
  const s = userShares(h, u)
  return (s.cpu ?? 0) > HEAVY_SHARE || (s.mem ?? 0) > HEAVY_SHARE
}
