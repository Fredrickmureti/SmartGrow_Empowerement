import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, ShieldCheck, ShieldAlert, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

/**
 * Cross-Business Integrity Diagnostics — Admin tool
 *
 * Surfaces the three SECURITY DEFINER RPCs that detect cross-business data
 * contamination on a clean install:
 *   - find_cross_business_journal_lines  → JE lines pointing at accounts of
 *     a different business than the entry
 *   - find_invoice_contact_business_mismatches → invoices whose contact
 *     belongs to a different business
 *   - find_bill_vendor_business_mismatches → bills whose vendor belongs to a
 *     different business
 *
 * Healthy state: all three return zero rows.
 */

type CheckId = "journal_lines" | "invoice_contacts" | "bill_vendors";

interface CheckResult {
  count: number;
  rows: any[];
  error?: string;
}

const CHECKS: Array<{
  id: CheckId;
  rpc:
    | "find_cross_business_journal_lines"
    | "find_invoice_contact_business_mismatches"
    | "find_bill_vendor_business_mismatches";
  title: string;
  description: string;
}> = [
  {
    id: "journal_lines",
    rpc: "find_cross_business_journal_lines",
    title: "Cross-business journal lines",
    description:
      "Journal-entry lines whose account belongs to a different Company than the entry. Should be zero — the enforce_je_line_company_match trigger blocks new ones.",
  },
  {
    id: "invoice_contacts",
    rpc: "find_invoice_contact_business_mismatches",
    title: "Invoice ↔ contact mismatches",
    description:
      "Invoices whose customer contact belongs to a different Company. Should be zero — enforced at write time by enforce_invoice_contact_business_match.",
  },
  {
    id: "bill_vendors",
    rpc: "find_bill_vendor_business_mismatches",
    title: "Bill ↔ vendor mismatches",
    description:
      "Bills whose vendor contact belongs to a different Company. Should be zero — enforced at write time by enforce_bill_vendor_business_match.",
  },
];

export function DataIntegrityDiagnostics() {
  const { toast } = useToast();
  const [results, setResults] = useState<Record<CheckId, CheckResult | null>>({
    journal_lines: null,
    invoice_contacts: null,
    bill_vendors: null,
  });
  const [isRunning, setIsRunning] = useState(false);

  const runAll = async () => {
    setIsRunning(true);
    const next: Record<CheckId, CheckResult | null> = {
      journal_lines: null,
      invoice_contacts: null,
      bill_vendors: null,
    };
    try {
      await Promise.all(
        CHECKS.map(async (check) => {
          const { data, error } = await supabase.rpc(check.rpc as any);
          if (error) {
            next[check.id] = { count: 0, rows: [], error: error.message };
          } else {
            const rows = (data ?? []) as any[];
            next[check.id] = { count: rows.length, rows };
          }
        })
      );
      setResults(next);
      const totalIssues = Object.values(next).reduce(
        (sum, r) => sum + (r?.count ?? 0),
        0
      );
      toast({
        title: totalIssues === 0 ? "Integrity verified" : `${totalIssues} issue(s) found`,
        description:
          totalIssues === 0
            ? "No cross-business contamination detected."
            : "Review the per-check details below.",
        variant: totalIssues === 0 ? "default" : "destructive",
      });
    } catch (err: any) {
      toast({
        title: "Diagnostics failed",
        description: normalizeError(err).message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  const totalIssues = Object.values(results).reduce(
    (sum, r) => sum + (r?.count ?? 0),
    0
  );
  const hasRun = Object.values(results).some((r) => r !== null);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Cross-Business Integrity
            </CardTitle>
            <CardDescription>
              Detects rows that violate company-isolation invariants. Production should always report zero issues.
            </CardDescription>
          </div>
          <Button onClick={runAll} disabled={isRunning} size="sm">
            {isRunning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Run all checks
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasRun && totalIssues === 0 && (
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>Healthy</AlertTitle>
            <AlertDescription>
              All three integrity checks returned zero rows. No cross-business contamination detected.
            </AlertDescription>
          </Alert>
        )}
        {hasRun && totalIssues > 0 && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>{totalIssues} issue(s) detected</AlertTitle>
            <AlertDescription>
              These rows bypassed write-time invariants (likely seeded before triggers were installed). Investigate per-check below.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          {CHECKS.map((check) => {
            const result = results[check.id];
            return (
              <div
                key={check.id}
                className="rounded-lg border p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="font-medium text-sm">{check.title}</h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      {check.description}
                    </p>
                  </div>
                  {result && (
                    <Badge
                      variant={
                        result.error
                          ? "destructive"
                          : result.count === 0
                            ? "secondary"
                            : "destructive"
                      }
                      className="shrink-0"
                    >
                      {result.error
                        ? "Error"
                        : result.count === 0
                          ? "Clean"
                          : `${result.count} row${result.count === 1 ? "" : "s"}`}
                    </Badge>
                  )}
                </div>
                {result?.error && (
                  <p className="text-xs text-destructive">{result.error}</p>
                )}
                {result && result.count > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Show offending rows
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">
                      {JSON.stringify(result.rows, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}