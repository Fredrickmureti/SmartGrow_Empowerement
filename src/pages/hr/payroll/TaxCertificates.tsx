import { normalizeError } from "@/services/resilience";
/**
 * Tax Certificates page (R6) — enterprise compliance workspace.
 *
 * Layout is a stable two-column skeleton: the primary "Issue certificates"
 * card and the "Generated certificates" table live in the main column; a
 * right rail carries year readiness, coverage, and employer reconciliation.
 * Selecting a template swaps content INSIDE the rail — it never injects a
 * new section above the primary action, so the Generate button and employee
 * table do not move.
 *
 * Localization pack health collapses to a header chip when healthy and
 * expands into a full alert card only when action is required
 * (missing pack or pending upgrades).
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Loader2,
  Download,
  FileText,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Package,
  ShieldAlert,
  Scale,
} from "lucide-react";
import { useEmployees } from "@/hooks/useEmployees";
import {
  useCertificateTemplates,
  useTaxCertificates,
  useGenerateTaxCertificate,
  downloadTaxCertificate,
  useFiscalYearsForCertificates,
  useLocalizationHealth,
  useYearReadiness,
  useCertificateReconciliation,
  useCertificateSubmissions,
} from "@/hooks/payroll/useTaxCertificates";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CURRENT_YEAR = new Date().getFullYear();

function StatTile({
  label,
  value,
  tone = "muted",
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "good" | "warn" | "bad";
  hint?: string;
  icon?: React.ReactNode;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
      {hint ? <div className="text-xs text-muted-foreground mt-1">{hint}</div> : null}
    </div>
  );
}

/** Compact metric row used inside the compliance rail. */
function RailMetric({
  label,
  value,
  tone = "muted",
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "muted" | "good" | "warn" | "bad";
  hint?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        {hint ? <div className="text-[11px] text-muted-foreground/80 truncate">{hint}</div> : null}
      </div>
      <div className={cn("text-sm font-semibold shrink-0 tabular-nums", toneClass)}>{value}</div>
    </div>
  );
}

export default function TaxCertificates() {
  // Deep-link support from the Reporting Centre pack-artifact hand-off:
  // /hr/payroll/tax-certificates?template=P9&from=2025-01-01
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkTemplate = searchParams.get("template") ?? "";
  const deepLinkFrom = searchParams.get("from");
  const deepLinkYear = deepLinkFrom
    ? Number(deepLinkFrom.slice(0, 4)) || null
    : null;

  const [templateCode, setTemplateCode] = useState<string>(deepLinkTemplate);
  const [fiscalYear, setFiscalYear] = useState<number>(
    deepLinkYear ?? CURRENT_YEAR - 1,
  );
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [regenerate, setRegenerate] = useState(false);

  // Persist template + fiscal year in URL search params so a page refresh
  // (or deep-link share) preserves the operator's selection.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (templateCode) next.set("template", templateCode);
    else next.delete("template");
    next.set("from", `${fiscalYear}-01-01`);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [templateCode, fiscalYear, searchParams, setSearchParams]);

  const templatesQ = useCertificateTemplates();
  const employeesQ = useEmployees();
  const certsQ = useTaxCertificates({ fiscalYear, templateCode: templateCode || undefined });
  const generate = useGenerateTaxCertificate();
  const fiscalYearsQ = useFiscalYearsForCertificates();
  const healthQ = useLocalizationHealth();
  const readinessQ = useYearReadiness(fiscalYear);
  const reconQ = useCertificateReconciliation(fiscalYear, templateCode || null);
  const yearOptions = (fiscalYearsQ.data && fiscalYearsQ.data.length > 0)
    ? fiscalYearsQ.data
    : [CURRENT_YEAR, CURRENT_YEAR - 1];

  const templates = templatesQ.data ?? [];
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.code === templateCode) ?? null,
    [templates, templateCode],
  );
  const employees = (employeesQ.activeEmployees ?? []) as any[];
  const certs = certsQ.data ?? [];
  const certIds = useMemo(() => certs.map((c) => c.id), [certs]);
  const submissionsQ = useCertificateSubmissions(certIds);
  const submissionByCert = useMemo(() => {
    const m = new Map<string, ReturnType<typeof Object> | any>();
    for (const s of submissionsQ.data ?? []) {
      const prev = m.get(s.certificate_id);
      if (!prev || new Date(s.submitted_at) > new Date(prev.submitted_at)) {
        m.set(s.certificate_id, s);
      }
    }
    return m;
  }, [submissionsQ.data]);

  const empById = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of employees) m.set(e.id, e);
    return m;
  }, [employees]);

  const coverage = useMemo(() => {
    const issued = certs.filter((c) => c.status === "issued").length;
    const superseded = certs.filter((c) => c.status === "superseded").length;
    const stale = certs.filter((c) => c.stale).length;
    const eligible = employees.length;
    const issuedEmployeeIds = new Set(
      certs.filter((c) => c.status === "issued").map((c) => c.employee_id),
    );
    const missing = Math.max(0, eligible - issuedEmployeeIds.size);
    return { issued, superseded, stale, eligible, missing };
  }, [certs, employees.length]);

  const readiness = readinessQ.data;
  const health = healthQ.data;
  const recon = reconQ.data;
  const blockedReasons: string[] = [];
  if (readiness) {
    if (readiness.committedRuns === 0) blockedReasons.push("No committed payroll runs in this year");
    if (readiness.blockingFindings > 0)
      blockedReasons.push(`${readiness.blockingFindings} blocking readiness finding(s)`);
  }
  if (!health?.pack_id) blockedReasons.push("No active localization pack");

  const packUpgradePending =
    !!health?.installed_version &&
    !!health?.latest_version &&
    health.installed_version !== health.latest_version;
  const packHealthy = !!health?.pack_id && !packUpgradePending && (health?.pending_upgrades ?? 0) === 0;
  const packNeedsAttention = !health?.pack_id || (health?.pending_upgrades ?? 0) > 0;

  const toggleEmployee = (id: string) =>
    setSelectedEmployees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelectedEmployees((prev) =>
      prev.size === employees.length ? new Set() : new Set(employees.map((e: any) => e.id)),
    );

  const onGenerate = async () => {
    if (!templateCode) return toast.error("Select a certificate template");
    if (!selectedEmployees.size) return toast.error("Select at least one employee");
    await runGenerate(Array.from(selectedEmployees));
  };

  const onGenerateYearEnd = async () => {
    if (!templateCode) return toast.error("Select a certificate template");
    if (!employees.length) return toast.error("No active employees");
    await runGenerate(employees.map((e: any) => e.id), { yearEnd: true });
  };

  const runGenerate = async (employee_ids: string[], opts?: { yearEnd?: boolean }) => {
    try {
      const res = await generate.mutateAsync({
        template_code: templateCode,
        fiscal_year: fiscalYear,
        employee_ids,
        regenerate: opts?.yearEnd ? true : regenerate,
      });
      const okCount = res.created?.length ?? 0;
      const skippedCount = res.skipped?.length ?? 0;
      const errCount = res.errors?.length ?? 0;
      if (okCount) toast.success(`${opts?.yearEnd ? "Year-end batch: " : ""}generated ${okCount} certificate(s)`);
      if (skippedCount) toast.info(`${skippedCount} certificate(s) already existed`);
      if (errCount) toast.error(`${errCount} certificate(s) failed — see logs`);
      if (!okCount && !skippedCount && !errCount) toast.info("No certificates created");
    } catch (e: any) {
      // Surface the structured business-error envelope from
      // generate-tax-certificate (code / message / recovery) before
      // falling back to the generic normalizer — otherwise a 422
      // LIFECYCLE_REFUSED or TEMPLATE_STRUCTURAL_INVALID collapses into
      // a useless "An unexpected error occurred" toast.
      const payload = e?.payload ?? e?.body;
      const serverMsg =
        payload?.message ?? payload?.error ?? e?.message;
      const recovery = payload?.recovery ?? payload?.hint;
      const title =
        typeof serverMsg === "string" && serverMsg.length > 0
          ? serverMsg
          : normalizeError(e).message ?? "Generation failed";
      toast.error(title, recovery ? { description: String(recovery) } : undefined);
    }
  };

  const packChipTone = packNeedsAttention
    ? "border-destructive/40 bg-destructive/5 text-destructive"
    : packUpgradePending
      ? "border-amber-500/40 bg-amber-500/5 text-amber-700"
      : "border-emerald-500/40 bg-emerald-500/5 text-emerald-700";

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header — title + FY selector + collapsed localization status chip */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">Tax Certificates</h1>
          <p className="text-muted-foreground">
            Issue and reconcile statutory year-end certificates for your workforce.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={String(fiscalYear)} onValueChange={(v) => setFiscalYear(Number(v))}>
            <SelectTrigger className="h-9 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  FY {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium",
                  packChipTone,
                )}
                title="Localization pack health"
              >
                <Package className="h-3.5 w-3.5" />
                <span className="max-w-[160px] truncate">
                  {health?.pack_name ?? (healthQ.isLoading ? "Loading…" : "No pack")}
                </span>
                {packHealthy ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <div className="grid grid-cols-2 gap-2">
                <StatTile
                  label="Active pack"
                  value={health?.pack_name ?? (healthQ.isLoading ? "…" : "None")}
                  tone={health?.pack_id ? "good" : "bad"}
                  hint={health?.pack_country ?? undefined}
                />
                <StatTile
                  label="Installed"
                  value={health?.installed_version ?? "—"}
                  tone={packUpgradePending ? "warn" : "muted"}
                  hint={
                    packUpgradePending
                      ? `latest: ${health?.latest_version}`
                      : undefined
                  }
                />
                <StatTile
                  label="Pending upgrades"
                  value={health?.pending_upgrades ?? 0}
                  tone={(health?.pending_upgrades ?? 0) > 0 ? "warn" : "good"}
                />
                <StatTile
                  label="Templates"
                  value={templates.length}
                  tone={templates.length > 0 ? "good" : "bad"}
                  hint={`${templates.filter((t) => t.pack_id).length} pack · ${templates.filter((t) => !t.pack_id).length} generic`}
                />
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Full-width attention banner ONLY when the pack needs action. */}
      {packNeedsAttention ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
              <div className="text-sm">
                <div className="font-medium text-destructive">
                  {!health?.pack_id
                    ? "No active localization pack"
                    : `${health.pending_upgrades} pack upgrade(s) pending`}
                </div>
                <div className="text-muted-foreground">
                  Certificate templates and statutory rules come from the active pack. Resolve this before issuing.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Two-column workspace: primary column + compliance rail. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* MAIN COLUMN */}
        <div className="min-w-0 space-y-6">
          {/* Issue certificates — primary action card */}
          <Card>
            <CardHeader className="lg:sticky lg:top-0 lg:z-10 lg:rounded-t-lg lg:bg-card/95 lg:backdrop-blur">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Issue certificates
                  </CardTitle>
                  <CardDescription className="truncate">
                    {selectedTemplate
                      ? `${selectedTemplate.display_name}${selectedTemplate.pack_id ? "" : " (generic)"} · FY ${fiscalYear}`
                      : `Pick a template to begin · FY ${fiscalYear}`}
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    variant="outline"
                    onClick={onGenerateYearEnd}
                    disabled={generate.isPending || blockedReasons.length > 0 || !templateCode}
                    title="Bulk regenerate for every active employee in this fiscal year"
                    className="w-full sm:w-auto"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" /> Year-end batch
                  </Button>
                  <Button
                    onClick={onGenerate}
                    disabled={generate.isPending || blockedReasons.length > 0 || !templateCode || selectedEmployees.size === 0}
                    className="w-full sm:w-auto"
                  >
                    {generate.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <FileText className="h-4 w-4 mr-2" />
                    )}
                    Generate ({selectedEmployees.size})
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <label className="text-xs font-medium text-muted-foreground">Template</label>
                  <Select value={templateCode} onValueChange={setTemplateCode}>
                    <SelectTrigger>
                      <SelectValue placeholder={templatesQ.isLoading ? "Loading…" : "Select template"} />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.code}>
                          {t.display_name} {t.pack_id ? "" : "(generic)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-end gap-2 text-sm whitespace-nowrap pb-2">
                  <Checkbox checked={regenerate} onCheckedChange={(v) => setRegenerate(!!v)} />
                  Regenerate (supersede)
                </label>
              </div>

              {blockedReasons.length > 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium text-destructive">Issuance blocked</div>
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {blockedReasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}

              <div className="rounded border">
                <div className="flex items-center justify-between gap-3 border-b p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox
                      checked={!!employees.length && selectedEmployees.size === employees.length}
                      onCheckedChange={toggleAll}
                    />
                    {selectedEmployees.size}/{employees.length} employees selected
                  </label>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  <Table>
                    <TableBody>
                      {employees.map((e: any) => (
                        <TableRow key={e.id}>
                          <TableCell className="w-10">
                            <Checkbox
                              checked={selectedEmployees.has(e.id)}
                              onCheckedChange={() => toggleEmployee(e.id)}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {e.first_name} {e.last_name}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {e.employee_number ?? "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {e.department ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                      {!employees.length && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                            {employeesQ.isLoading ? "Loading…" : "No active employees"}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Generated certificates */}
          <Card>
            <CardHeader>
              <CardTitle>Issued certificates</CardTitle>
              <CardDescription>
                Fiscal year {fiscalYear}
                {templateCode ? ` • ${templateCode}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Year</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Serial</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {certs.map((c) => {
                    const emp = empById.get(c.employee_id);
                    const sub = submissionByCert.get(c.id);
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          {emp ? `${emp.first_name} ${emp.last_name}` : c.employee_id.slice(0, 8)}
                        </TableCell>
                        <TableCell>{c.template_code}</TableCell>
                        <TableCell>{c.fiscal_year}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {c.batch_id ? c.batch_id.slice(0, 8) : "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.serial_number}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              c.status === "issued"
                                ? "default"
                                : c.status === "superseded"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {c.status}
                          </Badge>
                          {c.stale ? (
                            <Badge variant="destructive" className="ml-2" title={c.stale_reason ?? "Underlying payroll changed since issuance"}>
                              stale
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {sub ? (
                            <div className="flex flex-col">
                              <Badge
                                variant={
                                  sub.status === "accepted"
                                    ? "default"
                                    : sub.status === "rejected"
                                      ? "destructive"
                                      : "secondary"
                                }
                              >
                                {sub.status}
                              </Badge>
                              {sub.authority_reference ? (
                                <span className="text-xs text-muted-foreground font-mono mt-1">
                                  {sub.authority_reference}
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(c.generated_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {(() => {
                            const arts = Array.isArray((c as any).artifacts) && (c as any).artifacts.length
                              ? ((c as any).artifacts as Array<any>)
                              : ([
                                  c.pdf_path
                                    ? { format: "pdf", path: c.pdf_path, role: "human_readable" }
                                    : null,
                                  (c as any).xlsx_path
                                    ? { format: "xlsx", path: (c as any).xlsx_path, role: "human_readable" }
                                    : null,
                                ].filter(Boolean) as Array<any>);
                            if (!arts.length) {
                              return <span className="text-xs text-muted-foreground">No downloads</span>;
                            }
                            return arts.map((a, i) => {
                              const label = a.label ?? (
                                a.format === "pdf" ? "PDF" :
                                a.format === "html" ? "PDF" :
                                a.format === "xlsx" ? "Excel" :
                                a.format === "gov_xlsx" ? "Gov Excel" :
                                a.format === "gov_xml" ? "Gov XML" :
                                a.format === "gov_csv" ? "Gov CSV" :
                                a.format === "csv" ? "CSV" :
                                String(a.format).toUpperCase()
                              );
                              return (
                                <Button
                                  key={`${a.path ?? a.format}-${i}`}
                                  variant="ghost"
                                  size="sm"
                                  disabled={!!c.stale}
                                  title={c.stale ? "Regenerate this certificate before downloading the current file" : undefined}
                                  onClick={() =>
                                    a.format === "html"
                                      ? downloadTaxCertificate({ artifact_path: a.path, format: "html" })
                                      : a.path && a.format !== "pdf" && a.format !== "xlsx"
                                      ? downloadTaxCertificate({ artifact_path: a.path })
                                      : a.format === "xlsx"
                                      ? downloadTaxCertificate(c, "xlsx")
                                      : downloadTaxCertificate(c)
                                  }
                                >
                                  <Download className="h-4 w-4 mr-1" />
                                  {label}
                                </Button>
                              );
                            });
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!certs.length && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                        {certsQ.isLoading ? (
                          <span className="inline-flex items-center gap-2">
                            <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                          </span>
                        ) : (
                          "No certificates yet for this filter"
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        {/* COMPLIANCE RAIL — always mounted; content swaps in place. */}
        <aside aria-label="Compliance context" className="space-y-4">
          {/* Year readiness */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4" /> Year readiness
              </CardTitle>
              <CardDescription>FY {fiscalYear}</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="divide-y">
                <RailMetric
                  label="Periods closed"
                  value={`${readiness?.closedPeriods ?? 0}/${readiness?.totalPeriods ?? 0}`}
                  tone={
                    readiness && readiness.totalPeriods > 0 && readiness.closedPeriods === readiness.totalPeriods
                      ? "good"
                      : "warn"
                  }
                />
                <RailMetric
                  label="Committed runs"
                  value={readiness?.committedRuns ?? 0}
                  tone={(readiness?.committedRuns ?? 0) > 0 ? "good" : "bad"}
                />
                <RailMetric
                  label="Draft runs"
                  value={readiness?.draftRuns ?? 0}
                  tone={(readiness?.draftRuns ?? 0) > 0 ? "warn" : "good"}
                />
                <RailMetric
                  label="Blocking findings"
                  value={readiness?.blockingFindings ?? 0}
                  tone={(readiness?.blockingFindings ?? 0) > 0 ? "bad" : "good"}
                />
                <RailMetric
                  label="Stale certificates"
                  value={readiness?.staleCerts ?? 0}
                  tone={(readiness?.staleCerts ?? 0) > 0 ? "bad" : "good"}
                  hint="Payroll changed after issuance"
                />
              </div>
              <div className="mt-3">
                {blockedReasons.length > 0 ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
                    <span className="text-destructive font-medium">Issuance blocked</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Ready to issue
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Coverage — always mounted; empty state when no template. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Coverage</CardTitle>
              <CardDescription className="truncate">
                {selectedTemplate?.display_name ?? "Select a template"}
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {templateCode ? (
                <div className="divide-y">
                  <RailMetric label="Eligible" value={coverage.eligible} />
                  <RailMetric label="Issued" value={coverage.issued} tone="good" />
                  <RailMetric
                    label="Missing"
                    value={coverage.missing}
                    tone={coverage.missing > 0 ? "warn" : "good"}
                  />
                  <RailMetric label="Superseded" value={coverage.superseded} />
                  <RailMetric
                    label="Stale"
                    value={coverage.stale}
                    tone={coverage.stale > 0 ? "bad" : "good"}
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Coverage per employee will appear here once a template is selected.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Employer reconciliation */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Scale className="h-4 w-4" /> Reconciliation
              </CardTitle>
              <CardDescription>Cert ↔ returns ↔ remittance</CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {!templateCode ? (
                <p className="text-xs text-muted-foreground">
                  Employer totals reconcile against the filed returns for the selected template.
                </p>
              ) : reconQ.isLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : recon ? (
                <div className="divide-y">
                  <RailMetric
                    label="Certificates"
                    value={recon.cert_total_employee_tax.toLocaleString()}
                    hint={`${recon.cert_count} issued`}
                  />
                  <RailMetric
                    label="Returns"
                    value={recon.return_total.toLocaleString()}
                    hint={`${recon.return_count} filed`}
                  />
                  <RailMetric
                    label="Remittances"
                    value={recon.remittance_total.toLocaleString()}
                  />
                  <RailMetric
                    label="Variance"
                    value={Math.abs(recon.variance_cert_vs_return).toLocaleString()}
                    tone={Math.abs(recon.variance_cert_vs_return) > 0.01 ? "bad" : "good"}
                    hint={
                      Math.abs(recon.variance_cert_vs_return) > 0.01
                        ? "Certificates ≠ returns"
                        : "Aligned"
                    }
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No data for this filter.</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
