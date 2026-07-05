/**
 * WorkflowDrawer (plan §Phase 5d).
 *
 * Generic per-workflow drawer. Renders a `WorkflowSnapshot` from any of the
 * six workflow hooks with a uniform layout: state chip, ordered
 * preconditions, last actor, and a lifecycle timeline. Actions live in the
 * caller because they differ per workflow (post-gl, create batch, generate
 * return, etc.) — the drawer stays presentational.
 */
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { WorkflowSnapshot } from "@/hooks/payroll/workflows/types";
import { PayrollRunLifecycleTimeline } from "./PayrollRunLifecycleTimeline";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  snapshot: WorkflowSnapshot;
  runId?: string | null;
  /** Optional workflow-specific action node (buttons). */
  actions?: React.ReactNode;
  /** Optional extra content (e.g. batch list, return list). */
  children?: React.ReactNode;
}

export function WorkflowDrawer({ open, onOpenChange, title, description, snapshot, runId, actions, children }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {title}
            <Badge variant="outline" className="ml-auto capitalize">
              {snapshot.loading ? "…" : snapshot.state.replaceAll("_", " ")}
            </Badge>
          </SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>

        <section className="mt-6">
          <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Preconditions</h4>
          {snapshot.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <ul className="space-y-2">
              {snapshot.preconditions.map((p) => (
                <li key={p.code} className="flex items-start gap-2 text-sm">
                  {p.satisfied ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="h-4 w-4 text-rose-600 mt-0.5 shrink-0" />
                  )}
                  <span>
                    <span className="font-medium">{p.code}</span>
                    <span className="text-muted-foreground"> — {p.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {actions && (
          <section className="mt-6">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Actions</h4>
            <div className="flex flex-wrap gap-2">{actions}</div>
          </section>
        )}

        {snapshot.lastActor?.at && (
          <section className="mt-6 text-xs text-muted-foreground">
            Last transition {new Date(snapshot.lastActor.at).toLocaleString()}
            {snapshot.lastActor.userId && ` by ${snapshot.lastActor.userId.slice(0, 8)}…`}
          </section>
        )}

        {children && <section className="mt-6">{children}</section>}

        {runId && (
          <section className="mt-8">
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-3">Lifecycle</h4>
            <PayrollRunLifecycleTimeline runId={runId} />
          </section>
        )}
      </SheetContent>
    </Sheet>
  );
}