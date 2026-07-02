/**
 * SalesScanReviewDrawer — Plan P2.
 *
 * A small floating panel that surfaces stale scans drained out of the
 * phone's offline queue. Live scans bypass this drawer entirely (see
 * `decideReplayPolicy`), so it is silent during normal cashier flow.
 *
 * The panel is positioned bottom-right, above the `SalesScanChip`, and
 * is collapsible. It only renders when there is at least one pending
 * inbox item, so it never adds chrome to the empty state.
 */

import { useState } from "react";
import { Inbox, X, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSalesScanContext } from "@/contexts/SalesScanContext";

function formatAge(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function SalesScanReviewDrawer() {
  const ctx = useSalesScanContext();
  const [collapsed, setCollapsed] = useState(false);
  if (!ctx || ctx.inbox.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Replayed scans pending review"
      className="w-80 max-w-[92vw] rounded-lg border border-border bg-card text-card-foreground shadow-lg"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">
            Replayed scans
            <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {ctx.inbox.length}
            </span>
          </span>
        </div>
        <button
          type="button"
          aria-label={collapsed ? "Expand" : "Collapse"}
          onClick={() => setCollapsed((v) => !v)}
          className="rounded p-1 hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {!collapsed && (
        <>
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            These scans arrived after a reconnect. Review before applying.
          </p>
          <ul className="max-h-64 overflow-y-auto px-2 py-2">
            {ctx.inbox.map((item) => {
              const ageMs = item.decodedAt
                ? Date.now() - item.decodedAt
                : Date.now() - item.receivedAt;
              return (
                <li
                  key={item.id}
                  className="mb-1 flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {item.resolved.name}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <code className="truncate">{item.code}</code>
                      <span>·</span>
                      <span>{formatAge(ageMs)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Discard ${item.code}`}
                    onClick={() => ctx.discardInboxItem(item.id)}
                    className="h-7 w-7 p-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Accept ${item.code}`}
                    onClick={() => ctx.acceptInboxItem(item.id)}
                    className="h-7 px-2"
                  >
                    <Check className="mr-1 h-3.5 w-3.5" />
                    Add
                  </Button>
                </li>
              );
            })}
          </ul>
          <footer className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={ctx.clearInbox}
              disabled={ctx.inbox.length === 0}
            >
              Discard all
            </Button>
            <Button
              size="sm"
              onClick={ctx.acceptAllInbox}
              disabled={ctx.inbox.length === 0}
            >
              Add all
            </Button>
          </footer>
        </>
      )}
    </div>
  );
}
