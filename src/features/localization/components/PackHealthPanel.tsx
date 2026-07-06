import { normalizeError } from "@/services/resilience";
/**
 * PackHealthPanel — surfaces rows that were grandfathered in before the
 * `assert_pack_payload_valid` trigger was active (`legacy_unvalidated=true`).
 * Each row gets a "validate now" action that re-runs the server-side
 * validator and clears the flag if the row passes.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  usePackHealth,
  useCertificateTemplateHealth,
  useCertificateRenderFallbackHealth,
} from "../hooks/usePack";
import { validatePayload } from "../hooks";

export function PackHealthPanel({ packId }: { packId?: string | null }) {
  const { data: rows, isLoading, refetch } = usePackHealth(packId);
  const certHealth = useCertificateTemplateHealth(packId);
  const fallbackHealth = useCertificateRenderFallbackHealth(packId);
  const legacyCerts = certHealth.data?.legacy ?? [];
  const missingMetaCerts = certHealth.data?.missingMetadata ?? [];
  const renderRefusals = fallbackHealth.data?.byTemplate ?? [];
  const totalWarnings =
    (rows?.length ?? 0) +
    legacyCerts.length +
    missingMetaCerts.length +
    (fallbackHealth.data?.totalRefusals ? 1 : 0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const validateOne = async (row: any) => {
    setBusyId(row.id);
    try {
      const r = await validatePayload({ kind: "rule", rule_type: row.rule_type, parameters: row.parameters });
      if (!r.valid) {
        toast.error(`${row.rule_code}: ${r.errors.slice(0, 2).join("; ")}`);
        return;
      }
      const { error } = await (supabase as any)
        .from("payroll_statutory_rules")
        .update({ legacy_unvalidated: false })
        .eq("id", row.id);
      if (error) throw error;
      toast.success(`${row.rule_code} cleared`);
      refetch();
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Validation failed");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" />
          Pack health
          {totalWarnings > 0 && (
            <Badge variant="destructive">{totalWarnings}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && totalWarnings === 0 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            All rules and certificate templates pass the current schema registry.
          </div>
        )}
        {(rows ?? []).map((r) => (
          <div key={r.id} className="flex items-center justify-between border rounded-md p-2 text-sm">
            <div className="space-y-0.5">
              <div className="font-mono text-xs">{r.rule_code}</div>
              <div className="text-xs text-muted-foreground">
                {r.rule_type} · {r.computation_method}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => validateOne(r)} disabled={busyId === r.id}>
              {busyId === r.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
              Validate now
            </Button>
          </div>
        ))}

        {legacyCerts.length > 0 && (
          <div className="border rounded-md p-2 space-y-1">
            <div className="text-xs font-semibold flex items-center gap-2">
              <ShieldAlert className="h-3 w-3 text-destructive" />
              Legacy certificate templates ({legacyCerts.length})
            </div>
            <div className="text-[11px] text-muted-foreground">
              Re-save these templates in the certificate editor to adopt the
              v2 sections schema (ADR 0060). Publish will refuse them until
              they are migrated.
            </div>
            <ul className="text-xs list-disc pl-5">
              {legacyCerts.map((c) => (
                <li key={c.id}>
                  <span className="font-mono">{c.code}</span>
                  {c.display_name ? ` — ${c.display_name}` : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {missingMetaCerts.length > 0 && (
          <div className="border rounded-md p-2 space-y-1">
            <div className="text-xs font-semibold flex items-center gap-2">
              <ShieldAlert className="h-3 w-3 text-destructive" />
              Certificates missing legal metadata ({missingMetaCerts.length})
            </div>
            <div className="text-[11px] text-muted-foreground">
              Each certificate must carry statutory authority, legal
              reference, and effective date. Publish will fail otherwise.
            </div>
            <ul className="text-xs list-disc pl-5">
              {missingMetaCerts.map((c) => {
                const missing = [
                  !c.authority_id && "authority",
                  !c.legal_reference && "legal reference",
                  !c.effective_date && "effective date",
                ].filter(Boolean).join(", ");
                return (
                  <li key={c.id}>
                    <span className="font-mono">{c.code}</span>
                    {c.display_name ? ` — ${c.display_name}` : null}
                    <span className="text-muted-foreground"> · missing {missing}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}