/**
 * InvoiceIntegrityPanel
 *
 * Surfaces the existing useInvoiceIntegrityCheck warnings on the Sales
 * Dashboard so accountants get one-click access to invoices whose status
 * is inconsistent with their journal entries (Wave 3 of the Sales audit).
 */
import { AlertTriangle, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useInvoiceIntegrityCheck } from "@/hooks/useInvoiceValidation";

export function InvoiceIntegrityPanel() {
  const navigate = useNavigate();
  const { data, isLoading } = useInvoiceIntegrityCheck();

  if (isLoading || !data?.hasIssues) return null;

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <CardTitle className="text-base">Needs accounting review</CardTitle>
          </div>
          <Badge variant="destructive">{data.issueCount}</Badge>
        </div>
        <CardDescription>
          These invoices are marked paid or partial but their journal entry is missing or unbalanced.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.issues.slice(0, 5).map((issue) => (
          <button
            key={`${issue.invoice_id}-${issue.issue_type}`}
            type="button"
            onClick={() => navigate(`/sales/invoices?id=${issue.invoice_id}`)}
            className="flex w-full items-center justify-between gap-3 rounded-md border border-destructive/30 bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-destructive/5"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{issue.invoice_number}</div>
              <div className="truncate text-xs text-muted-foreground">{issue.description}</div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {data.issueCount > 5 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => navigate("/sales/invoices?status=paid")}
          >
            View all {data.issueCount} flagged invoices
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
