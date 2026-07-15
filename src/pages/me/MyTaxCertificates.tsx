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
import { useMemo } from "react";
import { format, parseISO } from "date-fns";
import { Download, FileText, Loader2 } from "lucide-react";
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
import { useState } from "react";
import { PageHeader, PageBody, LoadingState } from "@/design-system";

function StatusBadge({ status }: { status: TaxCertificate["status"] }) {
  if (status === "issued") return <Badge variant="default">Issued</Badge>;
  if (status === "superseded") return <Badge variant="outline">Superseded</Badge>;
  return <Badge variant="secondary">Draft</Badge>;
}

export default function MyTaxCertificates() {
  const { currentEmployee, isLoading: empLoading } = useCurrentEmployee();
  const templatesQ = useCertificateTemplates();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const employeeId = currentEmployee?.id;

  const certsQ = useQuery({
    queryKey: ["me", "tax-certificates", employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_tax_certificates")
        .select("id, organization_id, business_id, branch_id, employee_id, template_code, fiscal_year, pdf_path, xlsx_path, artifacts, serial_number, status, generated_at")
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

  const handleDownload = async (cert: TaxCertificate) => {
    setDownloadingId(cert.id);
    try {
      await downloadTaxCertificate(cert);
    } catch (e: any) {
      // toast already raised inside downloadTaxCertificate on failure
      if (!e?.message) toast.error("Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <>
      <PageHeader
        title="My tax certificates"
        description="Year-end statutory certificates issued for you by your employer. Download these for personal tax filing or record-keeping."
      />
      <PageBody>
      <Card>
        <CardHeader>
          <CardTitle>Issued certificates</CardTitle>
          <CardDescription>
            {issued.length === 0
              ? "Nothing has been issued for you yet. Your employer generates these at the end of each fiscal year."
              : `${issued.length} certificate${issued.length === 1 ? "" : "s"} available for download.`}
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
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certs.map((cert) => {
                  const dim = cert.status === "superseded";
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
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!cert.pdf_path || downloadingId === cert.id}
                          onClick={() => handleDownload(cert)}
                        >
                          {downloadingId === cert.id ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4 mr-1" />
                          )}
                          Download
                        </Button>
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
