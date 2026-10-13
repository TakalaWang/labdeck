import type { Element, ElementContent } from 'hast'
import { Link as LinkIcon } from 'lucide-react'
import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from '@/lib/router'
import remarkGfm from 'remark-gfm'

import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/utils'

// Admin-written Markdown rendered safely: react-markdown builds React elements (no innerHTML), raw HTML in the
// source is not rendered, and its default urlTransform drops javascript:/data: links.

function hastText(n: ElementContent | Element): string {
  if (n.type === 'text') return n.value
  if (n.type === 'element') return n.children.map(hastText).join('')
  return ''
}

function nodeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? nodeText(c.props.children) : ''))
    .join('')
}

/** Heading id: the text with spaces as hyphens (CJK kept), so `#3-第一次登入改密碼` links work. */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
}

function heading(Tag: 'h1' | 'h2' | 'h3' | 'h4', className: string) {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slug(nodeText(children))
    return (
      <Tag id={id} className={cn('group scroll-mt-16', className)}>
        {children}
        <a
          href={`#${id}`}
          aria-label="此段落的連結"
          className="ml-2 inline-flex align-middle text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <LinkIcon className="size-4" aria-hidden="true" />
        </a>
      </Tag>
    )
  }
}

const components: Components = {
  h1: heading('h1', 'mt-2 mb-4 text-2xl font-semibold tracking-tight'),
  h2: heading('h2', 'mt-10 mb-3 border-b pb-2 text-lg font-semibold first:mt-0'),
  h3: heading('h3', 'mt-6 mb-2 text-base font-semibold'),
  h4: heading('h4', 'mt-4 mb-2 text-sm font-semibold'),
  p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="leading-7 [&>p]:my-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-primary/40 bg-muted/40 py-1 pr-3 pl-4 text-foreground/85">{children}</blockquote>
  ),
  hr: () => <hr className="my-8" />,
  a: ({ href = '', children }) =>
    href.startsWith('/') && !href.startsWith('//') ? (
      <Link to={href} className="font-medium text-primary underline-offset-4 hover:underline">
        {children}
      </Link>
    ) : (
      <a
        href={href}
        className="font-medium text-primary underline-offset-4 hover:underline"
        {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer noopener' })}
      >
        {children}
      </a>
    ),
  code: ({ className, children }) => (
    // Block code keeps its language class and is styled by `pre`; inline code gets a chip.
    <code className={className ?? 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]'}>{children}</code>
  ),
  pre: ({ node, children }) => {
    const text = node ? hastText(node).replace(/\n$/, '') : ''
    return (
      <div className="group/code relative my-4 max-w-full min-w-0">
        <pre className="max-w-full overflow-x-auto rounded-lg border bg-muted/50 p-3 pr-12 font-mono text-[13px] leading-relaxed">{children}</pre>
        <div className="absolute top-1.5 right-1.5">
          <CopyButton text={text} label="複製程式碼" />
        </div>
      </div>
    )
  },
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border-b bg-muted/50 px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b px-3 py-2 align-top">
      {children}
    </td>
  ),
  img: ({ src, alt }) => <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="my-3 max-w-full rounded-lg" />,
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('min-w-0 text-[15px] break-words text-foreground/90', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {source}
      </ReactMarkdown>
    </div>
  )
}
