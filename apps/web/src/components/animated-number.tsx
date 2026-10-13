import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

// Display-only rolling number. SmoothUI's number components are inputs/steppers, so
// this reuses the DigitSlot technique from SmoothUI's animated-number-input: each
// digit rolls in the direction of change with a short, non-bouncy spring.

const SPRING = { type: 'spring' as const, bounce: 0, duration: 0.35 }
const ROLL = 12

const defaultFormat = (n: number) => n.toLocaleString('zh-TW')

export function AnimatedNumber({
  value,
  format = defaultFormat,
  className,
}: {
  value: number | null | undefined
  format?: (n: number) => string
  className?: string
}) {
  const reduce = !!useReducedMotion()
  const [prev, setPrev] = useState(value)
  const [direction, setDirection] = useState<1 | -1>(1)
  if (value !== prev) {
    // Adjust state during render (React docs pattern) to know which way to roll.
    setDirection(value != null && prev != null && value < prev ? -1 : 1)
    setPrev(value)
  }

  const text = value === null || value === undefined ? '—' : format(value)
  const chars = text.split('')
  return (
    <span className={cn('num inline-flex items-baseline', className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((ch, i) => {
          // Key from the right so units/ones stay aligned when the length changes.
          const pos = chars.length - i
          const roll = !reduce && ch >= '0' && ch <= '9'
          return (
            <span key={pos} className="relative inline-block overflow-hidden" style={{ lineHeight: 1.15 }}>
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={ch}
                  className="inline-block"
                  initial={roll ? { opacity: 0, y: direction * ROLL } : { opacity: 0 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={roll ? { opacity: 0, y: -direction * ROLL } : { opacity: 0 }}
                  transition={reduce ? { duration: 0 } : SPRING}
                >
                  {ch}
                </motion.span>
              </AnimatePresence>
            </span>
          )
        })}
      </span>
    </span>
  )
}
