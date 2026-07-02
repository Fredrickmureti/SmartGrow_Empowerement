/**
 * ConnectivityBanner
 *
 * Single global affordance for connectivity state. Three modes:
 *  - offline:  destructive red pill ("You're offline...")
 *  - degraded: amber pill ("Connection unstable — trying to reach the server…")
 *  - online + realtime degraded: subtle slate pill
 *      ("Live updates paused — reconnecting…")
 *  - online + realtime healthy: renders nothing
 *
 * Rendered as a floating overlay (fixed, top-centered) so it never
 * pushes page content down when it appears or disappears.
 *
 * Mount once near the app root, inside <ConnectivityProvider>.
 */
import { Wifi, WifiOff, RefreshCw, Radio } from "lucide-react";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { cn } from "@/lib/utils";

function OverlayShell({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "destructive" | "amber" | "muted";
}) {
  const toneCls =
    tone === "destructive"
      ? "bg-destructive text-destructive-foreground shadow-lg"
      : tone === "amber"
      ? "bg-amber-500/95 text-amber-50 dark:bg-amber-500/90 shadow-md border border-amber-600/40"
      : "bg-muted/95 text-muted-foreground border shadow-sm backdrop-blur";
  return (
    <div
      className="pointer-events-none fixed top-2 inset-x-0 z-[60] flex justify-center px-2"
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "pointer-events-auto rounded-full text-sm flex items-center gap-2",
          tone === "muted" ? "px-3 py-1 text-xs" : "px-4 py-2",
          toneCls,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ConnectivityBanner() {
  const { status, isRealtimeDegraded, probe, lastOnlineAt } = useConnectivity();

  // Offline / degraded dominate over realtime issues.
  if (status === "offline") {
    const since = lastOnlineAt
      ? new Date(lastOnlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
    return (
      <OverlayShell tone="destructive">
        <WifiOff className="h-4 w-4" />
        <span>
          You're offline{since ? ` since ${since}` : ""}. Your work will sync when you reconnect.
        </span>
      </OverlayShell>
    );
  }

  if (status === "degraded") {
    return (
      <OverlayShell tone="amber">
        <Wifi className="h-4 w-4" />
        <span>Connection unstable — trying to reach the server…</span>
        <button
          type="button"
          onClick={() => { void probe(); }}
          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </OverlayShell>
    );
  }

  if (isRealtimeDegraded) {
    return (
      <OverlayShell tone="muted">
        <Radio className="h-3 w-3" />
        <span>Live updates paused — reconnecting…</span>
      </OverlayShell>
    );
  }

  return null;
}
