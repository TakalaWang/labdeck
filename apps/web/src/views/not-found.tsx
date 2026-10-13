import { Compass } from 'lucide-react'
import { Link, useLocation } from '@/lib/router'

import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { useDocumentTitle } from '@/hooks/use-document-title'

export default function NotFound() {
  const { pathname } = useLocation()
  useDocumentTitle('找不到頁面')
  return (
    <div className="mx-auto max-w-lg py-10">
      <EmptyState heading="h1" title="找不到這個頁面" icon={<Compass className="size-6" />}>
        <p>
          <code className="font-mono text-xs break-all">{pathname}</code> 不存在，可能是網址打錯或頁面已移除。
        </p>
        <Button asChild size="sm" className="mt-4">
          <Link to="/">回首頁</Link>
        </Button>
      </EmptyState>
    </div>
  )
}
