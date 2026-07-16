/**
 * InspectorSection — collapsible property group for inspector panels.
 * Advanced-by-default sections start collapsed and their state persists
 * per section id, so publishers only see what they need. Progressive
 * disclosure is the antidote to "every property visible at once".
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Stable id used for persistence. */
  id: string;
  title: ReactNode;
  /** Right-aligned adornment (badge, count, icon). */
  meta?: ReactNode;
  /** Start collapsed when there is no persisted value. */
  defaultCollapsed?: boolean;
  children: ReactNode;
  className?: string;
}

function key(id: string) { return `inspector-section:${id}`; }

export function InspectorSection({ id, title, meta, defaultCollapsed = false, children, className }: Props) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return !defaultCollapsed;
    const raw = window.localStorage.getItem(key(id));
    if (raw === "1") return true;
    if (raw === "0") return false;
    return !defaultCollapsed;
  });

  useEffect(() => {
    try { window.localStorage.setItem(key(id), open ? "1" : "0"); } catch {}
  }, [id, open]);

  return (
    <section className={cn("rounded-md border bg-card", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        <span className="flex-1">{title}</span>
        {meta && <span className="text-[10px] font-normal normal-case">{meta}</span>}
      </button>
      {open && <div className="border-t px-3 py-3">{children}</div>}
    </section>
  );
}
