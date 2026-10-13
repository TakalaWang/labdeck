import { useQuery } from '@tanstack/react-query'
import { ArrowRight, BookOpen, CloudOff, Hourglass, KeyRound, LogIn, ShieldAlert, TriangleAlert, UserPlus } from 'lucide-react'
import { lazy, Suspense, type ReactNode } from 'react'
import { Link, useSearchParams } from '@/lib/router'

import { AnimatedNumber } from '@/components/animated-number'
import { AnnouncementList } from '@/components/announcement-list'
import { PageHeader, Section } from '@/components/page'
import { RegistrationStatus } from '@/components/registration-status'
import AnimatedProgressBar from '@/components/smoothui/animated-progress-bar'
import { ErrorState, SkeletonCards, SkeletonRows } from '@/components/states'
import { Pill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { usePendingRequests } from '@/hooks/use-pending-requests'
import { api, loginHref } from '@/lib/api'
import { daysUntil, fmtDate } from '@/lib/format'
import { ROLE_LABEL } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import type { Announcement, Me, MyUsage, Summary } from '@/lib/types'

// Recharts only loads with the charts, after the summary.
const FleetOverview = lazy(() => import('@/components/fleet-overview'))

function Stat({
  label,
  value,
  total,
  hint,
  tone,
  to,
}: {
  label: string
  value: number | null
  total: number
  hint: ReactNode
  tone: string
  to: string
}) {
  const pct = value === null || total === 0 ? 0 : (value / total) * 100
  return (
    <Link
      to={to}
      className="group flex flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </div>
      <div className="flex items-baseline gap-1.5">
        <AnimatedNumber value={value} className="text-3xl font-semibold tracking-tight" />
        <span className="num text-sm text-muted-foreground">/ {total}</span>
      </div>
      <AnimatedProgressBar value={pct} color={tone} label={label} valueText={`${value ?? '—'} / ${total}`} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </Link>
  )
}

/** How many announcements the home page shows before 「全部公告」. */
const LATEST = 3

/** 我的狀態: who I am here, until when, and what I'm running right now (the same query as /me). */
function MyStatus() {
  const a = useAccess()
  const usage = useQuery({ queryKey: ['me', 'usage'], queryFn: () => api.get<MyUsage>('/api/me/usage'), refetchInterval: 15_000 })
  const u = a.user
  const days = daysUntil(u?.expires_at)
  const gpuHosts = [...new Set(usage.data?.gpu_processes.map((p) => p.host))]
  const gpus = new Set(usage.data?.gpu_processes.map((p) => `${p.host}/${p.gpu}`)).size
  const cpuHosts = usage.data?.cpu_mem.map((c) => c.host) ?? []
  return (
    <section aria-labelledby="my-status-title" className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-testid="my-status">
      <div className="flex items-center justify-between gap-2">
        <h2 id="my-status-title" className="text-base font-semibold">
          我的狀態
        </h2>
        {u && <Pill tone={u.role === 'admin' ? 'info' : 'muted'}>{ROLE_LABEL[u.role]}</Pill>}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">帳號</dt>
        <dd className="font-mono">{u?.username}</dd>
        <dt className="text-muted-foreground">到期日</dt>
        <dd className={days !== null && days <= 30 ? 'text-warn-ink' : undefined}>
          {u?.expires_at ? `${fmtDate(u.expires_at)}${days !== null && days >= 0 ? `（剩 ${days} 天）` : '（已過期）'}` : '不到期'}
        </dd>
        <dt className="text-muted-foreground">正在使用</dt>
        <dd>
          {usage.isError
            ? '監控資料暫時無法取得'
            : !usage.data
              ? '…'
              : gpus || cpuHosts.length
                ? [gpus && `${gpus} 張 GPU（${gpuHosts.join('、')}）`, cpuHosts.length && `${cpuHosts.length} 台主機有程序`].filter(Boolean).join('；')
                : '目前沒有執行中的程序'}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-sm">
        <Link to="/me" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <KeyRound className="size-3.5" aria-hidden="true" /> 我的帳號
        </Link>
        <Link to="/guide" className="inline-flex items-center gap-1 text-primary hover:underline">
          <BookOpen className="size-3.5" aria-hidden="true" /> 新成員指南
        </Link>
      </div>
    </section>
  )
}

/**
 * Account setup on the home page: the temp password waiting on 我的帳號 (until 「我已記下」), accounts being created,
 * or their jobs failed. GET /api/me changes nothing, so asking here is safe.
 */
function AccountSetupBanner() {
  const q = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/me') })
  const me = q.data
  if (!me) return null
  if (me.temp_password) {
    return (
      <Link
        to="/me"
        data-testid="home-temp-password"
        className="mb-4 flex items-center gap-3 rounded-xl border-2 border-warn bg-warn-soft px-4 py-3 text-warn-ink transition-colors hover:bg-warn/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ShieldAlert className="size-5 shrink-0" aria-hidden="true" />
        <span className="font-semibold">帳號已開通：請到我的帳號查看臨時密碼</span>
        <ArrowRight className="ml-auto size-4 shrink-0" aria-hidden="true" />
      </Link>
    )
  }
  if (me.account_setup === 'pending') {
    return (
      <div role="status" className="mb-4 flex items-center gap-2 rounded-lg border bg-accent/40 px-4 py-3 text-sm">
        <Hourglass className="size-4 shrink-0 text-primary" aria-hidden="true" />
        帳號建立中，完成後會在「<Link to="/me" className="font-medium text-primary hover:underline">我的帳號</Link>」顯示臨時密碼。
      </div>
    )
  }
  if (me.account_setup === 'failed') {
    return (
      <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-crit-soft px-4 py-3 text-sm">
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        帳號開通失敗，助教已收到通知。詳情見「<Link to="/me" className="font-medium text-primary hover:underline">我的帳號</Link>」。
      </div>
    )
  }
  return null
}

/** Admins: how many registrations / host requests wait on 待指派. */
function PendingRequestsCard() {
  const n = usePendingRequests()
  if (n === null) return null
  return (
    <Link
      to="/admin/requests"
      data-testid="home-pending-requests"
      className={
        'group mb-4 flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        + (n > 0 ? ' border-warn/50' : '')
      }
    >
      <UserPlus className={n > 0 ? 'size-5 shrink-0 text-warn-ink' : 'size-5 shrink-0 text-muted-foreground'} aria-hidden="true" />
      <span className="font-semibold">待指派 <span className="num">{n}</span> 筆</span>
      <span className="text-sm text-muted-foreground">{n > 0 ? '新成員登記與主機申請等你處理' : '目前沒有待處理的登記或申請'}</span>
      <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  )
}

function MemberHome() {
  const a = useAccess()
  const q = useQuery({
    queryKey: ['summary'],
    queryFn: () => api.get<Summary>('/api/summary'),
    refetchInterval: 30_000,
  })
  const s = q.data
  const days = daysUntil(a.user?.expires_at)

  return (
    <>
      <PageHeader title="首頁" description={a.user ? `${a.user.name || a.user.username}，你好。` : undefined} />
      <AccountSetupBanner />
      <PendingRequestsCard />
      {days !== null && days <= 30 && (
        <div role="status" className="mb-4 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn-ink">
          你的實驗室帳號將於 <strong>{a.user?.expires_at}</strong> 到期
          {days >= 0 ? `（剩 ${days} 天）` : '（已過期）'}，如需延長請聯絡網管。
        </div>
      )}
      {q.isError && !s ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !s ? (
        <SkeletonCards count={2} className="lg:grid-cols-2" />
      ) : (
        <>
          {!s.metrics_ok && (
            <div role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-sm text-warn-ink">
              <CloudOff className="size-4 shrink-0" aria-hidden="true" /> 監控資料暫時無法取得，在線與閒置數量暫不顯示。
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat
              label="在線主機"
              value={s.hosts_up}
              total={s.hosts_total}
              tone="var(--ok)"
              to="/hosts"
              hint={s.hosts_up === null ? '無法取得' : s.hosts_total - s.hosts_up > 0 ? `${s.hosts_total - s.hosts_up} 台離線或未監控` : '全部在線'}
            />
            <Stat
              label="閒置 GPU"
              value={s.gpus_idle}
              total={s.gpus_total}
              tone="var(--primary)"
              to="/usage?tab=gpu"
              hint="使用率 < 5% 且記憶體用量 < 1 GiB"
            />
          </div>
        </>
      )}

      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Section
          title="最新公告"
          className="mt-0"
          actions={
            <Link to="/announcements" className="text-sm text-primary hover:underline">
              全部公告與維護日曆
            </Link>
          }
        >
          {s ? <AnnouncementList items={s.announcements.slice(0, LATEST)} /> : <SkeletonRows rows={2} />}
        </Section>
        <MyStatus />
      </div>
      {s?.metrics_ok && (
        <Suspense fallback={<SkeletonCards count={3} className="mt-8 lg:grid-cols-3" />}>
          <FleetOverview />
        </Suspense>
      )}
    </>
  )
}

function PublicAnnouncements() {
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.get<Announcement[]>('/api/announcements') })
  return (
    <Section title="公告" className="mt-8">
      {q.data ? <AnnouncementList items={q.data} /> : q.isError ? <ErrorState error={q.error} /> : <SkeletonRows rows={2} />}
    </Section>
  )
}

function Welcome({ children }: { children: ReactNode }) {
  const a = useAccess()
  useDocumentTitle('首頁')
  return (
    <div className="rounded-xl border bg-card p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{a.siteName}</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">實驗室 GPU 主機的即時狀態、帳號登記與 SSH 金鑰管理。</p>
      <div className="mt-5">{children}</div>
    </div>
  )
}

/** /auth/callback redirects failed logins to /?login_error=oauth|identity (api.md). */
function LoginError() {
  const a = useAccess()
  const [params, setParams] = useSearchParams()
  const code = params.get('login_error')
  if (!code) return null
  const dismiss = () => {
    const next = new URLSearchParams(params)
    next.delete('login_error')
    setParams(next, { replace: true })
  }
  return (
    <div
      role="alert"
      data-testid="login-error"
      className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-crit-soft px-4 py-3 text-sm text-destructive"
    >
      <span className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {code === 'identity'
          ? `登入失敗：無法從 ${a.oauthName} 取得有效的身分，請聯絡網管。`
          : `登入失敗：${a.oauthName} 登入未完成，請再試一次。`}
      </span>
      <button type="button" onClick={dismiss} className="shrink-0 text-xs underline-offset-2 hover:underline">
        關閉
      </button>
    </div>
  )
}

export default function Home() {
  return (
    <>
      <LoginError />
      <HomeBody />
    </>
  )
}

function HomeBody() {
  const a = useAccess()
  if (a.isPending) return <SkeletonCards count={2} className="lg:grid-cols-2" />
  if (a.isError) return <ErrorState error={a.error} onRetry={() => void a.refetch()} />
  if (a.isMember) return <MemberHome />

  if (!a.loggedIn) {
    return (
      <>
        <Welcome>
          <Button asChild size="lg" data-testid="login">
            <a href={loginHref('/')}>
              <LogIn /> 使用 {a.oauthName} 登入
            </a>
          </Button>
        </Welcome>
        <PublicAnnouncements />
      </>
    )
  }

  // Logged in with SSO but not (or no longer) an active member.
  return (
    <>
      <Welcome>
        {a.user ? (
          <p className="text-sm">你的實驗室帳號目前為停用狀態，如有疑問請聯絡網管。</p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <RegistrationStatus
              fallback={
                <p className="text-sm">
                  你已用 {a.oauthName} 登入（{a.session?.identity?.sso_id}），但尚未開通實驗室帳號：先登記需求，助教會為你建立帳號並指派主機。
                </p>
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button asChild size="lg">
                <Link to="/request">
                  <UserPlus /> 登記 / 查看進度
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/guide">
                  <BookOpen /> 新成員指南
                </Link>
              </Button>
            </div>
          </div>
        )}
      </Welcome>
      <PublicAnnouncements />
    </>
  )
}
