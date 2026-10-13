'use client'

import { EmptyState } from '@/components/states'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/router'

export default function RouteError({ error }: { error: Error & { digest?: string } }) {
  const chunkFailed = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch/i.test(`${error.name} ${error.message}`)
  return (
    <div className="mx-auto max-w-lg p-8">
      <EmptyState heading="h1" title={chunkFailed ? '網站已更新' : '頁面發生錯誤'}>
        <p>{chunkFailed ? '請重新整理頁面以載入最新版本。' : error.message || '未知錯誤'}</p>
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            重新整理
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/">回首頁</Link>
          </Button>
        </div>
      </EmptyState>
    </div>
  )
}
