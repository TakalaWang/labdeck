import { useId } from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { fmtDate } from '@/lib/format'
import type { Needs } from '@/lib/types'

/** Form state of Needs: numbers as typed, so a field can be empty while editing. */
export type NeedsDraft = { purpose: string; gpus: string; min_vram_gb: string; until: string }

export const emptyNeeds: NeedsDraft = { purpose: '', gpus: '1', min_vram_gb: '', until: '' }

export function draftOf(n: { purpose: string; gpus: number | null; min_vram_gb: number | null; until: string | null }): NeedsDraft {
  return { purpose: n.purpose, gpus: String(n.gpus ?? 0), min_vram_gb: n.min_vram_gb == null ? '' : String(n.min_vram_gb), until: n.until ?? '' }
}

export function needsOf(d: NeedsDraft): Needs {
  return {
    purpose: d.purpose.trim(),
    gpus: Number(d.gpus),
    min_vram_gb: d.min_vram_gb.trim() === '' ? null : Number(d.min_vram_gb),
    until: d.until,
  }
}

/** 用途, GPU 張數, 每張最低顯存, 預計使用到 — the same fields for a registration and a host request. */
export function NeedsFields({ value, onChange }: { value: NeedsDraft; onChange: (v: NeedsDraft) => void }) {
  const id = useId()
  const set = (k: keyof NeedsDraft, v: string) => onChange({ ...value, [k]: v })
  const today = fmtDate(new Date().toISOString()) // local date (toISOString alone is UTC)
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-p`}>用途</Label>
        <Textarea
          id={`${id}-p`}
          required
          rows={3}
          maxLength={2000}
          value={value.purpose}
          onChange={(e) => set('purpose', e.target.value)}
          placeholder="例如：碩士論文，訓練影像分割模型（PyTorch），每次約跑 2 天"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-g`}>GPU 張數</Label>
          <Input
            id={`${id}-g`}
            type="number"
            inputMode="numeric"
            required
            min={0}
            max={64}
            step={1}
            value={value.gpus}
            onChange={(e) => set('gpus', e.target.value)}
            aria-describedby={`${id}-g-hint`}
          />
          <p id={`${id}-g-hint`} className="text-xs text-muted-foreground">同時需要的張數；只用 CPU 填 0。</p>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-v`}>每張最低顯存（GB，選填）</Label>
          <Input
            id={`${id}-v`}
            type="number"
            inputMode="numeric"
            min={1}
            max={1024}
            step={1}
            value={value.min_vram_gb}
            onChange={(e) => set('min_vram_gb', e.target.value)}
            placeholder="不限"
          />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor={`${id}-u`}>預計使用到</Label>
          <Input id={`${id}-u`} type="date" required min={today} value={value.until} onChange={(e) => set('until', e.target.value)} />
        </div>
      </div>
    </>
  )
}

/** "2 張 GPU（每張 ≥ 24 GB）" */
export function needsText(n: { gpus: number | null; min_vram_gb: number | null }): string {
  if (n.gpus === null) return '未填（舊版申請）'
  if (n.gpus === 0) return '不需要 GPU'
  return `${n.gpus} 張 GPU${n.min_vram_gb ? `（每張 ≥ ${n.min_vram_gb} GB）` : ''}`
}
