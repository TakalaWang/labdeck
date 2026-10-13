import { ShieldAlert, UserPlus } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link } from '@/lib/router'

import { RegistrationStatus } from '@/components/registration-status'
import { EmptyState, SkeletonRows } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { loginHref } from '@/lib/api'
import { useAccess } from '@/lib/session'

function ToLogin() {
  useEffect(() => {
    window.location.assign(loginHref())
  }, [])
  return <SkeletonRows rows={4} />
}

function NotMember({ oauthName, canRequest }: { oauthName: string; canRequest: boolean }) {
  useDocumentTitle('尚未開通')
  return (
    <EmptyState heading="h1" title="尚未開通實驗室帳號" icon={<UserPlus className="size-6" />}>
      {canRequest ? (
        <>
          <RegistrationStatus
            className="justify-center text-left"
            fallback={<p>你已用 {oauthName} 登入，但還不是實驗室成員：先登記需求，助教會為你建立帳號並指派主機。</p>}
          />
          <Button asChild size="sm" className="mt-3">
            <Link to="/request">登記 / 查看進度</Link>
          </Button>
        </>
      ) : (
        <p>你已用 {oauthName} 登入，但實驗室帳號已停用或已到期，如有疑問請聯絡助教。</p>
      )}
    </EmptyState>
  )
}

function Denied() {
  useDocumentTitle('權限不足')
  return (
    <EmptyState heading="h1" title="權限不足" icon={<ShieldAlert className="size-6" />}>
      此頁面僅限管理員使用。
    </EmptyState>
  )
}

/** SSO identity required (may not be a member yet). */
export function RequireIdentity({ children }: { children: ReactNode }) {
  const a = useAccess()
  if (a.isPending) return <SkeletonRows rows={6} />
  if (!a.loggedIn) return <ToLogin />
  return <>{children}</>
}

/** Active member required. */
export function RequireMember({ children }: { children: ReactNode }) {
  const a = useAccess()
  if (a.isPending) return <SkeletonRows rows={6} />
  if (!a.loggedIn) return <ToLogin />
  if (!a.isMember) return <NotMember oauthName={a.oauthName} canRequest={!a.user} />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const a = useAccess()
  if (a.isPending) return <SkeletonRows rows={6} />
  if (!a.loggedIn) return <ToLogin />
  if (!a.isAdmin) return <Denied />
  return <>{children}</>
}
