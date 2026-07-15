/**
 * MeHome — landing for `/me`
 *
 * The first thing employees see when they open "My Workspace". Surfaces:
 *   - Greeting with the employee's name
 *   - Quick-action tiles (Leave, Timesheet, Attendance, Expenses, Payslips, Documents, Profile)
 *   - At-a-glance leave balance summary
 *   - Recent payslips snapshot
 *
 * This is intentionally a *dashboard* — not the legacy `EmployeeSelfService`
 * page (which is still reachable via the action tiles for full detail).
 * Self-service is a portal capability gated by employment, not a paid app.
 */

import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  CalendarOff,
  Clock,
  ClipboardList,
  FileText,
  User as UserIcon,
  Wallet,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, PageBody, Section } from "@/design-system";
import { PayslipDetailDialog } from "@/components/payroll/PayslipDetailDialog";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useLeaveAllocations, type LeaveBalance } from "@/hooks/leave/useLeaveAllocations";
import { useLeaveRequests } from "@/hooks/leave/useLeaveRequests";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useEntitlementGate } from "@/hooks/useEntitlementGate";

interface QuickActionDef {
  to: string;
  label: string;
  description: string;
  icon: typeof CalendarOff;
  /** Optional — if set, the tile dims when the app isn't entitled / installed. */
  gateAppId?: string;
}

const QUICK_ACTIONS: QuickActionDef[] = [
  { to: "/me/leave",       label: "Time off",   description: "Request leave & view balances", icon: CalendarOff },
  { to: "/me/timesheets",  label: "Timesheets", description: "Log hours against projects",   icon: Clock,        gateAppId: "timesheets" },
  { to: "/me/attendance",  label: "Attendance", description: "Clock in / out history",        icon: ClipboardList },
  { to: "/me/onboarding",  label: "Onboarding", description: "New-hire checklist & tasks",    icon: ClipboardList },
  { to: "/me/loans",       label: "Loans",      description: "Request advances & track loans", icon: Wallet,      gateAppId: "payroll" },
  { to: "/me/payslips",    label: "Payslips",   description: "Download recent pay statements",icon: Wallet },
  { to: "/me/documents",   label: "Documents",  description: "Contracts, IDs, certifications",icon: FileText },
  { to: "/me/profile",     label: "My profile", description: "Personal & employment details", icon: UserIcon },
];

function QuickActionTile({ action }: { action: QuickActionDef }) {
  const Icon = action.icon;
  return (
    <Link
      to={action.to}
      className="group rounded-lg border bg-card p-4 hover:bg-accent hover:border-accent-foreground/20 transition-colors flex items-start gap-3"
    >
      <div className="h-10 w-10 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{action.label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{action.description}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

/**
 * Hide tiles for apps the org hasn't installed instead of "dimming" them and
 * sending portal users into the business app marketplace. Portal users have
 * no business asking their company to install Payroll — that's an admin
 * decision. Hiding (vs. locked-badge) keeps the surface clean and on-brand.
 */
function useVisibleActions(): QuickActionDef[] {
  const payroll = useEntitlementGate("payroll", "read");
  const timesheets = useEntitlementGate("timesheets", "read");
  return QUICK_ACTIONS.filter((a) => {
    if (a.gateAppId === "payroll") return payroll.allowed;
    if (a.gateAppId === "timesheets") return timesheets.allowed;
    return true;
  });
}

export default function MeHome() {
  const { user } = useAuth();
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const { getEmployeeBalances } = useLeaveAllocations();
  const { leaveRequests } = useLeaveRequests();
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [recentPayslips, setRecentPayslips] = useState<Array<{ id: string; period_label: string; net: number; currency: string }>>([]);
  const [loadingExtras, setLoadingExtras] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!currentEmployee) { setLoadingExtras(false); return; }
      setLoadingExtras(true);
      try {
        const [bal, slipsRes] = await Promise.all([
          getEmployeeBalances(currentEmployee.id),
          supabase
            .from("payslips")
            .select("id, net_pay, currency_code, payroll_run:payroll_runs(payroll_number, pay_period_start, pay_period_end)")
            .eq("employee_id", currentEmployee.id)
            .order("created_at", { ascending: false })
            .limit(3),
        ]);
        if (cancelled) return;
        setBalances(bal ?? []);
        const slips = (slipsRes.data ?? []).map((s: any) => ({
          id: s.id,
          period_label: s.payroll_run
            ? `${format(new Date(s.payroll_run.pay_period_start), "MMM d")} – ${format(new Date(s.payroll_run.pay_period_end), "MMM d, yyyy")}`
            : "Pay period",
          net: Number(s.net_pay ?? 0),
          currency: s.currency_code ?? "KES",
        }));
        setRecentPayslips(slips);
      } catch {
        // swallow — show empty states rather than blocking the page
      } finally {
        if (!cancelled) setLoadingExtras(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEmployee?.id]);

  const greetingName =
    currentEmployee?.first_name ||
    (user?.user_metadata?.full_name as string | undefined)?.split(" ")[0] ||
    "there";

  const pendingLeave = leaveRequests.filter((r) => r.status === "pending").length;

  return (
    <>
      <PageHeader
        title={`Hi ${greetingName} 👋`}
        description="Your workspace — leave, timesheets, payslips and personal details, all in one place."
      />
      <PageBody>
        <QuickActionsSection />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Leave summary */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Time off</CardTitle>
              <CardDescription>
                {pendingLeave > 0
                  ? `${pendingLeave} pending request${pendingLeave === 1 ? "" : "s"}`
                  : "No pending requests"}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/me/leave">Open</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {empLoading || loadingExtras ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : balances.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No leave allocations yet. Your administrator will set this up.
              </p>
            ) : (
              <ul className="divide-y">
                {balances.slice(0, 4).map((b) => (
                  <li key={b.leave_type_id} className="py-2 flex items-center justify-between">
                    <span className="text-sm">{b.leave_type_name}</span>
                    <span className="text-sm font-medium tabular-nums">
                      {Number(b.available ?? 0).toFixed(1)} <span className="text-muted-foreground font-normal">days</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent payslips */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Recent payslips</CardTitle>
              <CardDescription>Latest 3 pay periods</CardDescription>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/me/payslips">View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {empLoading || loadingExtras ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : recentPayslips.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No payslips have been issued to you yet.
              </p>
            ) : (
              <ul className="divide-y">
                {recentPayslips.map((p) => (
                  <li key={p.id} className="py-2 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setDetailId(p.id)}
                      className="text-sm text-left hover:underline truncate"
                      aria-label={`View detail for ${p.period_label}`}
                    >
                      {p.period_label}
                    </button>
                    <span className="text-sm font-medium tabular-nums whitespace-nowrap">
                      {p.currency} {p.net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        </div>
      <PayslipDetailDialog
        payslipId={detailId}
        open={!!detailId}
        onOpenChange={(v) => !v && setDetailId(null)}
        canSeeAmounts
        portalMode
        payslip={recentPayslips.find((p) => p.id === detailId) as any}
        currency={recentPayslips.find((p) => p.id === detailId)?.currency}
      />
      </PageBody>
    </>
  );
}

function QuickActionsSection() {
  const visible = useVisibleActions();
  return (
    <section>
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Quick actions</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visible.map((a) => (
          <QuickActionTile key={a.to} action={a} />
        ))}
      </div>
    </section>
  );
}
