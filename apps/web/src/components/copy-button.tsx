import ButtonCopy from '@/components/smoothui/button-copy'

async function writeClipboard(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Fallback for plain-HTTP campus deployments.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('copy failed')
}

export function CopyButton({ text, label = '複製', className }: { text: string; label?: string; className?: string }) {
  return <ButtonCopy label={label} className={className} onCopy={() => writeClipboard(text)} />
}

/** Monospace command/code line with a copy button. */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-muted/50 p-2 pl-3">
      <pre className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  )
}
