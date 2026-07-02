/**
 * ScanGhostTicker — the "Walmart effect" strip.
 *
 * Two channels:
 *   1. Live progress (scanBus.onProgress) — renders the digits as they
 *      accumulate, with a blinking caret. This is the supermarket visible-
 *      typing effect, driven by real kernel state.
 *   2. Final feedback (scanFeedbackBus) — replaces the live chip with a
 *      success / weighted / unknown / pending badge for TTL_MS after the
 *      scan completes.
 *
 * Self-contained: no props.
 */

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Scale, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { scanFeedbackBus, type ScanFeedback } from "@/services/pos/scanFeedbackBus";
import { scanBus, type ScanProgress } from "@/services/pos/scanBus";

const TTL_MS = 1400;
const PROGRESS_IDLE_MS = 250;

export function ScanGhostTicker() {
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsub = scanFeedbackBus.on((f) => {
      setFeedback(f);
      // Final feedback wins — clear any in-flight progress chip.
      setProgress(null);
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      // "pending" stays until the next feedback (ok/unknown/weighted) lands.
      if (f.kind !== "pending") {
        feedbackTimerRef.current = window.setTimeout(() => {
          setFeedback((cur) => (cur === f ? null : cur));
        }, TTL_MS);
      }
    });
    return () => {
      unsub();
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const unsub = scanBus.onProgress((p) => {
      if (!p) {
        setProgress(null);
        if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
        return;
      }
      setProgress(p);
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = window.setTimeout(() => {
        setProgress(null);
      }, PROGRESS_IDLE_MS);
    });
    return () => {
      unsub();
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
    };
  }, []);

  // Live progress chip takes precedence over a stale final feedback only when
  // there is no active feedback. Final feedback always overrides progress.
  const showProgress = !!progress && !feedback;

  if (!showProgress && !feedback) return null;

  if (showProgress && progress) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed top-4 left-1/2 z-[60] -translate-x-1/2",
          "animate-in fade-in slide-in-from-top-2 duration-100",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-3 rounded-full border px-4 py-2 shadow-lg backdrop-blur",
            "font-mono text-sm",
            progress.committed
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border bg-background/95 text-foreground",
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              progress.committed ? "bg-primary animate-pulse" : "bg-muted-foreground/60",
            )}
          />
          <span className="tabular-nums tracking-wider">
            {progress.buffer}
            <span className="ml-0.5 inline-block w-[1ch] animate-pulse text-primary">|</span>
          </span>
        </div>
      </div>
    );
  }

  if (!feedback) return null;

  const isError = feedback.kind === "unknown" || feedback.kind === "error";
  const isWeighted = feedback.kind === "weighted";
  const isPending = feedback.kind === "pending";
  const Icon = isError
    ? AlertTriangle
    : isWeighted
      ? Scale
      : isPending
        ? Loader2
        : CheckCircle2;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-4 left-1/2 z-[60] -translate-x-1/2",
        "animate-in fade-in slide-in-from-top-2 duration-150",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3 rounded-full border px-4 py-2 shadow-lg backdrop-blur",
          "font-mono text-sm",
          isError
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-primary/30 bg-background/95 text-foreground",
        )}
      >
        <Icon
          className={cn(
            "h-4 w-4",
            isError ? "text-destructive" : "text-primary",
            isPending && "animate-spin",
          )}
        />
        <span className="tabular-nums tracking-wider text-muted-foreground">
          {feedback.raw}
        </span>
        {feedback.detail && (
          <>
            <span className="text-muted-foreground/50">›</span>
            <span className="font-sans font-medium">{feedback.detail}</span>
          </>
        )}
      </div>
    </div>
  );
}
