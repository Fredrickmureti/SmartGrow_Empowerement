/**
 * Document numbering settings (company scope).
 *
 * The database is the sole authority for reference numbers: every new client,
 * loan application, loan, repayment receipt and disbursement gets its number
 * from `mf_next_number()` via a BEFORE INSERT trigger. This screen only edits
 * the *rule* (prefix + digit length) for each document kind; the running
 * counter is never user-editable.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, Hash } from "lucide-react";
import { toast } from "sonner";

interface SequenceDef {
  key: string;
  label: string;
  description: string;
  defaultPrefix: string;
}

const SEQUENCES: SequenceDef[] = [
  { key: "client", label: "Clients", description: "Client registration number", defaultPrefix: "CL" },
  { key: "loan_application", label: "Loan applications", description: "Application reference", defaultPrefix: "APP" },
  { key: "loan", label: "Loans", description: "Loan account number", defaultPrefix: "LN" },
  { key: "receipt", label: "Repayment receipts", description: "Receipt number issued to the client", defaultPrefix: "RCP" },
  { key: "disbursement", label: "Disbursements", description: "Disbursement voucher number", defaultPrefix: "DSB" },
];

interface RuleRow {
  id: string;
  sequence_key: string;
  prefix: string;
  padding: number;
}

interface Draft {
  prefix: string;
  padding: number;
}

function sample(prefix: string, padding: number) {
  return `${prefix || "?"}-${"1".padStart(Math.min(Math.max(padding, 1), 12), "0")}`;
}

export function DocumentNumberingSettings() {
  const { currentBusiness } = useBusinesses();
  const permissions = usePermissions();
  const businessId = currentBusiness?.id ?? null;
  const canEdit = permissions.canEditSettings;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [initial, setInitial] = useState<Record<string, Draft>>({});
  const [ruleIds, setRuleIds] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    if (!businessId) return;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from("document_number_rules")
        .select("id,sequence_key,prefix,padding")
        .eq("business_id", businessId)
        .is("branch_id", null);
      if (cancelled) return;
      if (error) {
        toast.error("Could not load numbering settings");
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as RuleRow[];
      const next: Record<string, Draft> = {};
      const ids: Record<string, string> = {};
      for (const def of SEQUENCES) {
        const row = rows.find((r) => r.sequence_key === def.key);
        if (row) ids[def.key] = row.id;
        next[def.key] = {
          prefix: row?.prefix ?? def.defaultPrefix,
          padding: row?.padding ?? 6,
        };
      }
      setRuleIds(ids);
      setDrafts(next);
      setInitial(next);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const dirty = useMemo(
    () =>
      SEQUENCES.some(
        (d) =>
          drafts[d.key] &&
          initial[d.key] &&
          (drafts[d.key].prefix !== initial[d.key].prefix ||
            drafts[d.key].padding !== initial[d.key].padding),
      ),
    [drafts, initial],
  );

  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const handleSave = async () => {
    if (!businessId) return;
    const invalid = SEQUENCES.find(
      (d) => !drafts[d.key]?.prefix.trim() || drafts[d.key].padding < 1 || drafts[d.key].padding > 12,
    );
    if (invalid) {
      toast.error(`Check the ${invalid.label.toLowerCase()} settings — a prefix is required and the digit count must be between 1 and 12.`);
      return;
    }
    setSaving(true);
    // The scope uniqueness index is an expression index (COALESCE on
    // branch_id), which PostgREST cannot target with on_conflict — so update
    // existing rules by id and insert only the ones that do not exist yet.
    const changed = SEQUENCES.filter(
      (d) =>
        drafts[d.key].prefix !== initial[d.key]?.prefix ||
        drafts[d.key].padding !== initial[d.key]?.padding,
    );
    let failed = false;
    const inserts: Array<Record<string, unknown>> = [];
    for (const d of changed) {
      const values = {
        prefix: drafts[d.key].prefix.trim().toUpperCase(),
        padding: drafts[d.key].padding,
      };
      const id = ruleIds[d.key];
      if (id) {
        const { error } = await supabase
          .from("document_number_rules")
          .update({ ...values, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) failed = true;
      } else {
        inserts.push({
          business_id: businessId,
          branch_id: null,
          sequence_key: d.key,
          period_reset: "never",
          ...values,
        });
      }
    }
    if (inserts.length > 0) {
      const { data, error } = await supabase
        .from("document_number_rules")
        .insert(inserts)
        .select("id,sequence_key");
      if (error) failed = true;
      else if (data) {
        setRuleIds((prev) => {
          const next = { ...prev };
          for (const row of data as Array<{ id: string; sequence_key: string }>) {
            next[row.sequence_key] = row.id;
          }
          return next;
        });
      }
    }
    setSaving(false);
    if (failed) {
      toast.error("Could not save numbering settings");
      return;
    }
    const saved: Record<string, Draft> = {};
    for (const d of SEQUENCES) saved[d.key] = { ...drafts[d.key] };
    setInitial(saved);
    toast.success("Numbering settings saved");
  };

  if (!businessId) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hash className="h-4 w-4" />
          Reference numbering
        </CardTitle>
        <CardDescription>
          Set the prefix and number length for each document. Numbers are assigned
          automatically when a record is created and can never be edited afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {SEQUENCES.map((def) => {
                const draft = drafts[def.key];
                if (!draft) return null;
                return (
                  <div
                    key={def.key}
                    className="grid gap-3 sm:grid-cols-[1fr_8rem_6rem_10rem] sm:items-end"
                  >
                    <div>
                      <p className="text-sm font-medium">{def.label}</p>
                      <p className="text-xs text-muted-foreground">{def.description}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`prefix-${def.key}`} className="text-xs">
                        Prefix
                      </Label>
                      <Input
                        id={`prefix-${def.key}`}
                        value={draft.prefix}
                        disabled={!canEdit}
                        maxLength={8}
                        onChange={(e) => set(def.key, { prefix: e.target.value.toUpperCase() })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`padding-${def.key}`} className="text-xs">
                        Digits
                      </Label>
                      <Input
                        id={`padding-${def.key}`}
                        type="number"
                        min={1}
                        max={12}
                        value={draft.padding}
                        disabled={!canEdit}
                        onChange={(e) => set(def.key, { padding: Number(e.target.value) })}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground sm:pb-2">
                      e.g. <span className="font-mono">{sample(draft.prefix, draft.padding)}</span>
                    </p>
                  </div>
                );
              })}
            </div>

            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={!dirty || saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save numbering
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default DocumentNumberingSettings;
