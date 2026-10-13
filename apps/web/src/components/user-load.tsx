import { CircleDashed, ServerOff } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

import { Meter, Pill, StatusDot } from "@/components/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtBytes, fmtCores, fmtNum, fmtPct } from "@/lib/format";
import { HEAVY_SHARE, isHeavy, userShares } from "@/lib/load";
import type { HostLoad, UserLoad } from "@/lib/types";
import { cn } from "@/lib/utils";

const SYSTEM_HINT: Record<string, string> = {
  system: "UID < 1000 的系統帳號（服務程序）合計",
  root: "root 的程序",
};

/** Why a host has no per-user rows (no data yet, offline, or labdeck-agent not installed); null when it has rows. */
export function LoadNotice({ h }: { h: HostLoad }) {
  if (h.users.length > 0) return null;
  const cls = "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm";
  if (h.up === false)
    return (
      <p
        className={cn(
          cls,
          "border-destructive/30 bg-crit-soft text-destructive",
        )}
      >
        <ServerOff className="size-4 shrink-0" aria-hidden="true" />{" "}
        主機離線，無法取得使用者用量。
      </p>
    );
  return (
    <p className={cn(cls, "bg-muted/50 text-muted-foreground")}>
      <CircleDashed className="size-4 shrink-0" aria-hidden="true" />
      {h.up === null
        ? "尚無資料：監控尚未回報這台主機的狀態。"
        : "這台主機還沒有回報使用者用量；管理員「安裝/更新監控」後就會出現。"}
    </p>
  );
}

/** Amount with a small share-of-host bar (the bar is hidden on phones). */
function Amount({
  text,
  share,
  label,
}: {
  text: string;
  share: number | null;
  label: string;
}) {
  const heavy = (share ?? 0) > HEAVY_SHARE;
  return (
    <div className="flex items-center justify-end gap-2">
      {share != null && (
        <Meter
          label={label}
          value={share * 100}
          showValue={false}
          tone={heavy ? "warn" : "info"}
          valueText={fmtPct(share * 100)}
          className="hidden w-14 @2xl:flex"
        />
      )}
      <span
        className={cn(
          "num text-right whitespace-nowrap @md:min-w-16",
          heavy && "font-semibold text-warn-ink",
        )}
      >
        {text}
      </span>
    </div>
  );
}

/** Per-user CPU, RAM, process and GPU table of one host; users above half of the host's CPU or RAM are highlighted. */
export function UserLoadTable({
  host,
  users,
}: {
  host: HostLoad;
  users: UserLoad[];
}) {
  const gpus = host.users.some((u) => u.gpu_count > 0); // CPU-only hosts get no GPU column
  // Sized by its container (a half-width card, the host page, a phone): bars, the badge text, process
  // counts and GPU memory only show when there is room.
  return (
    <div className="@container">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>使用者</TableHead>
            <TableHead className="text-right">CPU</TableHead>
            <TableHead className="text-right">記憶體</TableHead>
            <TableHead className="hidden text-right @md:table-cell">
              程序
            </TableHead>
            {gpus && <TableHead className="text-right">GPU</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const s = userShares(host, u);
            const heavy = isHeavy(host, u);
            const hint = SYSTEM_HINT[u.user];
            return (
              <TableRow
                key={u.user}
                data-testid={`load-${host.host}-${u.user}`}
                data-heavy={heavy || undefined}
                className={cn(heavy && "bg-warn-soft hover:bg-warn-soft")}
              >
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "font-mono",
                        hint && "text-muted-foreground",
                      )}
                      title={hint}
                    >
                      {u.user}
                    </span>
                    {heavy && (
                      <Pill
                        tone="warn"
                        title="使用超過這台主機一半的 CPU 或記憶體"
                        className="px-1 @md:px-1.5"
                      >
                        <span className="@md:hidden">過半</span>
                        <span className="hidden @md:inline">佔用過半</span>
                      </Pill>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <Amount
                    text={fmtCores(u.cpu_cores)}
                    share={s.cpu}
                    label={`${u.user} 佔 ${host.host} 的 CPU`}
                  />
                </TableCell>
                <TableCell>
                  <Amount
                    text={fmtBytes(u.mem_bytes, 1)}
                    share={s.mem}
                    label={`${u.user} 佔 ${host.host} 的記憶體`}
                  />
                </TableCell>
                <TableCell className="num hidden text-right @md:table-cell">
                  {fmtNum(u.processes)}
                </TableCell>
                {gpus && (
                  <TableCell className="num text-right whitespace-nowrap">
                    {u.gpu_count > 0 ? (
                      <>
                        {u.gpu_count} 張
                        <span className="hidden text-muted-foreground @md:inline">
                          {" "}
                          · {fmtBytes(u.gpu_mem_bytes, 0)}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Host-wide CPU and RAM in use (node_exporter's view, not the sum of the rows). */
export function HostLoadBars({ h }: { h: HostLoad }) {
  const cpu =
    h.cpu_used_cores != null && h.cpu_count
      ? (h.cpu_used_cores * 100) / h.cpu_count
      : null;
  const mem =
    h.mem_used_bytes != null && h.mem_total_bytes
      ? (h.mem_used_bytes * 100) / h.mem_total_bytes
      : null;
  return (
    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <div>
        <div className="mb-1 flex justify-between gap-2 text-xs">
          <span className="text-muted-foreground">CPU</span>
          <span className="num">
            {fmtNum(h.cpu_used_cores, 1)} / {fmtNum(h.cpu_count)} 核
          </span>
        </div>
        <Meter label={`${h.host} CPU 使用率`} value={cpu} />
      </div>
      <div>
        <div className="mb-1 flex justify-between gap-2 text-xs">
          <span className="text-muted-foreground">記憶體</span>
          <span className="num">
            {fmtBytes(h.mem_used_bytes, 0)} / {fmtBytes(h.mem_total_bytes, 0)}
          </span>
        </div>
        <Meter label={`${h.host} 記憶體使用率`} value={mem} />
      </div>
    </div>
  );
}

/** One host on the CPU / 記憶體 page: status, host-wide bars and its (filtered) users. */
export function HostLoadCard({
  h,
  users,
  footer,
}: {
  h: HostLoad;
  users: UserLoad[];
  footer?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`lh-${h.host}`}
      data-testid={`load-host-${h.host}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusDot state={h.up === null ? "unknown" : h.up ? "up" : "down"} />
        <h2 id={`lh-${h.host}`} className="text-sm font-semibold">
          <Link
            to={`/hosts/${encodeURIComponent(h.host)}`}
            className="hover:underline"
          >
            {h.host}
          </Link>
        </h2>
        <Pill tone="muted">{h.group}</Pill>
        {h.cpu_count != null && h.mem_total_bytes != null && (
          <span className="num text-xs text-muted-foreground">
            {h.cpu_count} 核 · {fmtBytes(h.mem_total_bytes, 0)}
          </span>
        )}
      </div>
      {h.up && <HostLoadBars h={h} />}
      <LoadNotice h={h} />
      {users.length > 0 && (
        <div className="-mx-3 border-t sm:-mx-4">
          <UserLoadTable host={h} users={users} />
        </div>
      )}
      {footer}
    </section>
  );
}
