"use client";

import { Check, Copy, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface ButtonCopyProps {
  className?: string;
  /** Accessible label in the idle state */
  label?: string;
  disabled?: boolean;
  duration?: number;
  idleIcon?: ReactNode;
  loadingDuration?: number;
  loadingIcon?: ReactNode;
  onCopy?: () => Promise<void> | void;
  successIcon?: ReactNode;
}

const defaultIcons = {
  idle: <Copy size={14} />,
  loading: (
    <LoaderCircle
      className="animate-spin motion-reduce:animate-none"
      size={14}
    />
  ),
  success: <Check size={14} />,
};

export default function ButtonCopy({
  onCopy,
  idleIcon = defaultIcons.idle,
  loadingIcon = defaultIcons.loading,
  successIcon = defaultIcons.success,
  className = "",
  label = "複製",
  duration = 2000,
  loadingDuration = 150,
  disabled = false,
}: ButtonCopyProps) {
  const [buttonState, setButtonState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const shouldReduceMotion = useReducedMotion();

  const requestId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      requestId.current += 1;
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
    },
    []
  );

  const handleClick = useCallback(async () => {
    const request = ++requestId.current;
    setButtonState("loading");
    try {
      await onCopy?.();
    } catch {
      if (request === requestId.current) {
        setButtonState("error");
      }
      return;
    }
    if (request !== requestId.current) {
      return;
    }
    timers.current = [
      setTimeout(() => setButtonState("success"), loadingDuration),
      setTimeout(() => setButtonState("idle"), loadingDuration + duration),
    ];
  }, [onCopy, loadingDuration, duration]);

  const icons = {
    error: idleIcon,
    idle: idleIcon,
    loading: loadingIcon,
    success: successIcon,
  };

  const ariaLabels = {
    error: "複製失敗，請再試一次",
    idle: label,
    loading: "複製中…",
    success: "已複製",
  };

  return (
    <div className="flex shrink-0 justify-center">
      <button
        aria-label={ariaLabels[buttonState]}
        title={ariaLabels[buttonState]}
        aria-live="polite"
        className={`relative inline-flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-md border bg-background text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 ${className}`}
        disabled={
          buttonState === "loading" || buttonState === "success" || disabled
        }
        onClick={handleClick}
        type="button"
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={
              shouldReduceMotion
                ? { opacity: 1 }
                : { filter: "blur(0px)", opacity: 1, y: 0 }
            }
            className="flex w-full items-center justify-center"
            exit={
              shouldReduceMotion
                ? { opacity: 0, transition: { duration: 0 } }
                : { filter: "blur(10px)", opacity: 0, y: 25 }
            }
            initial={
              shouldReduceMotion
                ? { opacity: 1 }
                : { filter: "blur(10px)", opacity: 0, y: -25 }
            }
            key={buttonState}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { bounce: 0, duration: 0.25, type: "spring" as const }
            }
          >
            {icons[buttonState]}
          </motion.span>
        </AnimatePresence>
      </button>
    </div>
  );
}
