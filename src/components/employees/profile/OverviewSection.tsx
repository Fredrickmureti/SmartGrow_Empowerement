/**
 * Profile Overview — the readiness console (Wave F).
 *
 * Answers the three questions an HR manager actually opens an employee for:
 *   1. Are they payroll-ready? (live findings from `usePayrollReadiness`)
 *   2. Why are they inactive / what is their employment state?
 *   3. Do they have portal access, and if not, what is the next step?
 *
 * Plus three operational snapshots (Time off · Attendance · Open items),
 * each deep-linking into the relevant profile section via the existing
 * `?section=` contract. Heavy data still lives in the dedicated sections.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Mail, Phone, MapPin, User, Briefcase, Calendar, ArrowRight,
  CheckCircle2, AlertTriangle, ShieldCheck, ShieldAlert, ShieldOff,
  Clock, Timer, FileText, ClipboardList, LogOut, Loader2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { format, differenceInDays } from "date-fns";
import type { EmployeeProfile } from "@/hooks/useEmployeeProfile";
import { EmployeeTrendDrawer } from "@/components/attendance/EmployeeTrendDrawer";
import { useEffect, useState } from "react";
import { useLeaveAllocations, type LeaveBalance } from "@/hooks/leave/useLeaveAllocations";
import { useEmployeeAttendanceSummary } from "@/hooks/hr/useEmployeeAttendanceSummary";

interface Props {
  employee: EmployeeProfile;
  onNavigateSection: (id: string) => void;
}

export function OverviewSection({ employee, onNavigateSection }: Props) {
  const tenure = (() => {
    if (!employee.hire_date) return null;
    const start = new Date(employee.hire_date);
    const end = employee.termination_date ? new Date(employee.termination_date) : new Date();
    const months = Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
    const years = Math.floor(months / 12);
    const rem = months % 12;
    if (years === 0) return `${months} mo`;
    if (rem === 0) return `${years} yr`;
    return `${years} yr ${rem} mo`;
  })();


  // --- Time-off balances (top 3) -----------------------------------------
  const { getEmployeeBalances } = useLeaveAllocations();
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalance[]>([]);
  const [leaveLoading, setLeaveLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLeaveLoading(true);
    getEmployeeBalances(employee.id)
      .then((rows) => { if (!cancelled) setLeaveBalances(rows ?? []); })
      .catch(() => { if (!cancelled) setLeaveBalances([]); })
      .finally(() => { if (!cancelled) setLeaveLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id]);
  const topLeave = [...leaveBalances]
    .sort((a, b) => (b.available ?? 0) - (a.available ?? 0))
    .slice(0, 3);

  // --- Attendance (last 30d) ---------------------------------------------
  const { summary: att, isLoading: attLoading } = useEmployeeAttendanceSummary(employee.id, 30);
  const totalAtt = (att?.presentDays ?? 0) + (att?.lateDays ?? 0) + (att?.absentDays ?? 0);
  const attPct = totalAtt > 0 ? Math.round(((att.presentDays + att.lateDays) / totalAtt) * 100) : null;

  // --- Portal access ------------------------------------------------------
  const portalLinked = !!employee.user_id;
  const portalStatus = (employee as any).user_access_status as string | undefined;

  // --- Employment summary string -----------------------------------------
  const employmentBlurb = (() => {
    if (employee.termination_date) {
      const days = differenceInDays(new Date(), new Date(employee.termination_date));
      return `Terminated ${format(new Date(employee.termination_date), "MMM d, yyyy")} (${days}d ago)`;
    }
    if (!employee.is_active) return "Inactive — no active employment spell";
    if (employee.hire_date) {
      return `Active since ${format(new Date(employee.hire_date), "MMM d, yyyy")}`;
    }
    return "Active";
  })();

  return (
    <div className="space-y-4">
      {/* Row 1 — Status, Payroll readiness, Portal access ------------------- */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {/* Employment status */}
        <StatusCard
          tone={employee.is_active ? "ok" : "warn"}
          icon={employee.is_active ? CheckCircle2 : AlertTriangle}
          title="Employment"
          headline={
            <Badge variant={employee.is_active ? "default" : "secondary"} className="capitalize">
              {employee.is_active ? "Active" : "Inactive"}
            </Badge>
          }
          lines={[
            employmentBlurb,
            `${employee.employment_type?.replace(/_/g, " ") || "—"}${tenure ? ` · ${tenure}` : ""}`,
          ]}
          ctaLabel="Open work information"
          onCta={() => onNavigateSection("work")}
        />

        {/* Portal access */}
        <StatusCard
          tone={portalLinked ? "ok" : "warn"}
          icon={portalLinked ? CheckCircle2 : AlertTriangle}
          title="Portal access"
          headline={
            portalLinked
              ? <Badge variant="default">Linked</Badge>
              : <Badge variant="secondary">Not linked</Badge>
          }
          lines={[
            portalLinked
              ? "Employee can sign in to their self-service portal."
              : "Employee has no user account — they cannot view payslips or request time off.",
            portalStatus ? `Status: ${portalStatus.replace(/_/g, " ")}` : null,
          ].filter(Boolean) as string[]}
          ctaLabel={portalLinked ? "Manage in HR Settings" : "Link or invite user"}
          onCta={() => onNavigateSection("hr_settings")}
        />
      </div>

      {/* Row 2 — Time off, Attendance, Open items ------------------------- */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {/* Time off */}
        <SnapshotCard
          icon={Calendar}
          title="Time off"
          subtitle="Top balances"
          ctaLabel="Open time off"
          onCta={() => onNavigateSection("leave")}
        >
          {leaveLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : topLeave.length === 0 ? (
            <p className="text-xs text-muted-foreground">No allocations this year.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {topLeave.map((b) => (
                <li key={b.leave_type_id} className="flex items-center justify-between">
                  <span className="truncate text-muted-foreground">{b.leave_type_name}</span>
                  <span className="font-medium tabular-nums">
                    {(b.available ?? 0).toFixed(1)} <span className="text-xs text-muted-foreground">d</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SnapshotCard>

        {/* Attendance */}
        <SnapshotCard
          icon={Clock}
          title="Attendance"
          subtitle="Last 30 days"
          ctaLabel="Open attendance"
          onCta={() => onNavigateSection("attendance")}
        >
          {attLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          ) : totalAtt === 0 ? (
            <p className="text-xs text-muted-foreground">No attendance recorded yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-sm">
              <Metric label="Present" value={`${attPct ?? 0}%`} accent="text-emerald-600" />
              <Metric label="Late" value={String(att.lateDays)} accent="text-amber-600" />
              <Metric label="Absent" value={String(att.absentDays)} accent="text-rose-600" />
            </div>
          )}
        </SnapshotCard>

        {/* Open items */}
        <SnapshotCard
          icon={ClipboardList}
          title="Open items"
          subtitle="What needs attention"
          ctaLabel={null}
        >
          <ul className="space-y-1.5 text-sm">
            <OpenItem icon={ClipboardList} label="Onboarding" onClick={() => onNavigateSection("onboarding")} />
            <OpenItem icon={FileText} label="Documents" onClick={() => onNavigateSection("documents")} />
            <OpenItem icon={Timer} label="Timesheets" onClick={() => onNavigateSection("timesheets")} />
            {employee.termination_date || !employee.is_active ? (
              <OpenItem icon={LogOut} label="Exit clearance" onClick={() => onNavigateSection("exit")} />
            ) : null}
          </ul>
        </SnapshotCard>
      </div>

      {/* Row 3 — Contact + Reporting (reference info, below the fold) ----- */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row icon={Mail} value={employee.work_email || employee.email} />
            <Row icon={Phone} value={employee.phone || employee.personal_phone} />
            <Row icon={MapPin} value={[employee.city, employee.country].filter(Boolean).join(", ") || null} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Reporting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row
              icon={User}
              label="Manager"
              value={employee.manager ? `${employee.manager.first_name} ${employee.manager.last_name}` : null}
              linkTo={employee.manager ? `/hr/employees/${employee.manager.id}` : undefined}
            />
            <Row icon={Briefcase} label="Department" value={employee.department_name} />
            <Row icon={Calendar} label="Tenure" value={tenure} />
          </CardContent>
        </Card>
      </div>

      {/* Inline attendance trend (kept — useful spark chart). */}
      <EmployeeTrendDrawer
        mode="inline"
        employeeId={employee.id}
        employeeName={`${employee.first_name} ${employee.last_name}`}
      />
    </div>
  );
}

function Row({
  icon: Icon, label, value, linkTo,
}: {
  icon: any; label?: string; value: string | null | undefined; linkTo?: string;
}) {
  if (!value) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4 shrink-0" />
        <span>{label ? `${label}: —` : "—"}</span>
      </div>
    );
  }
  const inner = (
    <span className="truncate">{label ? <><span className="text-muted-foreground">{label}: </span>{value}</> : value}</span>
  );
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      {linkTo ? <Link to={linkTo} className="hover:underline">{inner}</Link> : inner}
    </div>
  );
}

function StatusCard({
  tone, icon: Icon, iconSpin, title, headline, lines, ctaLabel, onCta,
}: {
  tone: "ok" | "warn" | "block" | "muted";
  icon: any;
  iconSpin?: boolean;
  title: string;
  headline: React.ReactNode;
  lines: string[];
  ctaLabel: string;
  onCta: () => void;
}) {
  const ring =
    tone === "ok" ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "warn" ? "border-amber-500/30 bg-amber-500/5"
      : tone === "block" ? "border-rose-500/30 bg-rose-500/5"
      : "";
  const iconTint =
    tone === "ok" ? "text-emerald-600"
      : tone === "warn" ? "text-amber-600"
      : tone === "block" ? "text-rose-600"
      : "text-muted-foreground";
  return (
    <Card className={ring}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Icon className={`h-4 w-4 ${iconTint} ${iconSpin ? "animate-spin" : ""}`} />
            {title}
          </CardTitle>
          {headline}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {lines.map((l, i) => <li key={i} className="truncate">{l}</li>)}
        </ul>
        <button
          type="button"
          onClick={onCta}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          {ctaLabel} <ArrowRight className="h-3 w-3" />
        </button>
      </CardContent>
    </Card>
  );
}

function SnapshotCard({
  icon: Icon, title, subtitle, ctaLabel, onCta, children,
}: {
  icon: any;
  title: string;
  subtitle: string;
  ctaLabel: string | null;
  onCta?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Icon className="h-4 w-4" /> {title}
          </CardTitle>
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {children}
        {ctaLabel && onCta ? (
          <button
            type="button"
            onClick={onCta}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {ctaLabel} <ArrowRight className="h-3 w-3" />
          </button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className={`font-semibold tabular-nums ${accent ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function OpenItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-2"><Icon className="h-3.5 w-3.5" /> {label}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
