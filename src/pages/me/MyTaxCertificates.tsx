/**
 * MyTaxCertificates — employee self-service tax-certificate surface at
 * `/me/tax-certificates`.
 *
 * Country-agnostic: lists whatever certificates the org has issued for THIS
 * employee under the installed localization pack (Kenyan P9, South African
 * IRP5, German Lohnsteuerbescheinigung, UK P60, …). No country names appear
 * in this file — template display names come from
 * `localization_pack_certificate_templates`.
 *
 * Read path: the employee self-read RLS policy on `payroll_tax_certificates`
 * scopes rows to `employee_id = (employees row where user_id = auth.uid())`.
 *
 * Download path: `download-tax-certificate` edge function has a self-service
 * bypass that skips the `payroll.read` permission check when the requester
 * owns the certificate's employee row (mirrors `generate-payslip-pdf`).
 *
 * Superseded certificates are shown but visually de-emphasized; only the
 * latest "issued" row per (template, year) is the canonical document.
 */
import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Download, Loader2, Printer } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useCertificateTemplates, downloadTaxCertificate, type TaxCertificate } from "@/hooks/payroll/useTaxCertificates";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { toast } from "sonner";
import { PageHeader, PageBody, LoadingState } from "@/design-system";

function StatusBadge({ status }: { status: TaxCertificate["status"] }) {
  if (status === "issued") return <Badge variant="default">Issued</Badge>;
  if (status === "superseded") return <Badge variant="outline">Superseded</Badge>;
  return <Badge variant="secondary">Draft</Badge>;
}

/**
 * Employee-facing artifact formats. `gov_*` outputs are for filers, not
 * employees, so they are filtered out of the ESS surface.
 */
const EMPLOYEE_FORMATS = new Set(["html", "pdf", "xlsx"]);

type ArtifactAction = {
  key: string;
  format: string;
  label: string;
  icon: "print" | "download";
  run: () => Promise<void>;
};

function buildActions(cert: TaxCertificate): ArtifactAction[] {
  const raw: Array<{ format: string; path?: string | null; label?: string | null }> =
    Array.isArray(cert.artifacts) && cert.artifacts.length
      ? (cert.artifacts as any[])
      : ([
          cert.pdf_path ? { format: "pdf", path: cert.pdf_path } : null,
          cert.xlsx_path ? { format: "xlsx", path: cert.xlsx_path } : null,
        ].filter(Boolean) as any[]);

  return raw
    .filter((a) => EMPLOYEE_FORMATS.has(a.format))
    .map((a, i) => {
      const isHtml = a.format === "html";
      const label =
        a.label ??
        (isHtml ? "Print" : a.format === "xlsx" ? "Excel" : "PDF");
      return {
        key: `${a.format}-${a.path ?? i}`,
        format: a.format,
        label,
        icon: isHtml ? "print" : "download",
        run: async () => {
          if (isHtml && a.path) {
            await downloadTaxCertificate({
              artifact_path: a.path,
              format: "html",
              certificateId: cert.id,
              businessId: cert.business_id ?? null,
              branchId: cert.branch_id ?? null,
            });
          } else if (a.format === "xlsx") {
            await downloadTaxCertificate(cert, "xlsx");
          } else {
            await downloadTaxCertificate(cert);
          }
        },
      } as ArtifactAction;
    });
}

export default function MyTaxCertificates() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const templatesQ = useCertificateTemplates();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const employeeId = currentEmployee?.id;

  const certsQ = useQuery({
    queryKey: ["me", "tax-certificates", employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_tax_certificates")
        .select("id, organization_id, business_id, branch_id, employee_id, template_code, fiscal_year, pdf_path, xlsx_path, artifacts, serial_number, status, generated_at, stale, stale_reason")
        .eq("employee_id", employeeId!)
        .order("fiscal_year", { ascending: false })
        .order("generated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TaxCertificate[];
    },
  });

  const templateLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of templatesQ.data ?? []) m.set(t.code, t.display_name);
    return (code: string) => m.get(code) ?? code;
  }, [templatesQ.data]);

  if (empLoading) {
    return (
      <>
        <PageHeader title="My tax certificates" description="Year-end statutory certificates issued for you by your employer." />
        <PageBody><LoadingState /></PageBody>
      </>
    );
  }
  if (!currentEmployee) {
    return <EmployeeLinkRequired />;
  }

  const certs = certsQ.data ?? [];
  const issued = certs.filter((c) => c.status === "issued");

  const runAction = async (rowKey: string, action: ArtifactAction) => {
    const key = `${rowKey}:${action.key}`;
    setBusyKey(key);
    try {
      await action.run();
    } catch (e: any) {
      if (!e?.message) toast.error("Action failed");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <PageHeader
        title="My tax certificates"
        description="Year-end statutory certificates issued for you by your employer. Print for your records or download for personal tax filing."
      />
      <PageBody>
      <Card>
        <CardHeader>
          <CardTitle>Issued certificates</CardTitle>
          <CardDescription>
            {issued.length === 0
              ? "Nothing has been issued for you yet. Your employer generates these at the end of each fiscal year."
              : `${issued.length} certificate${issued.length === 1 ? "" : "s"} available.`}
            {certs.length > issued.length
              ? ` Older superseded versions are also listed for your reference.`
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {certsQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : certs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No tax certificates yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Year</TableHead>
                  <TableHead>Certificate</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certs.map((cert) => {
                  const dim = cert.status === "superseded";
                  const actions = buildActions(cert);
                  const staleTitle = cert.stale
                    ? "Regenerate this certificate before downloading the current file"
                    : undefined;
                  return (
                    <TableRow key={cert.id} className={dim ? "opacity-60" : ""}>
                      <TableCell className="font-medium">{cert.fiscal_year}</TableCell>
                      <TableCell>{templateLabel(cert.template_code)}</TableCell>
                      <TableCell className="font-mono text-xs">{cert.serial_number}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {cert.generated_at ? format(parseISO(cert.generated_at), "d MMM yyyy") : "—"}
                      </TableCell>
                      <TableCell><StatusBadge status={cert.status} /></TableCell>
                      <TableCell className="text-right">
                        {actions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No downloads</span>
                        ) : (
                          <div className="flex flex-wrap justify-end gap-1">
                            {actions.map((a) => {
                              const key = `${cert.id}:${a.key}`;
                              const busy = busyKey === key;
                              const Icon = busy
                                ? Loader2
                                : a.icon === "print"
                                  ? Printer
                                  : Download;
                              return (
                                <Button
                                  key={a.key}
                                  variant={a.icon === "print" ? "outline" : "ghost"}
                                  size="sm"
                                  disabled={!!cert.stale || busy}
                                  title={staleTitle}
                                  onClick={() => runAction(cert.id, a)}
                                >
                                  <Icon className={`h-4 w-4 mr-1 ${busy ? "animate-spin" : ""}`} />
                                  {a.label}
                                </Button>
                              );
                            })}
                          </div>
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
      </PageBody>
    </>
  );
}

