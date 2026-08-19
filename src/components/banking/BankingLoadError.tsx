import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NormalizedError } from "@/services/resilience";

/**
 * Inline, retryable load-failure panel for banking surfaces.
 *
 * Landing on Banking / Bank Feeds / Reconciliation must never fire a toast
 * for a page load: a slow or flaky link is not the same thing as "no
 * internet", and the operator needs a way forward, not an alert. The copy is
 * driven entirely by the `NormalizedError` kind (resilience contract — no raw
 * infrastructure text ever reaches the screen).
 */
export function BankingLoadError({
  error,
  what = "data",
  onRetry,
  isRetrying,
}: {
  error: NormalizedError;
  /** What failed, lower-case: "transactions", "bank accounts". */
  what?: string;
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  const offline = error.kind === "offline";
  const Icon = offline ? WifiOff : AlertTriangle;

  const headline = (() => {
    switch (error.kind) {
      case "offline":
        return `Can't reach the server to load ${what}`;
      case "timeout":
        return `Loading ${what} is taking longer than expected`;
      case "server_unavailable":
        return `The server is busy — ${what} didn't load`;
      case "permission_denied":
        return `You don't have access to these ${what}`;
      default:
        return `Couldn't load ${what}`;
    }
  })();

  const detail = (() => {
    switch (error.kind) {
      case "offline":
        return "We already retried a few times. Your connection may be slow or briefly dropped — nothing has been lost.";
      case "timeout":
        return "The request was cut short after 15 seconds. On a slow connection this often works on a second attempt.";
      case "server_unavailable":
        return "This is temporary. Try again in a moment.";
      default:
        return error.message;
    }
  })();

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{headline}</p>
        <p className="mx-auto max-w-md text-xs text-muted-foreground">{detail}</p>
      </div>
      {error.retryable && (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isRetrying ? "animate-spin" : ""}`} />
          {isRetrying ? "Retrying…" : "Try again"}
        </Button>
      )}
    </div>
  );
}
