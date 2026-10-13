// SmoothUI animated-progress-bar (https://smoothui.dev/r/animated-progress-bar.json),
// tuned for a dense dashboard: animates `scaleX` instead of `width` (compositor-only,
// cheap with hundreds of bars on the GPU board), no bounce, theme-token colors, and
// progressbar semantics.
import { cn } from "@/lib/utils";
import { motion, useReducedMotion } from "motion/react";

export interface AnimatedProgressBarProps {
  barClassName?: string;
  className?: string;
  /** Any CSS color; defaults to the primary token. */
  color?: string;
  /** Accessible name (also rendered visually unless `hideLabel`). */
  label?: string;
  hideLabel?: boolean;
  labelClassName?: string;
  value: number; // 0-100
  /** Human readable value for assistive tech, e.g. "43%". */
  valueText?: string;
}

const MIN_PROGRESS_VALUE = 0;
const MAX_PROGRESS_VALUE = 100;

const SPRING = {
  bounce: 0,
  duration: 0.6,
  type: "spring" as const,
};

export default function AnimatedProgressBar({
  value,
  label,
  hideLabel = true,
  valueText,
  color = "var(--primary)",
  className = "",
  barClassName = "",
  labelClassName = "",
}: AnimatedProgressBarProps) {
  const shouldReduceMotion = useReducedMotion();
  const clamped = Math.max(
    MIN_PROGRESS_VALUE,
    Math.min(MAX_PROGRESS_VALUE, Number.isFinite(value) ? value : 0)
  );

  return (
    <div className={cn("w-full", className)}>
      {label && !hideLabel ? (
        <div className={cn("mb-1 font-medium text-sm", labelClassName)}>
          {label}
        </div>
      ) : null}
      <div
        aria-label={label}
        aria-valuemax={MAX_PROGRESS_VALUE}
        aria-valuemin={MIN_PROGRESS_VALUE}
        aria-valuenow={Math.round(clamped)}
        aria-valuetext={valueText}
        className={cn(
          "relative h-1.5 w-full overflow-hidden rounded-full bg-track",
          barClassName
        )}
        role="progressbar"
      >
        <motion.div
          animate={{ scaleX: clamped / MAX_PROGRESS_VALUE }}
          className="absolute inset-0 origin-left rounded-full"
          initial={{ scaleX: 0 }}
          style={{ backgroundColor: color }}
          transition={shouldReduceMotion ? { duration: 0 } : SPRING}
        />
      </div>
    </div>
  );
}
