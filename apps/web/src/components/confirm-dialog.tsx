import { useId, useState, type ReactNode } from 'react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Destructive confirmation. With `expected`, the user must type it exactly before the
 * action unlocks (used for host delete). The dialog stays open while `onConfirm` runs
 * and closes only on success.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  expected,
  confirmLabel = '確認',
  destructive = true,
  onConfirm,
  children,
}: {
  trigger: ReactNode
  title: string
  description?: ReactNode
  expected?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => Promise<unknown>
  /** extra fields between the description and the buttons (e.g. an optional reason) */
  children?: ReactNode
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const ok = expected === undefined || typed === expected

  const run = async () => {
    setBusy(true)
    try {
      await onConfirm()
      setOpen(false)
      setTyped('')
    } catch {
      // Error toast is shown by the global mutation handler / caller.
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setTyped('')
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        {expected !== undefined && (
          <div className="grid gap-1.5">
            <Label htmlFor={id}>
              請輸入 <code className="rounded bg-muted px-1 font-mono">{expected}</code> 以確認
            </Label>
            <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={!ok || busy} onClick={() => void run()}>
            {busy ? '處理中…' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
