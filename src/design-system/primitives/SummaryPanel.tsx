/**
 * SummaryPanel — the right-rail companion for a RecordShell.
 *
 * Holds totals, activity, attachments, related records — anything that
 * belongs alongside the main record body rather than inside it. Renders
 * a stack of collapsible SummaryPanel.Item blocks; each block owns its
 * own title + optional actions.
 */
import type { ReactNode, FC } from "react";
import { cn } from "@/lib/utils";

interface SummaryPanelProps {
  children: ReactNode;
  className?: string;
}

interface SummaryPanelItemProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

interface SummaryPanelComponent extends FC<SummaryPanelProps> {
  Item: FC<SummaryPanelItemProps>;
}

export const SummaryPanel: SummaryPanelComponent = (({
  children,
  className,
}: SummaryPanelProps) => (
  <div className={cn("space-y-4", className)}>{children}</div>
)) as SummaryPanelComponent;

SummaryPanel.Item = function SummaryPanelItem({
  title,
  actions,
  children,
  className,
}: SummaryPanelItemProps) {
  return (
    <section
      className={cn(
        "rounded-[var(--ds-radius-lg)] border bg-card shadow-[var(--ds-elevation-1)]",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          {title && (
            <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          )}
          {actions && (
            <div className="flex shrink-0 items-center gap-1">{actions}</div>
          )}
        </header>
      )}
      <div className="px-4 py-3 text-sm">{children}</div>
    </section>
  );
};