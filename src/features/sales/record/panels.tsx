/**
 * Sales — shared record building blocks.
 *
 * These are the presentational primitives every Sales business record
 * (Invoice, SO, Estimate, Credit Note, Delivery Note, Return, Recurring,
 * Proforma, Customer Payment) composes from. They are opinionated wrappers
 * on top of `@/design-system` primitives so per-record pages only worry
 * about *data*, never about layout, spacing, or action placement.
 *
 * Rule of thumb: if you find yourself writing `<Card>` markup or a bespoke
 * two-column layout in a Sales record page, extend a primitive here instead.
 * Purchases / Inventory later mirror these under their own feature folder.
 */

import type { ReactNode } from "react";
import { SummaryPanel } from "@/design-system";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// DocumentTotalsPanel
// ---------------------------------------------------------------------------

export interface DocumentTotalsRow {
  label: ReactNode;
  value: ReactNode;
  /** Emphasize (e.g. grand total). */
  emphasized?: boolean;
  /** Muted (e.g. helper subtotal). */
  muted?: boolean;
}

interface DocumentTotalsPanelProps {
  title?: ReactNode;
  rows: DocumentTotalsRow[];
  /** Optional footer note (currency, FX rate, tax basis). */
  footer?: ReactNode;
}

/**
 * Right-rail totals for any Sales record. Consistent typography, alignment,
 * and emphasis across Invoice / SO / Estimate / Credit Note.
 */
export function DocumentTotalsPanel({
  title = "Totals",
  rows,
  footer,
}: DocumentTotalsPanelProps) {
  return (
    <SummaryPanel.Item title={title}>
      <dl className="space-y-2">
        {rows.map((row, i) => (
          <div
            key={i}
            className={cn(
              "flex items-baseline justify-between gap-3",
              row.emphasized && "border-t pt-2 text-base font-semibold",
              row.muted && "text-muted-foreground",
            )}
          >
            <dt className="min-w-0 truncate">{row.label}</dt>
            <dd className="shrink-0 tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      {footer && (
        <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </SummaryPanel.Item>
  );
}

// ---------------------------------------------------------------------------
// DocumentActivityPanel
// ---------------------------------------------------------------------------

export interface DocumentActivityEntry {
  id: string;
  at: string; // ISO or preformatted timestamp
  actor?: string;
  title: ReactNode;
  description?: ReactNode;
  /** Optional tone-driven dot. Matches StatusBadge tone taxonomy. */
  tone?: "neutral" | "info" | "success" | "warning" | "danger" | "accent";
}

interface DocumentActivityPanelProps {
  title?: ReactNode;
  entries: DocumentActivityEntry[];
  empty?: ReactNode;
}

const toneDot: Record<NonNullable<DocumentActivityEntry["tone"]>, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  accent: "bg-primary",
};

/**
 * Right-rail activity feed for any Sales record. Shared across all record
 * types so status transitions, comments, and system events render the same.
 */
export function DocumentActivityPanel({
  title = "Activity",
  entries,
  empty = "No activity yet.",
}: DocumentActivityPanelProps) {
  return (
    <SummaryPanel.Item title={title}>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ol className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  toneDot[e.tone ?? "neutral"],
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{e.title}</span>
                  {e.actor && (
                    <span className="text-muted-foreground">by {e.actor}</span>
                  )}
                </div>
                {e.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.description}
                  </p>
                )}
                <time className="mt-0.5 block text-xs text-muted-foreground">
                  {e.at}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </SummaryPanel.Item>
  );
}

// ---------------------------------------------------------------------------
// DocumentAttachmentsPanel
// ---------------------------------------------------------------------------

export interface DocumentAttachment {
  id: string;
  name: string;
  size?: string;
  href?: string;
}

interface DocumentAttachmentsPanelProps {
  title?: ReactNode;
  attachments: DocumentAttachment[];
  actions?: ReactNode;
  empty?: ReactNode;
}

export function DocumentAttachmentsPanel({
  title = "Attachments",
  attachments,
  actions,
  empty = "No files attached.",
}: DocumentAttachmentsPanelProps) {
  return (
    <SummaryPanel.Item title={title} actions={actions}>
      {attachments.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <a
                href={a.href}
                className="min-w-0 truncate text-sm text-primary hover:underline"
              >
                {a.name}
              </a>
              {a.size && (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {a.size}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SummaryPanel.Item>
  );
}
