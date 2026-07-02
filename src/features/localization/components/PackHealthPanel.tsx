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
import { usePackHealth } from "../hooks/usePack";
import { validatePayload } from "../hooks";

export function PackHealthPanel({ packId }: { packId?: string | null }) {
  const { data: rows, isLoading, refetch } = usePackHealth(packId);
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
          {rows && rows.length > 0 && <Badge variant="destructive">{rows.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && (!rows || rows.length === 0) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-green-600" />
            All rules validated against the current schema registry.
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
      </CardContent>
    </Card>
  );
}