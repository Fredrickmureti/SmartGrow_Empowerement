/**
 * MyAnnualEarnings — employee self-service Annual Earnings Statement
 * (ADR-0063). Country-neutral surface at `/me/annual-earnings`.
 *
 * The employee picks a fiscal year, and the page invokes the
 * `generate-annual-earnings-statement` edge function which resolves the
 * canonical DTO and returns compiled HTML (paged.js opens it in a print
 * window). Self-service bypass in the edge function skips the
 * `payroll.read` permission check when `auth.uid()` matches the target
 * employee's `user_id`.
 */
import { useMemo, useState } from "react";
import { Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { PageHeader, PageBody, LoadingState } from "@/design-system";
import { toast } from "sonner";

export default function MyAnnualEarnings() {
  const { currentEmployee, isLoading } = useCurrentEmployee();
  const currentYear = new Date().getFullYear();
  const years = useMemo(
    () => Array.from({ length: 5 }, (_, i) => currentYear - i),
    [currentYear],
  );
  const [year, setYear] = useState<number>(currentYear);
  const [busy, setBusy] = useState(false);

  if (isLoading) {
    return (
      <>
        <PageHeader title="My annual earnings" description="Country-neutral annual earnings statement." />
        <PageBody><LoadingState /></PageBody>
      </>
    );
  }
  if (!currentEmployee) return <EmployeeLinkRequired />;

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "generate-annual-earnings-statement",
        {
          body: {
            organization_id: (currentEmployee as any).organization_id,
            business_id: (currentEmployee as any).business_id,
            employee_id: currentEmployee.id,
            fiscal_year: year,
          },
        },
      );
      if (error) throw error;
      const html = (data as any)?.html as string | undefined;
      if (!html) throw new Error("no_html");
      const win = window.open("", "_blank");
      if (!win) {
        toast.error("Popup blocked — allow popups to view your statement");
        return;
      }
      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate statement");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="My annual earnings"
        description="Generate your Annual Earnings Statement — a canonical, country-neutral summary of every month, every category, and year-to-date totals from your payroll history."
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle>Choose a year</CardTitle>
            <CardDescription>
              The statement is regenerated from the authoritative payroll
              ledger every time — identical inputs produce an identical
              document (deterministic content hash). Applicable localization
              appendices (e.g. P9, P60, IRP5) are added automatically if
              your employer has the matching pack installed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-end gap-3">
            <div className="w-40">
              <label className="text-sm text-muted-foreground">Fiscal year</label>
              <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {years.map((y) => (
                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={run} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Printer className="h-4 w-4 mr-2" />}
              Generate & print
            </Button>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}