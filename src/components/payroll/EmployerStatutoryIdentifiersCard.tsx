/**
 * EmployerStatutoryIdentifiersCard — pack-driven editor for the
 * employer's statutory IDs. Rows are sourced from `pack_requirements`
 * (scope = 'statutory_identifier', module = 'payroll'); the employer
 * fills in the value for each, persisted to
 * `organization_statutory_identifiers`.
 *
 * Country-agnostic: this component never names a statutory identifier.
 * Install a Rwanda pack → RSSB / PAYE_RW fields appear. Install a UK
 * pack → UTR / EIN fields appear. No code changes.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, AlertCircle } from "lucide-react";
import { useEmployeeRequirements } from "@/hooks/hr/useEmployeeRequirements";
import { useOrganizationStatutoryIdentifiers } from "@/hooks/organization/useOrganizationStatutoryIdentifiers";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface FieldState {
  identifier_type: string;
  country_code: string;
  label: string;
  is_required: boolean;
  value: string;
  initial: string;
}

export function EmployerStatutoryIdentifiersCard() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { can } = usePermissions();
  const canEdit = can("managePayroll");

  const req = useEmployeeRequirements({ module: "payroll" });
  const { rows, isLoading: rowsLoading, upsert } =
    useOrganizationStatutoryIdentifiers(currentOrg?.id, currentBusiness?.id);

  const fields = useMemo<FieldState[]>(() => {
    const valueByKey = new Map<string, string>();
    for (const r of rows) {
      const cc = (r.country_code ?? "").toUpperCase().slice(0, 2);
      valueByKey.set(`${cc}::${r.identifier_type}`, r.identifier_value ?? "");
    }
    return req.statutory.map((r) => {
      const cc = (r.country_code ?? "").toUpperCase().slice(0, 2);
      const initial = valueByKey.get(`${cc}::${r.requirement_key}`) ?? "";
      return {
        identifier_type: r.requirement_key,
        country_code: cc,
        label: r.label || r.requirement_key,
        is_required: !!r.is_required,
        value: initial,
        initial,
      };
    });
  }, [req.statutory, rows]);

  // Draft holds in-progress edits per field. We intentionally do NOT re-seed
  // it from `fields` on every render — that was the source of the
  // "character disappears as I type / can't delete value" bug: every
  // keystroke triggered a re-render, the useMemo for `fields` produced a
  // new array reference, and a useEffect([fields]) would wipe the draft
  // back to the persisted value. Instead we treat `draft[key]` as an
  // optional override; when absent, we fall back to the persisted value.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const valueOf = (f: FieldState) => {
    const key = `${f.country_code}::${f.identifier_type}`;
    return draft[key] !== undefined ? draft[key] : f.value;
  };

  const isLoading = req.isLoading || rowsLoading;
  const allOk = fields.every((f) => !f.is_required || valueOf(f).trim() !== "");

  const dirtyFields = fields.filter((f) => {
    const key = `${f.country_code}::${f.identifier_type}`;
    return draft[key] !== undefined && draft[key] !== f.initial;
  });

  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    if (!dirtyFields.length) return;
    setSaving(true);
    try {
      for (const f of dirtyFields) {
        const key = `${f.country_code}::${f.identifier_type}`;
        await upsert.mutateAsync({
          identifier_type: f.identifier_type,
          country_code: f.country_code,
          identifier_value: draft[key] ?? "",
        });
      }
      setDraft({});
      toast.success("Statutory identifiers saved");
    } catch (e: any) {
      toast.error(normalizeError(e).message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">4. Employer Statutory Identifiers</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Your company's statutory registration numbers (Tax PIN, employer social-security
            number, etc.). These appear on every payslip PDF and the employee portal. The
            field list is driven by the installed localization pack — no code changes are
            needed to support a new country.
          </p>
        </div>
        {!isLoading && (
          <Badge
            className="gap-1"
            variant={fields.length === 0 ? "secondary" : allOk ? "default" : "destructive"}
          >
            {fields.length === 0
              ? "No pack installed"
              : allOk
              ? "Ready"
              : "Action needed"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : fields.length === 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
            <div>
              <div className="font-medium">No statutory identifiers required by the installed pack.</div>
              <p className="text-muted-foreground">
                Install a localization pack in Step 1 to surface country-specific employer
                identifiers here.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {fields.map((f) => {
                const key = `${f.country_code}::${f.identifier_type}`;
                const value = valueOf(f);
                const missing = f.is_required && value.trim() === "";
                return (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`org-id-${key}`} className="flex items-center gap-2">
                      <span>{f.label}</span>
                      {f.country_code && (
                        <Badge variant="outline" className="text-[10px]">{f.country_code}</Badge>
                      )}
                      {f.is_required && (
                        <span className="text-[10px] uppercase tracking-wide text-destructive">required</span>
                      )}
                    </Label>
                    <Input
                      id={`org-id-${key}`}
                      value={value}
                      disabled={!canEdit || saving}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, [key]: e.target.value }))
                      }
                      placeholder={`Enter ${f.label.toLowerCase()}`}
                      aria-invalid={missing}
                    />
                    {missing && (
                      <p className="text-xs text-destructive">This identifier is required.</p>
                    )}
                  </div>
                );
              })}
            </div>
            {canEdit && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <span className="text-xs text-muted-foreground">
                  {dirtyFields.length === 0 ? "All changes saved" : `${dirtyFields.length} unsaved change(s)`}
                </span>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || dirtyFields.length === 0}
                >
                  {saving ? (
                    <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Saving…</>
                  ) : (
                    <><Save className="h-3.5 w-3.5 mr-1.5" /> Save</>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default EmployerStatutoryIdentifiersCard;
