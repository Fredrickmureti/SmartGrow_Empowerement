/**
 * Slice F — operator dashboard for Statutory Remittances.
 *
 * Five data-driven cells fed by the single RPC
 * `payroll_remittance_dashboard(org_id, business_id)`:
 *   1. Outstanding liabilities by authority + currency
 *   2. Returns due within the next 30 days (from `payroll_filing_calendar` v2)
 *   3. Returns in the pending-submission funnel (generated / pending_approval)
 *   4. Returns awaiting authority acknowledgement
 *   5. Remittance payments posted to GL but not yet bank-cleared
 *
 * No country branches. Everything is derived from pack metadata + ledger state.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { AlertTriangle, Clock, FileWarning, Landmark, Send } from "lucide-react";
import { format } from "date-fns";

interface DashboardPayload {
  outstanding_by_authority: Array<{
    authority_name: string;
    currency_code: string;
    open_count: number;
    total_outstanding: number;
    earliest_due: string | null;
  }>;
  returns_due_30d: Array<{
    template_code: string;
    display_name: string;
    authority_name: string;
    due_date: string;
    state: string;
    is_overdue: boolean;
    is_overridden: boolean;
    override_stale: boolean;
    upgrade_pending: boolean;
    approval_required: boolean;
  }>;
  returns_pending_submission: Array<{
    id: string;
    template_code: string;
    period_end: string;
    status: string;
    reconciliation_status: string | null;
    approver_id: string | null;
  }>;
  returns_awaiting_ack: Array<{
    id: string;
    template_code: string;
    period_end: string;
    submission_channel: string | null;
    submitted_at: string | null;
  }>;
  uncleared_payments: Array<{
    id: string;
    payment_date: string;
    total_amount: number;
    currency_code: string;
    reference_number: string | null;
  }>;
  generated_at: string;
}

const EMPTY: DashboardPayload = {
  outstanding_by_authority: [],
  returns_due_30d: [],
  returns_pending_submission: [],
  returns_awaiting_ack: [],
  uncleared_payments: [],
  generated_at: new Date().toISOString(),
};

export function RemittanceOperatorDashboard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();

  const { data = EMPTY, isLoading } = useQuery({
    queryKey: ["payroll-remittance-dashboard", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("payroll_remittance_dashboard", {
        p_organization_id: currentOrg!.id,
        p_business_id: currentBusiness!.id,
      });
      if (error) throw error;
      return (data || EMPTY) as DashboardPayload;
    },
    staleTime: 30_000,
  });

  const totalOutstanding = data.outstanding_by_authority.reduce(
    (s, r) => s + Number(r.total_outstanding || 0),
    0,
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {/* Cell 1 — Outstanding liabilities by authority */}
      <Card className="xl:col-span-2">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Outstanding liabilities
          </CardTitle>
          <span className="text-sm text-muted-foreground">
            {isLoading ? "—" : formatCurrency(totalOutstanding)} total
          </span>
        </CardHeader>
        <CardContent className="pt-0">
          {data.outstanding_by_authority.length === 0 ? (
            <EmptyHint text="No open statutory liabilities." />
          ) : (
            <ul className="divide-y">
              {data.outstanding_by_authority.map((r) => (
                <li
                  key={`${r.authority_name}-${r.currency_code}`}
                  className="py-2 flex items-center justify-between text-sm"
                >
                  <div>
                    <div className="font-medium">{r.authority_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.open_count} open · earliest due{" "}
                      {r.earliest_due ? format(new Date(r.earliest_due), "PP") : "—"}
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    {formatCurrency(Number(r.total_outstanding), r.currency_code)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Cell 2 — Returns due in 30 days */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" /> Returns due (next 30 days)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.returns_due_30d.length === 0 ? (
            <EmptyHint text="Nothing due in the next 30 days." />
          ) : (
            <ul className="divide-y">
              {data.returns_due_30d.slice(0, 6).map((r) => (
                <li key={`${r.template_code}-${r.due_date}`} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{r.display_name}</span>
                    <span
                      className={
                        r.is_overdue
                          ? "text-xs text-destructive font-medium"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {format(new Date(r.due_date), "PP")}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge variant="outline" className="text-[10px]">
                      {r.authority_name}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      {r.state}
                    </Badge>
                    {r.is_overridden && (
                      <Badge variant="outline" className="text-[10px]">
                        overridden
                      </Badge>
                    )}
                    {r.override_stale && (
                      <Badge variant="destructive" className="text-[10px]">
                        stale override
                      </Badge>
                    )}
                    {r.upgrade_pending && (
                      <Badge variant="outline" className="text-[10px]">
                        upgrade pending
                      </Badge>
                    )}
                    {r.approval_required && (
                      <Badge variant="outline" className="text-[10px]">
                        approval req.
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Cell 3 — Pending submission */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileWarning className="h-4 w-4" /> Pending submission
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.returns_pending_submission.length === 0 ? (
            <EmptyHint text="No returns waiting to be submitted." />
          ) : (
            <ul className="divide-y">
              {data.returns_pending_submission.slice(0, 6).map((r) => (
                <li key={r.id} className="py-2 text-sm flex items-center justify-between">
                  <div>
                    <div className="font-medium">{r.template_code}</div>
                    <div className="text-xs text-muted-foreground">
                      period ends {format(new Date(r.period_end), "PP")}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Badge variant="secondary" className="text-[10px]">
                      {r.status}
                    </Badge>
                    {r.reconciliation_status &&
                      r.reconciliation_status !== "ok" &&
                      r.reconciliation_status !== "not_applicable" && (
                        <Badge
                          variant={
                            r.reconciliation_status === "breach" ? "destructive" : "outline"
                          }
                          className="text-[10px]"
                        >
                          recon: {r.reconciliation_status}
                        </Badge>
                      )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Cell 4 — Awaiting acknowledgement */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Send className="h-4 w-4" /> Awaiting acknowledgement
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.returns_awaiting_ack.length === 0 ? (
            <EmptyHint text="No returns awaiting authority acknowledgement." />
          ) : (
            <ul className="divide-y">
              {data.returns_awaiting_ack.slice(0, 6).map((r) => (
                <li key={r.id} className="py-2 text-sm flex items-center justify-between">
                  <div>
                    <div className="font-medium">{r.template_code}</div>
                    <div className="text-xs text-muted-foreground">
                      submitted{" "}
                      {r.submitted_at ? format(new Date(r.submitted_at), "PP") : "—"}
                      {r.submission_channel ? ` · ${r.submission_channel}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Cell 5 — Uncleared payments */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Payments awaiting bank clearance
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.uncleared_payments.length === 0 ? (
            <EmptyHint text="All posted remittance payments have cleared." />
          ) : (
            <ul className="divide-y">
              {data.uncleared_payments.slice(0, 6).map((r) => (
                <li key={r.id} className="py-2 text-sm flex items-center justify-between">
                  <div>
                    <div className="font-medium">
                      {formatCurrency(Number(r.total_amount), r.currency_code)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {format(new Date(r.payment_date), "PP")}
                      {r.reference_number ? ` · ${r.reference_number}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-xs text-muted-foreground py-2">{text}</p>;
}
