/**
 * Phase 4 P2 — payslip lifecycle timeline.
 *
 * Append-only audit visualisation. Reads `payslip_events` via
 * `usePayslipEvents` and renders one row per event in chronological order
 * (oldest first). Country-agnostic: events use a generic enum that means
 * the same thing in every jurisdiction.
 *
 * Hidden in portal mode by default — employees see a simpler subset (the
 * `portalMode` prop filters to `posted`, `paid`, `emailed`, `viewed`,
 * `downloaded`, `signed`) so they aren't shown internal HR transitions.
 */
import { Loader2, FileText, RefreshCw, CheckCircle2, Send, Banknote, Ban, GitBranch, Layers, RotateCcw, Eye, Download, Mail, PenLine } from "lucide-react";
import { usePayslipEvents, type PayslipEventType, type PayslipEvent } from "@/hooks/payroll/usePayslipEvents";

const ICONS: Record<PayslipEventType, React.ComponentType<{ className?: string }>> = {
  generated: FileText,
  recomputed: RefreshCw,
  approved: CheckCircle2,
  posted: Send,
  paid: Banknote,
  cancelled: Ban,
  corrected: GitBranch,
  superseded: Layers,
  reissued: RotateCcw,
  viewed: Eye,
  downloaded: Download,
  emailed: Mail,
  signed: PenLine,
};

const LABELS: Record<PayslipEventType, string> = {
  generated: "Generated",
  recomputed: "Recomputed",
  approved: "Approved",
  posted: "Posted",
  paid: "Paid",
  cancelled: "Cancelled",
  corrected: "Corrected",
  superseded: "Superseded",
  reissued: "Reissued",
  viewed: "Viewed",
  downloaded: "Downloaded",
  emailed: "Emailed",
  signed: "Signed",
};

const PORTAL_VISIBLE = new Set<PayslipEventType>([
  "posted",
  "paid",
  "emailed",
  "viewed",
  "downloaded",
  "signed",
]);

function fmtWhen(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function describeEvent(ev: PayslipEvent): string | null {
  const m = ev.metadata || {};
  if (ev.event_type === "generated") {
    const ver = (m as any).rule_set_version;
    return ver != null ? `Rule set v${ver}` : null;
  }
  const from = (m as any).from_status;
  const to = (m as any).to_status;
  if (from && to) return `${from} → ${to}`;
  if ((m as any).channel) return `Channel: ${(m as any).channel}`;
  if ((m as any).recipient) return `Recipient: ${(m as any).recipient}`;
  return null;
}

interface Props {
  payslipId: string | null | undefined;
  portalMode?: boolean;
}

export function PayslipEventsTimeline({ payslipId, portalMode = false }: Props) {
  const { data: events = [], isLoading } = usePayslipEvents(payslipId);

  if (!payslipId) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const visible = portalMode
    ? events.filter((e) => PORTAL_VISIBLE.has(e.event_type))
    : events;

  if (visible.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-3 text-center">
        No lifecycle events recorded yet.
      </p>
    );
  }

  return (
    <ol className="relative border-l border-border ml-3 space-y-3 py-1">
      {visible.map((ev) => {
        const Icon = ICONS[ev.event_type] ?? FileText;
        const sub = describeEvent(ev);
        return (
          <li key={ev.id} className="ml-4">
            <span className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background ring-2 ring-border">
              <Icon className="h-2.5 w-2.5 text-foreground/70" />
            </span>
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{LABELS[ev.event_type]}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {fmtWhen(ev.occurred_at)}
                </span>
              </div>
              {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
