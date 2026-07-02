import { AlertTriangle, CheckCircle2, FileWarning, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAccountingIntegrity } from "@/hooks/finance/useAccountingIntegrity";

const severityVariant = (severity: string) =>
  severity === "critical" ? "destructive" : severity === "warning" ? "secondary" : "outline";

export function AccountingIntegrityCard() {
  const { data: findings = [], isLoading, isError, error, refetch, isFetching } = useAccountingIntegrity(200);

  const criticalCount = findings.filter((finding) => finding.severity === "critical").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const topFindings = findings.slice(0, 12);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Accounting Integrity
              {criticalCount > 0 ? (
                <Badge variant="destructive">{criticalCount} Critical</Badge>
              ) : warningCount > 0 ? (
                <Badge variant="secondary">{warningCount} Warnings</Badge>
              ) : (
                <Badge variant="outline">Clean</Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Zero-trust checks for GL balance, source linkage, journal books, reconciliation links, and entity isolation.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Recheck
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {(error as Error)?.message ?? "Could not load accounting integrity findings."}
            </AlertDescription>
          </Alert>
        ) : findings.length === 0 ? (
          <Alert className="border-primary/30 bg-primary/5">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            <AlertDescription className="text-foreground">
              No critical accounting integrity findings were detected for the current scope.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Critical</p>
                <p className="text-2xl font-semibold text-destructive">{criticalCount}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Warnings</p>
                <p className="text-2xl font-semibold">{warningCount}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Total findings</p>
                <p className="text-2xl font-semibold">{findings.length}</p>
              </div>
            </div>

            <div className="space-y-2">
              {topFindings.map((finding) => (
                <div key={finding.id} className="rounded-md border p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileWarning className="h-4 w-4 text-muted-foreground" />
                        <p className="font-medium">{finding.finding_title}</p>
                        <Badge variant={severityVariant(finding.severity)}>{finding.severity}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{finding.finding_detail}</p>
                      <p className="text-xs text-muted-foreground">
                        {finding.entity_type} · {finding.entity_ref ?? finding.entity_id}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {findings.length > topFindings.length && (
              <p className="text-xs text-muted-foreground">
                Showing {topFindings.length} of {findings.length} findings. Fix critical items first, then recheck.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
