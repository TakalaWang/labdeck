'use client'

import { useQueryClient } from '@tanstack/react-query'
import {
  BookOpen,
  ChartColumnBig,
  ClipboardList,
  House,
  KeyRound,
  LogIn,
  LogOut,
  Megaphone,
  Server,
  ServerCog,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Suspense, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from '@/lib/router'

import ThemeToggle, { type ThemeToggleValue } from '@/components/smoothui/theme-toggle'
import { SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { usePendingRequests } from '@/hooks/use-pending-requests'
import { api, errorMessage, loginHref } from '@/lib/api'
import { ROLE_LABEL } from '@/lib/labels'
import { useAccess } from '@/lib/session'
import { useTheme } from '@/lib/theme'
import { toast } from 'sonner'

/** `section`: the path prefix the item stands for (its link may carry ?tab=); `also`: other prefixes under it. */
type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean; section?: string; also?: string[]; badge?: number | null }

const HOME: NavItem = { to: '/', label: '首頁', icon: House, end: true }
const ANNOUNCEMENTS: NavItem = { to: '/announcements', label: '公告與維護', icon: Megaphone }
const GUIDE: NavItem = { to: '/guide', label: '新成員指南', icon: BookOpen }

const OVERVIEW: NavItem[] = [
  HOME,
  { to: '/hosts', label: '主機', icon: Server },
  { to: '/usage?tab=gpu', section: '/usage', label: '使用量', icon: ChartColumnBig },
  ANNOUNCEMENTS,
  { to: '/me', label: '我的帳號', icon: KeyRound },
]

const ADMIN: NavItem[] = [
  { to: '/admin/requests', label: '待指派', icon: UserPlus },
  { to: '/admin/people', label: '人員與帳號', icon: Users },
  { to: '/admin/hosts', label: '主機管理', icon: ServerCog },
  { to: '/admin/ops', label: '維運', icon: Wrench, also: ['/admin/jobs'] },
]

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const { pathname } = useLocation()
  const { setOpenMobile, isMobile } = useSidebar()
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`)
            const active = item.end ? pathname === item.to : [item.section ?? item.to, ...(item.also ?? [])].some(under)
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
                  <NavLink to={item.to} end={item.end} onClick={() => isMobile && setOpenMobile(false)}>
                    <item.icon />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
                {!!item.badge && (
                  <SidebarMenuBadge
                    data-testid={`nav-badge-${item.to}`}
                    className="rounded-full bg-warn-soft px-1.5 text-warn-ink peer-hover/menu-button:text-warn-ink peer-data-active/menu-button:text-warn-ink"
                  >
                    {item.badge}
                    <span className="sr-only"> 筆待處理</span>
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function Logo() {
  // LabDeck mark (rack + pulse), same file as the favicon and docs/assets/logo.svg.
  return <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
}

function AppSidebar() {
  const a = useAccess()
  const pending = usePendingRequests()
  const admin = ADMIN.map((item) => (item.to === '/admin/requests' ? { ...item, badge: pending } : item))
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip={a.siteName}>
              <Link to="/">
                <Logo />
                <span className="truncate font-semibold">{a.siteName}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {a.isPending ? null : a.isMember ? (
          <NavGroup label="總覽" items={OVERVIEW} />
        ) : (
          <NavGroup label="總覽" items={[HOME, ANNOUNCEMENTS]} />
        )}
        {a.loggedIn && !a.isMember && (
          <NavGroup label="我的" items={[{ to: '/request', label: '登記', icon: ClipboardList }, GUIDE]} />
        )}
        {a.isAdmin && <NavGroup label="管理" items={admin} />}
      </SidebarContent>
      <SidebarFooter />
      <SidebarRail />
    </Sidebar>
  )
}

function UserMenu() {
  const a = useAccess()
  const qc = useQueryClient()
  if (a.isPending) return null
  if (!a.loggedIn) {
    return (
      <Button asChild size="sm">
        <a href={loginHref()}>
          <LogIn /> 登入
        </a>
      </Button>
    )
  }
  const name = a.user?.username ?? a.session?.identity?.sso_id ?? '使用者'
  const logout = async () => {
    try {
      await api.post('/api/logout')
      qc.clear()
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full reload drops every cached query
      window.location.assign('/')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2" aria-label={`使用者選單：${name}`}>
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground uppercase"
          >
            {name.slice(0, 1)}
          </span>
          <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {a.user ? ROLE_LABEL[a.user.role] : `${a.oauthName} 身分（尚未開通）`}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {a.isMember ? (
            <>
              <DropdownMenuItem asChild>
                <Link to="/me">
                  <KeyRound /> 我的帳號
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/guide">
                  <BookOpen /> 新成員指南
                </Link>
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem asChild>
              <Link to="/request">
                <ClipboardList /> 登記
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void logout()}>
            <LogOut /> 登出
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  return (
    <ThemeToggle
      variant="sun-moon"
      size="xs"
      theme={theme}
      onThemeChange={(t: ThemeToggleValue) => setTheme(t)}
    />
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        跳到主要內容
      </a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="flex-1" />
          <ThemeSwitch />
          <UserMenu />
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] min-w-0 px-4 py-5 outline-none sm:px-6 sm:py-6">
          <Suspense fallback={<SkeletonRows rows={8} />}>
            {children}
          </Suspense>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
