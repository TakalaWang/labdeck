import { useCallback } from 'react'
import { useNavigate } from '@/lib/router'
import { toast } from 'sonner'

/** Success toast for actions that enqueue a runner job, with a link to the job page. */
export function useJobToast() {
  const navigate = useNavigate()
  return useCallback(
    (what: string, jobId: number | null | undefined) => {
      if (jobId == null) {
        toast.success(`${what}：沒有需要套用的變更`)
        return
      }
      toast.success(`${what}：已建立工作 #${jobId}`, {
        action: { label: '查看', onClick: () => navigate(`/admin/jobs/${jobId}`) },
      })
    },
    [navigate],
  )
}
