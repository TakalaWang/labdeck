import { ChartColumnBig, Cpu, Gpu, HardDrive } from 'lucide-react'

import { TabbedPage, type TabDef } from '@/components/route-tabs'
import Disk from '@/views/disk'
import GpuMonthly from '@/views/gpu-monthly'
import Gpus from '@/views/gpus'
import CpuMem from '@/views/usage'

const TABS: TabDef[] = [
  { id: 'gpu', label: 'GPU 即時', icon: Gpu },
  { id: 'cpu', label: 'CPU · 記憶體', icon: Cpu },
  { id: 'disk', label: '磁碟', icon: HardDrive },
  { id: 'monthly', label: '月報', icon: ChartColumnBig },
]

/** 使用量: who uses what, now and over the month. */
export default function UsageSection() {
  return (
    <TabbedPage
      title="使用量"
      tabs={TABS}
      render={(tab) => (tab === 'cpu' ? <CpuMem /> : tab === 'disk' ? <Disk /> : tab === 'monthly' ? <GpuMonthly /> : <Gpus />)}
    />
  )
}
