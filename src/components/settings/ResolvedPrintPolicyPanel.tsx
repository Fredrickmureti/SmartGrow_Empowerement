/**
 * ResolvedPrintPolicyPanel — Receipt overhaul Phase 2.
 *
 * Renders the `X-Print-Policy-*` headers returned by the test-print endpoint
 * so operators can see EXACTLY what the server resolved (paper, columns,
 * font, profile id, source) versus what the editor showed. If the resolved
 * column count differs from the editor's expectation, we render a warning
 * banner — that is the primary symptom of a stale or misconfigured printer
 * profile silently overriding settings.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ResolvedPrintPolicy } from "@/hooks/pos/useTestPrintReceipt";

interface Props {
  resolved: ResolvedPrintPolicy | null;
  /** Columns the editor *thinks* it is rendering at, for drift detection. */
  expectedColumns?: number | null;
  /** Profile label keyed by id for friendly display. */
  profileLabel?: (id: string) => string | null;
}

export function ResolvedPrintPolicyPanel({ resolved, expectedColumns, profileLabel }: Props) {
  if (!resolved) {
    return (
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="py-3 text-xs text-muted-foreground">
          Send a test print to see exactly what the server will emit
          (paper, columns, font, printer profile).
        </CardContent>
      </Card>
    );
  }

  const drift =
    expectedColumns != null &&
    resolved.columns != null &&
    expectedColumns !== resolved.columns;

  const profileDisplay = resolved.profileId
    ? (profileLabel?.(resolved.profileId) ?? resolved.profileId.slice(0, 8))
    : "engine defaults";

  return (
    <Card>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold flex items-center gap-1.5">
            {drift ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            )}
            Resolved by server
          </div>
          <span className="text-[10px] text-muted-foreground">
            {new Date(resolved.at).toLocaleTimeString()}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {resolved.paper && (
            <Badge variant="outline" className="text-[10px]">paper {resolved.paper}</Badge>
          )}
          {resolved.columns != null && (
            <Badge variant={drift ? "destructive" : "secondary"} className="text-[10px]">
              {resolved.columns} cols
            </Badge>
          )}
          {resolved.font && (
            <Badge variant="outline" className="text-[10px]">Font {resolved.font}</Badge>
          )}
          {resolved.renderMode && (
            <Badge variant="outline" className="text-[10px]">{resolved.renderMode}</Badge>
          )}
          {resolved.source && (
            <Badge variant="outline" className="text-[10px]">via {resolved.source}</Badge>
          )}
          <Badge variant="outline" className="text-[10px]" title={resolved.profileId ?? undefined}>
            profile: {profileDisplay}
          </Badge>
          {resolved.coerced && (
            <Badge variant="destructive" className="text-[10px]">policy coerced</Badge>
          )}
          <Badge variant="outline" className="text-[10px]">{resolved.byteLength} B</Badge>
        </div>
        {drift && (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            <AlertDescription className="text-[11px]">
              The editor expected {expectedColumns} cols but the printer profile resolved to {resolved.columns}.
              Update the printer profile (font / columns override / margin) so the preview matches what
              this device actually prints.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
