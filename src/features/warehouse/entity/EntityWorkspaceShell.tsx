/**
 * EntityWorkspaceShell — the ONLY approved skeleton for a warehouse entity
 * management workspace (ADR 0122).
 *
 * Where `EntityPreview` answers "what is this?", the workspace answers
 * "everything I can do with this": master data, configuration, stock,
 * activity, labels — and, in time, telemetry, capacity optimisation,
 * automation and audit. Those live as *tabs*, so the surface can absorb a
 * decade of warehouse capability without any of it being crammed into a
 * 420px side pane.
 *
 * It is a thin composition over the platform record primitives
 * (`RecordShell` + `RecordHeader`), so a warehouse object page looks and
 * behaves exactly like a Sales Order or an Employee — one interaction
 * language across the ERP (docs/design-system/records.md).
 *
 * The active tab lives in the URL (`?tab=`), and only the active tab's
 * content is constructed, so heavy panes cost nothing until opened.
 */
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordShell, RecordHeader, ActionBar } from "@/design-system";
import { cn } from "@/lib/utils";

export interface EntityWorkspaceTab {
  value: string;
  label: string;
  /** Rendered only while this tab is active. */
  render: () => ReactNode;
}

interface EntityWorkspaceShellProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  docNumber?: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  /** Route back to the board this entity was previewed from. */
  backHref: string;
  backLabel?: string;
  /** Entity-level actions (print, block, delete). */
  actions?: ReactNode;
  tabs: EntityWorkspaceTab[];
  aside?: ReactNode;
  footer?: ReactNode;
}

export function EntityWorkspaceShell({
  eyebrow,
  title,
  docNumber,
  status,
  meta,
  backHref,
  backLabel = "Back",
  actions,
  tabs,
  aside,
  footer,
}: EntityWorkspaceShellProps) {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const active = tabs.find((t) => t.value === requested) ?? tabs[0];

  return (
    <RecordShell
      aside={aside}
      footer={footer}
      header={
        <RecordHeader
          eyebrow={eyebrow}
          title={title}
          docNumber={docNumber}
          status={status}
          meta={meta}
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" asChild>
                <Link to={backHref}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> {backLabel}
                </Link>
              </Button>
              {actions}
            </ActionBar>
          }
          tabs={
            tabs.length > 1 ? (
              <nav
                className="-mb-3 mt-2 flex gap-1 overflow-x-auto"
                aria-label="Workspace sections"
              >
                {tabs.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    aria-current={t.value === active.value ? "page" : undefined}
                    onClick={() =>
                      setParams(
                        (prev) => {
                          const next = new URLSearchParams(prev);
                          next.set("tab", t.value);
                          return next;
                        },
                        { replace: true },
                      )
                    }
                    className={cn(
                      "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                      t.value === active.value
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            ) : undefined
          }
        />
      }
    >
      {active.render()}
    </RecordShell>
  );
}

export default EntityWorkspaceShell;
