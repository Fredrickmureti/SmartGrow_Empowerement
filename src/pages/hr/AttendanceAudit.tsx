/**
 * AttendanceAudit — HR forensic view.
 *
 * Three stacked panels:
 *  1. Live presence (realtime "Who's clocked in right now").
 *  2. Recent attendance events (append-only audit log of every clock attempt,
 *     including denials with canonical error codes). Server-side filtered
 *     via `attendance_events_search` RPC (employee + branch + date + reason),
 *     paginated, with chip toggles and CSV export of the current result set.
 *  3. Device trust roster — pending devices HR can approve / revoke.
 */
import { useMemo, useState } from "react";
import { downloadCsv } from "@/lib/exports/csv";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ShieldCheck, ShieldOff, Download, X } from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
// Live presence intentionally not imported here — it lives on the Today page
// (KPI tile popover) as the single source of truth. Audit is the events
// + device trust surface only.
import {
  EmployeeDayDrawerByLookup,
  type LookupTarget,
} from "@/components/attendance/EmployeeDayDrawerByLookup";
import { cn } from "@/lib/utils";

type Decision = "allow" | "deny" | "flag";

const FRAUD_CODES = [
  "OUTSIDE_GEOFENCE",
  "GEO_REQUIRED",
  "NO_GEOFENCE_DEFINED",
  "SELFIE_REQUIRED",
  "UNTRUSTED_DEVICE",
  "DEVICE_REVOKED",
  "IMPOSSIBLE_TRAVEL",
  "DUPLICATE_RECENT_ATTEMPT",
  "OUTSIDE_SHIFT_WINDOW",
  "ON_APPROVED_LEAVE",
  "ALREADY_CLOCKED_IN",
  "KIOSK_PIN_INVALID",
];

/** "Violations" preset = compliance-relevant denials only. */
const VIOLATION_CODES = new Set([
  "OUTSIDE_GEOFENCE",
  "GEO_REQUIRED",
  "UNTRUSTED_DEVICE",
  "DEVICE_REVOKED",
  "IMPOSSIBLE_TRAVEL",
  "DUPLICATE_RECENT_ATTEMPT",
]);

const PAGE_LIMIT = 200;

export default function AttendanceAudit() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranches();
  const { activeEmployees } = useEmployees();
  const qc = useQueryClient();

  const [decisionFilter, setDecisionFilter] = useState<Decision | null>(null);
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [violationsOnly, setViolationsOnly] = useState<boolean>(false);
  const [drawerTarget, setDrawerTarget] = useState<LookupTarget | null>(null);

  const eventsKey = [
    "attendance-events",
    currentOrg?.id,
    currentBusiness?.id,
    branchFilter,
    employeeFilter,
    fromDate,
    toDate,
    decisionFilter,
    reasonFilter,
  ] as const;

  const events = useQuery({
    queryKey: eventsKey,
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const fromTs = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : null;
      const toTs = toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : null;
      const { data, error } = await supabase.rpc("attendance_events_search" as any, {
        _organization_id: currentOrg.id,
        _business_id: currentBusiness?.id ?? null,
        _branch_id: branchFilter === "all" ? null : branchFilter,
        _from: fromTs,
        _to: toTs,
        _employee_id: employeeFilter === "all" ? null : employeeFilter,
        _decisions: decisionFilter ? [decisionFilter] : null,
        _reasons: reasonFilter ? [reasonFilter] : null,
        _event_types: null,
        _limit: PAGE_LIMIT,
        _before: null,
      });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const devices = useQuery({
    queryKey: ["attendance-device-trust", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("attendance_device_trust" as any)
        .select(
          "id, employee_id, device_fingerprint, label, user_agent, first_seen_at, last_seen_at, trusted_at, revoked_at, employee:employees(first_name,last_name,employee_number)",
        )
        .eq("organization_id", currentOrg.id)
        .order("first_seen_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!currentOrg?.id,
  });

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("attendance_device_trust_approve" as any, { _device_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Device approved");
      qc.invalidateQueries({ queryKey: ["attendance-device-trust"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Approval failed"),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("attendance_device_trust_revoke" as any, { _device_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Device revoked");
      qc.invalidateQueries({ queryKey: ["attendance-device-trust"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Revoke failed"),
  });

  const rows = events.data ?? [];
  const deniedCount = useMemo(() => rows.filter((e) => e.decision === "deny").length, [rows]);
  const violationRows = useMemo(
    () => (violationsOnly ? rows.filter((e: any) => e.reason && VIOLATION_CODES.has(e.reason)) : rows),
    [rows, violationsOnly],
  );

  const reasonCounts = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((e: any) => {
      if (e.reason) map.set(e.reason, (map.get(e.reason) ?? 0) + 1);
    });
    return map;
  }, [rows]);

  const hasActiveFilter =
    !!decisionFilter ||
    !!reasonFilter ||
    branchFilter !== "all" ||
    employeeFilter !== "all" ||
    !!fromDate ||
    !!toDate ||
    violationsOnly;

  const clearFilters = () => {
    setDecisionFilter(null);
    setReasonFilter(null);
    setBranchFilter("all");
    setEmployeeFilter("all");
    setFromDate("");
    setToDate("");
    setViolationsOnly(false);
  };

  const downloadCSV = () => {
    const headers = [
      "created_at",
      "event_type",
      "source",
      "decision",
      "reason",
      "employee",
      "employee_id",
      "lat",
      "lng",
      "accuracy_m",
      "device_fingerprint",
    ];
    const escape = (v: any) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    rows.forEach((e: any) => {
      const empLabel = e.employee_first_name
        ? `${e.employee_first_name} ${e.employee_last_name}${e.employee_number ? ` (${e.employee_number})` : ""}`
        : "";
      lines.push(
        [
          escape(e.created_at),
          escape(e.event_type),
          escape(e.source),
          escape(e.decision),
          escape(e.reason),
          escape(empLabel),
          escape(e.employee_id),
          escape(e.lat),
          escape(e.lng),
          escape(e.accuracy_m),
          escape(e.device_fingerprint),
        ].join(","),
      );
    });
    downloadCsv(
      `attendance-events-${format(new Date(), "yyyy-MM-dd")}.csv`,
      lines.join("\r\n"),
    );
  };

  const employeeOptions = activeEmployees ?? [];

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance Audit</h1>
          <p className="text-sm text-muted-foreground">
            Every clock attempt is logged here, including denials. Append-only.
          </p>
        </div>
        <div className="action-buttons">
          <Badge variant="outline">{rows.length} events {rows.length === PAGE_LIMIT && "(page limit)"}</Badge>
          <Badge variant={deniedCount ? "destructive" : "secondary"}>{deniedCount} denied</Badge>
          <Button size="sm" variant="outline" onClick={downloadCSV} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Looking for who's clocked in right now?{" "}
        <a href="/hr/attendance" className="underline hover:text-foreground">
          See live presence on Today
        </a>
        .
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Device trust</CardTitle>
        </CardHeader>
        <CardContent>
          {devices.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (devices.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No devices recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Fingerprint</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(devices.data ?? []).map((d) => {
                  const emp = d.employee;
                  const status = d.revoked_at
                    ? { label: "Revoked", variant: "destructive" as const }
                    : d.trusted_at
                    ? { label: "Trusted", variant: "secondary" as const }
                    : { label: "Pending", variant: "outline" as const };
                  return (
                    <TableRow key={d.id}>
                      <TableCell>
                        {emp ? `${emp.first_name} ${emp.last_name} (${emp.employee_number ?? "-"})` : d.employee_id.slice(0, 8)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{d.device_fingerprint.slice(0, 16)}…</TableCell>
                      <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(d.first_seen_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(d.last_seen_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-right">
                        {!d.trusted_at && !d.revoked_at && (
                          <Button size="sm" variant="default" disabled={approve.isPending} onClick={() => approve.mutate(d.id)}>
                            <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Approve
                          </Button>
                        )}
                        {d.trusted_at && !d.revoked_at && (
                          <Button size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(d.id)}>
                            <ShieldOff className="h-3.5 w-3.5 mr-1" /> Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent events ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Server-side filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Employee</Label>
              <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
                <SelectTrigger><SelectValue placeholder="All employees" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All employees</SelectItem>
                  {employeeOptions.map((e: any) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.first_name} {e.last_name}
                      {e.employee_number ? ` (${e.employee_number})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Branch</Label>
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger><SelectValue placeholder="All branches" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {(branches ?? []).map((b: any) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">From</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground mr-1">Decision:</span>
            <Chip
              active={violationsOnly}
              onClick={() => setViolationsOnly((v) => !v)}
              variant="destructive"
            >
              Violations only
            </Chip>
            <div className="w-px h-5 bg-border mx-1" />
            {(["allow", "flag", "deny"] as Decision[]).map((d) => (
              <Chip
                key={d}
                active={decisionFilter === d}
                onClick={() => setDecisionFilter(decisionFilter === d ? null : d)}
                variant={d === "deny" ? "destructive" : d === "flag" ? "outline" : "secondary"}
              >
                {d}
              </Chip>
            ))}
            <div className="w-px h-5 bg-border mx-1" />
            <span className="text-xs text-muted-foreground mr-1">Fraud code:</span>
            {FRAUD_CODES.filter((c) => reasonCounts.has(c)).map((code) => (
              <Chip
                key={code}
                active={reasonFilter === code}
                onClick={() => setReasonFilter(reasonFilter === code ? null : code)}
                variant="outline"
              >
                {code} <span className="ml-1 opacity-60">({reasonCounts.get(code)})</span>
              </Chip>
            ))}
            {hasActiveFilter && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                <X className="h-3 w-3 mr-1" /> Clear all
              </Button>
            )}
          </div>

          {events.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : events.isError ? (
            <p className="text-sm text-destructive">
              Failed to load events: {(events.error as any)?.message ?? "unknown error"}
            </p>
          ) : violationRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events match the current filters.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Device</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {violationRows.map((e: any) => {
                  const empName = e.employee_first_name
                    ? `${e.employee_first_name} ${e.employee_last_name}`
                    : null;
                  const dateStr = e.created_at
                    ? format(new Date(e.created_at), "yyyy-MM-dd")
                    : null;
                  const canOpenDrawer = !!(empName && dateStr && e.employee_id);
                  return (
                    <TableRow
                      key={e.id}
                      className={canOpenDrawer ? "cursor-pointer hover:bg-muted/50" : undefined}
                      onClick={
                        canOpenDrawer
                          ? () =>
                              setDrawerTarget({
                                employeeId: e.employee_id,
                                date: dateStr!,
                                employeeName: empName!,
                                employeeNumber: e.employee_number ?? null,
                                branchName: null,
                                focusEventId: e.id,
                              })
                          : undefined
                      }
                    >
                      <TableCell className="text-xs">
                        {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="text-xs">
                        {empName ? (
                          <span>
                            {empName}
                            {e.employee_number ? ` (${e.employee_number})` : ""}
                          </span>
                        ) : (
                          <span className="font-mono">{String(e.employee_id).slice(0, 8)}</span>
                        )}
                        {dateStr && (
                          <div className="text-[10px] text-muted-foreground">{dateStr}</div>
                        )}
                      </TableCell>
                      <TableCell>{e.event_type}</TableCell>
                      <TableCell>{e.source ?? "-"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            e.decision === "allow"
                              ? "secondary"
                              : e.decision === "flag"
                              ? "outline"
                              : "destructive"
                          }
                        >
                          {e.decision}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.reason ?? ""}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {e.lat != null && e.lng != null ? `${Number(e.lat).toFixed(4)}, ${Number(e.lng).toFixed(4)}` : "-"}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {e.device_fingerprint ? `${String(e.device_fingerprint).slice(0, 12)}…` : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <EmployeeDayDrawerByLookup
        target={drawerTarget}
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
      />
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  variant = "outline",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "outline" | "secondary" | "destructive";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? variant === "destructive"
            ? "bg-destructive text-destructive-foreground border-destructive"
            : variant === "secondary"
            ? "bg-secondary text-secondary-foreground border-secondary"
            : "bg-primary text-primary-foreground border-primary"
          : "bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}
