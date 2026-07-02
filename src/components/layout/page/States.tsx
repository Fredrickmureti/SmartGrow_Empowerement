/**
 * EmptyState / ErrorState / LoadingState — the single source for all three.
 *
 * Pages must never hand-roll their own. Compose these inside any *Shell.
 */
import { ReactNode } from "react";
import { Loader2, AlertCircle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

interface BaseStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

function StateShell({ title, description, icon, action, className }: BaseStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center py-16 px-6 rounded-lg border border-dashed border-border bg-muted/20",
        className,
      )}
    >
      <div className="mb-4 text-muted-foreground">{icon}</div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground max-w-md">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function EmptyState(props: Omit<BaseStateProps, "icon"> & { icon?: ReactNode }) {
  return <StateShell {...props} icon={props.icon ?? <Inbox className="h-10 w-10" />} />;
}

export function ErrorState(props: Omit<BaseStateProps, "icon"> & { icon?: ReactNode }) {
  return (
    <StateShell
      {...props}
      icon={props.icon ?? <AlertCircle className="h-10 w-10 text-destructive" />}
    />
  );
}

interface LoadingStateProps {
  message?: ReactNode;
  className?: string;
}

export function LoadingState({ message = "Loading…", className }: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="mt-3 text-sm">{message}</p>
    </div>
  );
}
