/**
 * DrillLink — the one approved "open the module that owns this" affordance.
 * Progressive disclosure by construction: a dashboard widget shows the
 * headline and hands off; it never duplicates a module view.
 */
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface DrillLinkProps {
  to: string;
  children: React.ReactNode;
  className?: string;
}

export function DrillLink({ to, children, className }: DrillLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--ds-radius-sm)] text-[length:var(--ds-text-caption)] font-medium text-primary",
        "transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}
