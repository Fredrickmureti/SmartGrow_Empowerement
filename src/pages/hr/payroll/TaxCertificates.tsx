import { normalizeError } from "@/services/resilience";
/**
 * Tax Certificates page (R6).
 *
 * Country-agnostic. Lets payroll managers pick a template (loaded from the
 * org's installed localization pack + generic fallbacks), a fiscal year, and
 * a set of employees, then bulk-generates certificates. Already-issued
 * certificates appear in the table with download links and serial numbers.
 *
 * Status badges: issued / superseded / draft. Re-generating an issued
 * certificate supersedes (audit trail preserved) and re-creates a fresh one.
 */
import { useMemo, useState } from "react";
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

export default function TaxCertificates() {
  const [templateCode, setTemplateCode] = useState<string>("");
  const [fiscalYear, setFiscalYear] = useState<number>(CURRENT_YEAR - 1);
  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [regenerate, setRegenerate] = useState(false);

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

  // Coverage summary for the active filter
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
      toast.error(normalizeError(e).message ?? "Generation failed");
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Tax Certificates</h1>
        <p className="text-muted-foreground">
          Status-first view of the statutory certificate lifecycle: localization
          health, fiscal-year readiness, coverage, and employer reconciliation.
        </p>
      </div>

      {/* 1. Localization health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-4 w-4" /> Localization health
          </CardTitle>
          <CardDescription>
            Source of truth for templates, statutory rules, and certificate forms.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <StatTile
              label="Active pack"
              value={health?.pack_name ?? (healthQ.isLoading ? "…" : "None")}
              tone={health?.pack_id ? "good" : "bad"}
              hint={health?.pack_country ?? undefined}
              icon={<Package className="h-3.5 w-3.5" />}
            />
            <StatTile
              label="Installed version"
              value={health?.installed_version ?? "—"}
              tone={
                health?.installed_version && health?.latest_version &&
                health.installed_version !== health.latest_version
                  ? "warn"
                  : "muted"
              }
              hint={
                health?.latest_version && health.latest_version !== health.installed_version
                  ? `latest: ${health.latest_version}`
                  : undefined
              }
            />
            <StatTile
              label="Pending upgrades"
              value={health?.pending_upgrades ?? 0}
              tone={(health?.pending_upgrades ?? 0) > 0 ? "warn" : "good"}
            />
            <StatTile
              label="Templates available"
              value={templates.length}
              tone={templates.length > 0 ? "good" : "bad"}
              hint={`${templates.filter((t) => t.pack_id).length} pack · ${templates.filter((t) => !t.pack_id).length} generic`}
            />
          </div>
        </CardContent>
      </Card>

      {/* 2. Year readiness */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" /> Year readiness — FY {fiscalYear}
          </CardTitle>
          <CardDescription>
            A certificate is only as correct as the payroll history behind it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-5">
            <StatTile
              label="Periods closed"
              value={`${readiness?.closedPeriods ?? 0}/${readiness?.totalPeriods ?? 0}`}
              tone={
                readiness && readiness.totalPeriods > 0 && readiness.closedPeriods === readiness.totalPeriods
                  ? "good"
                  : "warn"
              }
            />
            <StatTile
              label="Committed runs"
              value={readiness?.committedRuns ?? 0}
              tone={(readiness?.committedRuns ?? 0) > 0 ? "good" : "bad"}
            />
            <StatTile
              label="Draft runs"
              value={readiness?.draftRuns ?? 0}
              tone={(readiness?.draftRuns ?? 0) > 0 ? "warn" : "good"}
            />
            <StatTile
              label="Blocking findings"
              value={readiness?.blockingFindings ?? 0}
              tone={(readiness?.blockingFindings ?? 0) > 0 ? "bad" : "good"}
            />
            <StatTile
              label="Stale certificates"
              value={readiness?.staleCerts ?? 0}
              tone={(readiness?.staleCerts ?? 0) > 0 ? "bad" : "good"}
              hint="Payroll changed after issuance"
            />
          </div>
          {blockedReasons.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
              <div>
                <div className="font-medium text-destructive">Issuance blocked</div>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {blockedReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              Ready to issue certificates for FY {fiscalYear}.
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Coverage matrix (per current filter) */}
      {templateCode ? (
        <Card>
          <CardHeader>
            <CardTitle>Coverage — {selectedTemplate?.display_name ?? templateCode}</CardTitle>
            <CardDescription>FY {fiscalYear}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-5">
              <StatTile label="Eligible employees" value={coverage.eligible} />
              <StatTile label="Issued" value={coverage.issued} tone="good" />
              <StatTile label="Missing" value={coverage.missing} tone={coverage.missing > 0 ? "warn" : "good"} />
              <StatTile label="Superseded" value={coverage.superseded} tone="muted" />
              <StatTile label="Stale" value={coverage.stale} tone={coverage.stale > 0 ? "bad" : "good"} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 4. Employer reconciliation */}
      {templateCode ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4" /> Employer reconciliation
            </CardTitle>
            <CardDescription>
              Σ certificates ↔ Σ statutory returns ↔ Σ remittance payments
            </CardDescription>
          </CardHeader>
          <CardContent>
            {reconQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : recon ? (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                <StatTile
                  label="Certificates total"
                  value={recon.cert_total_employee_tax.toLocaleString()}
                  hint={`${recon.cert_count} issued`}
                />
                <StatTile
                  label="Returns total"
                  value={recon.return_total.toLocaleString()}
                  hint={`${recon.return_count} filed`}
                />
                <StatTile
                  label="Remittances total"
                  value={recon.remittance_total.toLocaleString()}
                />
                <StatTile
                  label="Variance"
                  value={Math.abs(recon.variance_cert_vs_return).toLocaleString()}
                  tone={Math.abs(recon.variance_cert_vs_return) > 0.01 ? "bad" : "good"}
                  hint={
                    Math.abs(recon.variance_cert_vs_return) > 0.01
                      ? "Certificates ≠ returns — investigate"
                      : "Aligned"
                  }
                />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No data for this filter.</div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Generate</CardTitle>
          <CardDescription>
            {selectedTemplate
              ? `${selectedTemplate.display_name}${selectedTemplate.pack_id ? "" : " (generic)"}`
              : "Pick a template, fiscal year, and employees"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="text-sm font-medium">Template</label>
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
            <div>
              <label className="text-sm font-medium">Fiscal year</label>
              <Select value={String(fiscalYear)} onValueChange={(v) => setFiscalYear(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={regenerate} onCheckedChange={(v) => setRegenerate(!!v)} />
                Regenerate (supersede existing)
              </label>
            </div>
          </div>

          {blockedReasons.length > 0 ? (
            <div className="text-xs text-destructive">
              Generation disabled until blockers are resolved (see Year readiness above).
            </div>
          ) : null}

          <div className="rounded border">
            <div className="flex items-center justify-between p-3 border-b">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={!!employees.length && selectedEmployees.size === employees.length}
                  onCheckedChange={toggleAll}
                />
                {selectedEmployees.size}/{employees.length} employees selected
              </label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={onGenerateYearEnd}
                  disabled={generate.isPending || blockedReasons.length > 0}
                  title="Bulk regenerate for every active employee in this fiscal year"
                >
                  <RefreshCw className="h-4 w-4 mr-2" /> Year-end batch
                </Button>
                <Button onClick={onGenerate} disabled={generate.isPending || blockedReasons.length > 0}>
                  {generate.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="h-4 w-4 mr-2" />
                  )}
                  Generate
                </Button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto">
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

      <Card>
        <CardHeader>
          <CardTitle>Issued certificates</CardTitle>
          <CardDescription>
            Fiscal year {fiscalYear}
            {templateCode ? ` • ${templateCode}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                      {c.pdf_path && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => downloadTaxCertificate(c)}
                        >
                          <Download className="h-4 w-4 mr-1" />
                          PDF
                        </Button>
                      )}
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
  );
}
