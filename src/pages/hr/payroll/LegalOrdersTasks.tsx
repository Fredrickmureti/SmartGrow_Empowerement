/**
 * Legal Orders — Tasks tab. Phase 4 action inbox.
 *
 * A single triage view that answers the operator's question
 * "what needs my attention today?". Pulls read-only signals from
 * existing surfaces so no new writer paths are introduced.
 */
import { Link } from "react-router-dom";
import { AlertTriangle, ClipboardCheck, Link as LinkIcon, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLegalRecipientOutstanding } from "@/hooks/useLegalRecipients";
import { useLegalOrders } from "@/hooks/useLegalOrders";

function fmt(n: number) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export default function LegalOrdersTasks() {
  const { data: recipients = [] } = useLegalRecipientOutstanding();
  const { data: orders = [] } = useLegalOrders();

  const pendingApproval = orders.filter((o: any) => o.status === "pending_approval");
  const unlinked = recipients.filter((r) => !r.is_linked_to_contact);
  const overdue = recipients.filter(
    (r) =>
      Number(r.outstanding_balance ?? 0) > 0 &&
      r.oldest_accrual_date &&
      (!r.last_remittance_date || r.last_remittance_date < r.oldest_accrual_date),
  );
  const totalOutstanding = recipients.reduce(
    (s, r) => s + Number(r.outstanding_balance ?? 0),
    0,
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 min-w-0">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <Kpi
          label="Total outstanding"
          value={fmt(totalOutstanding)}
          hint="Accrued minus remitted, all recipients"
        />
        <Kpi label="Orders awaiting approval" value={pendingApproval.length} />
        <Kpi
          label="Recipients past due"
          value={overdue.length}
          tone={overdue.length ? "warn" : undefined}
        />
        <Kpi
          label="Recipients not linked"
          value={unlinked.length}
          tone={unlinked.length ? "warn" : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
        <TaskCard
          icon={<ClipboardCheck className="h-4 w-4" />}
          title="Orders awaiting approval"
          description="New or amended legal orders in pending_approval. Approve to release into the next payroll run."
          empty="No orders awaiting approval."
          items={pendingApproval.slice(0, 8).map((o: any) => ({
            key: o.id,
            primary: o.case_reference ?? o.kind_code ?? o.id,
            secondary: o.authority_name ?? o.employee_id,
            action: (
              <Link to="/hr/payroll/legal-orders/orders">
                <Button size="sm" variant="outline">Review</Button>
              </Link>
            ),
          }))}
        />

        <TaskCard
          icon={<LinkIcon className="h-4 w-4" />}
          title="Recipients not linked to a Contact"
          description="These recipients lack a Contact record, which blocks bank-file generation. Link or merge to fix."
          empty="Every recipient is linked to a Contact."
          items={unlinked.slice(0, 8).map((r) => ({
            key: r.recipient_id,
            primary: r.display_name,
            secondary: `${r.recipient_type_code} · ${r.order_count} order(s)`,
            action: (
              <Link to="/hr/payroll/legal-orders/recipients">
                <Button size="sm" variant="outline">Link</Button>
              </Link>
            ),
          }))}
        />

        <TaskCard
          icon={<Clock className="h-4 w-4" />}
          title="Recipients past due"
          description="Balances accrued after the most recent remittance. Include in the next remittance batch."
          empty="No overdue balances."
          items={overdue.slice(0, 8).map((r) => ({
            key: r.recipient_id,
            primary: r.display_name,
            secondary: `Outstanding ${fmt(Number(r.outstanding_balance))} · oldest ${r.oldest_accrual_date}`,
            action: (
              <Link to="/hr/payroll/legal-orders/remittance-batch">
                <Button size="sm" variant="outline">Batch</Button>
              </Link>
            ),
          }))}
        />

        <TaskCard
          icon={<AlertTriangle className="h-4 w-4" />}
          title="Top recipients by outstanding"
          description="Concentration view — the recipients absorbing the most unpaid balance right now."
          empty="No outstanding balances."
          items={recipients
            .filter((r) => Number(r.outstanding_balance) > 0)
            .slice(0, 8)
            .map((r) => ({
              key: r.recipient_id,
              primary: r.display_name,
              secondary: `${r.employee_count} employee(s) · ${r.order_count} order(s)`,
              action: (
                <Badge variant="secondary" className="tabular-nums">
                  {fmt(Number(r.outstanding_balance))}
                </Badge>
              ),
            }))}
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs sm:text-sm font-medium text-muted-foreground break-words">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cnTone(
            "text-xl sm:text-2xl font-semibold tabular-nums",
            tone === "warn" && "text-amber-600 dark:text-amber-500",
          )}
        >
          {value}
        </div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function cnTone(...parts: (string | false | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

function TaskCard({
  icon,
  title,
  description,
  items,
  empty,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  items: {
    key: string;
    primary: string;
    secondary?: string;
    action?: React.ReactNode;
  }[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y">
            {items.map((it) => (
              <li key={it.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{it.primary}</div>
                  {it.secondary && (
                    <div className="text-xs text-muted-foreground truncate">
                      {it.secondary}
                    </div>
                  )}
                </div>
                {it.action && <div className="shrink-0">{it.action}</div>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
