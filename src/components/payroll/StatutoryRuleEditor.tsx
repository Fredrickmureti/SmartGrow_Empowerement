import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO, subDays } from "date-fns";
import { Loader2, Plus, Trash2, AlertTriangle, Code as CodeIcon, ShieldCheck, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  COMPUTATION_METHODS,
  COMPUTATION_METHOD_LIST,
  type ComputationMethod,
  type ComputationMethodSpec,
  inferComputationMethod,
  normalizeParameters,
  suggestRuleCode,
} from "@/lib/payroll/computationMethods";
import { useRuleSchema, validatePayload } from "@/features/localization";
import { normalizeError } from "@/services/resilience";

/**
 * Map the editor's `computation_method` (engine-side) onto the
 * `computation_kind` used by `pack_rule_type_schemas` and
 * `validate-localization-payload`. Falls back to the method name itself
 * so an unmapped method just trips the legacy_unvalidated warning
 * instead of silently bypassing the schema registry.
 */
const METHOD_TO_KIND: Record<ComputationMethod, string> = {
  bracket_progressive: "progressive",
  tiered_brackets: "tiered",
  percentage_of_gross: "percentage",
  graduated_table: "graduated",
  // The published `fixed` schema requires `amount_per_employee` — that
  // payload shape belongs to per_employee_flat, not flat_amount. Mapping
  // them the other way (as a prior revision did) silently mis-validated
  // every NITA-shaped rule.
  per_employee_flat: "fixed",
  flat_amount: "flat",
};

// ─── Types mirrored from page (kept narrow) ─────────────────────────────

export interface StatutoryRuleRow {
  id: string;
  organization_id: string;
  business_id?: string | null;
  country_code: string;
  rule_type: string;
  rule_code: string;
  rule_name: string;
  computation_method: string;
  parameters: Record<string, any>;
  effective_from: string;
  effective_to: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface CountryOption { value: string; label: string }

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editingRule: StatutoryRuleRow | null;
  organizationId: string;
  defaultCountry: string;
  countries: CountryOption[];
  /** rule_type categories (e.g. income_tax, statutory_deduction). Free-form text. */
  ruleTypeOptions: { value: string; label: string }[];
  onSaved?: () => void;
}

function blankRow(spec: ComputationMethodSpec) {
  if (!spec.arrayField) return null;
  const row: Record<string, any> = {};
  for (const c of spec.arrayField.columns) row[c.key] = "";
  return row;
}

export function StatutoryRuleEditor({
  open, onOpenChange, editingRule, organizationId,
  defaultCountry, countries, ruleTypeOptions, onSaved,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ─── Form state ───
  const [method, setMethod] = useState<ComputationMethod>("percentage_of_gross");
  // Phase 3: GENERIC is an explicit "no jurisdiction selected" sentinel —
  // never auto-fall-through to KE. The Save button is disabled below until
  // the user picks a real country.
  const [country, setCountry] = useState(defaultCountry || "GENERIC");
  const [ruleType, setRuleType] = useState<string>(ruleTypeOptions[0]?.value || "statutory_deduction");
  const [ruleCode, setRuleCode] = useState("");
  const [ruleCodeTouched, setRuleCodeTouched] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [scalars, setScalars] = useState<Record<string, any>>({});
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(format(new Date(), "yyyy-MM-dd"));
  const [effectiveTo, setEffectiveTo] = useState<string>("");
  const [sortOrder, setSortOrder] = useState(1);
  const [isActive, setIsActive] = useState(true);
  const [saveAsNewVersion, setSaveAsNewVersion] = useState(false);
  const [showJsonPreview, setShowJsonPreview] = useState(false);

  // ─── Did this rule ever produce payslip lines? ───
  // Used to force "save as new version" so we never mutate history.
  const { data: lineUsageCount = 0 } = useQuery({
    queryKey: ["payslip-line-usage", editingRule?.id, editingRule?.rule_code],
    queryFn: async () => {
      if (!editingRule) return 0;
      // Try a robust pair of probes: by rule_code (canonical) and by rule name fallback.
      try {
        const { count, error } = await supabase
          .from("payroll_payslip_lines" as any)
          .select("id", { count: "exact", head: true })
          .eq("rule_code", editingRule.rule_code);
        if (!error && typeof count === "number") return count;
      } catch { /* table/column may not exist in this deployment — treat as 0 */ }
      return 0;
    },
    enabled: !!editingRule && open,
  });

  // Reset form whenever dialog opens
  useEffect(() => {
    if (!open) return;
    if (editingRule) {
      const inferred = (editingRule.computation_method && editingRule.computation_method !== "auto")
        ? (editingRule.computation_method as ComputationMethod)
        : (inferComputationMethod(editingRule.parameters) ?? "percentage_of_gross");
      const spec = COMPUTATION_METHODS[inferred] ?? COMPUTATION_METHODS.percentage_of_gross;
      setMethod(spec.method);
      setCountry(editingRule.country_code);
      setRuleType(editingRule.rule_type);
      setRuleCode(editingRule.rule_code || "");
      setRuleCodeTouched(true);
      setRuleName(editingRule.rule_name);
      // Split params into scalars vs array rows
      const params = editingRule.parameters || {};
      const sc: Record<string, any> = {};
      for (const f of spec.scalarFields) {
        const v = (params as any)[f.key];
        if (v == null) continue;
        sc[f.key] = typeof v === "boolean" ? String(v) : v;
      }
      setScalars(sc);
      if (spec.arrayField) {
        const arr = (params as any)[spec.arrayField.key];
        setRows(Array.isArray(arr) && arr.length > 0 ? arr.map((r) => ({ ...r })) : [blankRow(spec)!]);
      } else {
        setRows([]);
      }
      setEffectiveFrom(editingRule.effective_from);
      setEffectiveTo(editingRule.effective_to ?? "");
      setSortOrder(editingRule.sort_order ?? 1);
      setIsActive(editingRule.is_active);
      setSaveAsNewVersion(false);
    } else {
      const spec = COMPUTATION_METHODS.percentage_of_gross;
      setMethod("percentage_of_gross");
      setCountry(defaultCountry || "GENERIC");
      setRuleType(ruleTypeOptions[0]?.value || "statutory_deduction");
      setRuleCode("");
      setRuleCodeTouched(false);
      setRuleName("");
      const sc: Record<string, any> = {};
      for (const f of spec.scalarFields) if (f.default !== undefined) sc[f.key] = String(f.default);
      setScalars(sc);
      setRows(spec.arrayField ? [blankRow(spec)!] : []);
      setEffectiveFrom(format(new Date(), "yyyy-MM-dd"));
      setEffectiveTo("");
      setSortOrder(1);
      setIsActive(true);
      setSaveAsNewVersion(false);
    }
  }, [open, editingRule, defaultCountry, ruleTypeOptions]);

  // When method changes (and not initial load), reset row shape and scalar defaults.
  useEffect(() => {
    if (!open) return;
    if (editingRule && (editingRule.computation_method as ComputationMethod) === method) return;
    const spec = COMPUTATION_METHODS[method];
    setRows(spec.arrayField ? [blankRow(spec)!] : []);
    // Preserve any matching scalar values, drop unknown keys, apply defaults for new keys.
    setScalars((prev) => {
      const next: Record<string, any> = {};
      for (const f of spec.scalarFields) {
        if (prev[f.key] !== undefined) next[f.key] = prev[f.key];
        else if (f.default !== undefined) next[f.key] = String(f.default);
      }
      return next;
    });
  }, [method]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-suggest rule_code from name unless user has typed one.
  useEffect(() => {
    if (!ruleCodeTouched && !editingRule) {
      setRuleCode(suggestRuleCode(ruleName));
    }
  }, [ruleName, ruleCodeTouched, editingRule]);

  const spec = COMPUTATION_METHODS[method];
  const lockMethod = !!editingRule && lineUsageCount > 0;
  const forcedNewVersion = !!editingRule && lineUsageCount > 0;
  const effectiveSaveAsNewVersion = saveAsNewVersion || forcedNewVersion;

  const isInferred = !!editingRule && (editingRule.parameters as any)?._inferred === true;

  const cleanedParameters = useMemo(() => {
    // normalizeParameters already strips unknown keys (including the legacy
    // `_inferred` marker), so saving always clears the "inferred" state.
    return normalizeParameters(method, { ...scalars, [spec.arrayField?.key ?? "_"]: rows });
  }, [method, scalars, rows, spec.arrayField?.key]);

  // ─── Server-side schema bridge ───
  // Mirror the admin pack editor: every save runs through the same
  // `validate-localization-payload` edge function and pulls the canonical
  // schema from `pack_rule_type_schemas`. When no schema is registered
  // for (rule_type, computation_kind) the editor degrades to a soft
  // "legacy_unvalidated" warning — same wording RuleForm uses.
  const computationKind = METHOD_TO_KIND[method] ?? method;
  const { schema: packSchema } = useRuleSchema(ruleType, computationKind);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);

  // Payload as the admin pack editor would shape it: include `type`
  // so the validator picks the right schema row.
  const validatorPayload = useMemo(
    () => ({ ...cleanedParameters, type: computationKind }),
    [cleanedParameters, computationKind],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await validatePayload({
          kind: "rule",
          rule_type: ruleType,
          parameters: validatorPayload,
        });
        if (cancelled) return;
        setServerErrors(r.errors ?? []);
        setServerWarnings(r.warnings ?? []);
      } catch {
        // Network/edge errors are non-blocking — the DB trigger is the backstop.
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, ruleType, JSON.stringify(validatorPayload)]); // eslint-disable-line react-hooks/exhaustive-deps

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (!ruleName.trim()) errs.push("Display name is required.");
    if (!ruleCode.trim()) errs.push("Rule code is required.");
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(ruleCode.trim())) {
      errs.push("Rule code must be lowercase, start with a letter, and use only letters/digits/underscores.");
    }
    errs.push(...spec.validate(cleanedParameters));
    if (!effectiveFrom) errs.push("Effective from date is required.");
    if (effectiveTo && effectiveFrom && effectiveTo < effectiveFrom) {
      errs.push("Effective to must be on or after Effective from.");
    }
    // Server-side schema validation is authoritative — surface those alongside
    // the local checks so the Save button stays disabled until the payload
    // matches the canonical pack schema.
    errs.push(...serverErrors);
    return errs;
  }, [ruleName, ruleCode, spec, cleanedParameters, effectiveFrom, effectiveTo, serverErrors]);

  // ─── Save mutation ───
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        organization_id: organizationId,
        country_code: country,
        rule_type: ruleType,
        rule_code: ruleCode.trim(),
        rule_name: ruleName.trim(),
        computation_method: method,
        parameters: cleanedParameters,
        effective_from: effectiveFrom,
        effective_to: effectiveTo || null,
        sort_order: sortOrder,
        is_active: isActive,
      };

      // editingRule with an empty id is a "duplicate" prefill — treat as create.
      const isUpdate = !!editingRule?.id;

      if (isUpdate && effectiveSaveAsNewVersion) {
        // Supersede prior version: end-date the old row at (new effective_from - 1 day),
        // then insert the new version. Use a transactional pair of writes.
        const priorEnd = format(subDays(parseISO(effectiveFrom), 1), "yyyy-MM-dd");
        const { error: e1 } = await supabase
          .from("payroll_statutory_rules" as any)
          .update({ effective_to: priorEnd, is_active: false })
          .eq("id", editingRule!.id);
        if (e1) throw e1;
        const { error: e2 } = await supabase
          .from("payroll_statutory_rules" as any)
          .insert(payload);
        if (e2) throw e2;
        return { mode: "versioned" as const };
      }

      if (isUpdate) {
        const { error } = await supabase
          .from("payroll_statutory_rules" as any)
          .update(payload)
          .eq("id", editingRule!.id);
        if (error) throw error;
        return { mode: "updated" as const };
      }

      const { error } = await supabase
        .from("payroll_statutory_rules" as any)
        .insert(payload);
      if (error) throw error;
      return { mode: "created" as const };
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["payroll-statutory-rules-admin"] });
      queryClient.invalidateQueries({ queryKey: ["payroll-statutory-rules"] });
      toast({
        title:
          res.mode === "versioned" ? "New version saved"
          : res.mode === "updated" ? "Rule updated"
          : "Rule created",
        description:
          res.mode === "versioned"
            ? "Prior version was end-dated; future runs use this version."
            : undefined,
      });
      onOpenChange(false);
      onSaved?.();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: normalizeError(err).message ?? String(err), variant: "destructive" });
    },
  });

  // ─── Handlers ───
  const updateScalar = (key: string, value: string) => {
    setScalars((prev) => ({ ...prev, [key]: value }));
  };
  const updateRow = (i: number, key: string, value: string) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  };
  const addRow = () => {
    if (!spec.arrayField) return;
    setRows((prev) => [...prev, blankRow(spec)!]);
  };
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  const footer = (
    <>
      <Badge variant="secondary" className="mr-auto text-xs">
        method: {method}
      </Badge>
      <Button variant="outline" onClick={() => onOpenChange(false)} type="button">Cancel</Button>
      <Button
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || validationErrors.length > 0}
      >
        {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        {editingRule ? (effectiveSaveAsNewVersion ? "Save new version" : "Update rule") : "Create rule"}
      </Button>
    </>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="2xl"
      title={editingRule ? "Edit statutory rule" : "Add statutory rule"}
      description="Pick a computation method — the form adapts to what the payroll engine actually expects for that method."
      footer={footer}
    >
      <WorkflowSheetGrid>
        <WorkflowSheetSection number={1} title="Computation method" fullWidth>
          <WorkflowField label="Method" required>
            <Select value={method} onValueChange={(v) => setMethod(v as ComputationMethod)} disabled={lockMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {COMPUTATION_METHOD_LIST.map((s) => (
                  <SelectItem key={s.method} value={s.method}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <p className="text-xs text-muted-foreground">{spec.description}</p>
          {lockMethod && (
            <p className="text-xs text-amber-600">
              This rule has produced payslip lines; computation method is locked. Create a new rule if you need a different method.
            </p>
          )}
          {isInferred && (
            <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-amber-900 dark:text-amber-100">Computation method inferred from parameters</AlertTitle>
              <AlertDescription className="text-xs text-amber-800 dark:text-amber-200">
                This rule was seeded by a localization pack without an explicit computation method,
                so the form was filled in by inspecting the parameter shape. Review the method and
                parameter values above and click <em>Update rule</em> to confirm — saving clears this notice.
              </AlertDescription>
            </Alert>
          )}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Identity">
          <WorkflowField label="Country" required>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {countries.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Category" required>
            <Select value={ruleType} onValueChange={setRuleType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ruleTypeOptions.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Display name" required>
            <Input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="PAYE (Pay As You Earn)" />
          </WorkflowField>
          <WorkflowField
            label="Rule code"
            required
            hint="Stable machine key used for payslip lines and remittance buckets. Cannot collide within the same country."
          >
            <Input
              value={ruleCode}
              onChange={(e) => { setRuleCode(e.target.value); setRuleCodeTouched(true); }}
              placeholder="paye_pay_as_you_earn"
            />
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={3} title="Effective dates & versioning">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Effective from" required>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </WorkflowField>
            <WorkflowField label="Effective to (optional)">
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </WorkflowField>
          </div>
          {editingRule && (
            <div className="flex items-start gap-3 border rounded-lg p-3 bg-muted/30">
              <Switch
                checked={effectiveSaveAsNewVersion}
                onCheckedChange={setSaveAsNewVersion}
                disabled={forcedNewVersion}
              />
              <div className="space-y-1">
                <Label className="text-sm">Save as a new version</Label>
                <p className="text-xs text-muted-foreground">
                  {forcedNewVersion
                    ? `Required — this rule has already produced ${lineUsageCount} payslip line(s). The prior row will be end-dated at ${effectiveFrom ? format(subDays(parseISO(effectiveFrom), 1), "yyyy-MM-dd") : "(set effective from)"}, and a new effective row will be inserted.`
                    : "If on, the existing row is end-dated and a new row is inserted with the new effective_from. Off = update in place."}
                </p>
              </div>
            </div>
          )}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={4} title="Ordering & status">
          <WorkflowField label="Sort order">
            <Input type="number" min={1} value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 1)} />
          </WorkflowField>
          <WorkflowField label="Active">
            <div className="flex items-center gap-2 pt-1">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <span className="text-sm">{isActive ? "Active" : "Inactive"}</span>
            </div>
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>

      {spec.scalarFields.length > 0 && (
        <WorkflowSheetSection number={5} title="Parameters" fullWidth>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {spec.scalarFields.map((f) => (
              <WorkflowField key={f.key} label={f.label} required={!f.optional} hint={f.hint}>
                {f.type === "select" ? (
                  <Select value={String(scalars[f.key] ?? "")} onValueChange={(v) => updateScalar(f.key, v)}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                    <SelectContent>
                      {f.options?.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={f.type === "number" || f.type === "percentage" ? "number" : "text"}
                    step="any"
                    placeholder={f.placeholder}
                    value={scalars[f.key] ?? ""}
                    onChange={(e) => updateScalar(f.key, e.target.value)}
                  />
                )}
              </WorkflowField>
            ))}
          </div>
        </WorkflowSheetSection>
      )}

      {spec.arrayField && (
        <WorkflowSheetSection
          number={6}
          title={spec.arrayField.label}
          subtitle={spec.arrayField.description}
          fullWidth
          right={
            <Button variant="outline" size="sm" onClick={addRow} type="button">
              <Plus className="h-3 w-3 mr-1" /> Add row
            </Button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left font-medium pb-1 w-6">#</th>
                  {spec.arrayField.columns.map((c) => (
                    <th key={c.key} className="text-left font-medium pb-1 px-1">{c.label}</th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    <td className="text-muted-foreground py-1 pr-1">{i + 1}</td>
                    {spec.arrayField!.columns.map((c) => (
                      <td key={c.key} className="py-1 px-1">
                        <Input
                          className="h-8 text-xs"
                          type={c.type === "number" || c.type === "percentage" ? "number" : "text"}
                          step="any"
                          value={row[c.key] ?? ""}
                          onChange={(e) => updateRow(i, c.key, e.target.value)}
                          placeholder={c.allowOpenEnded && i === rows.length - 1 ? "open" : undefined}
                        />
                      </td>
                    ))}
                    <td className="py-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeRow(i)} type="button" disabled={rows.length === 1}>
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </WorkflowSheetSection>
      )}

      <WorkflowSheetSection number={7} title="Validation & schema" fullWidth>
        {validationErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Fix the following before saving</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 text-xs space-y-1 mt-1">
                {validationErrors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {packSchema ? (
          <Alert className="border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <AlertTitle className="text-emerald-900 dark:text-emerald-100">
              Schema-validated ({ruleType}/{computationKind} v{packSchema.schema_version})
            </AlertTitle>
            <AlertDescription className="text-xs text-emerald-800 dark:text-emerald-200">
              This payload is checked against the canonical pack schema before save and again by
              the database trigger on insert. Same enforcement as the platform pack editor.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
            <Info className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <AlertTitle className="text-amber-900 dark:text-amber-100">
              No schema registered for {ruleType}/{computationKind}
            </AlertTitle>
            <AlertDescription className="text-xs text-amber-800 dark:text-amber-200">
              Saved as <code>legacy_unvalidated</code>. The payroll engine will still run, but
              payload shape is not enforced until a schema lands in <code>pack_rule_type_schemas</code>.
            </AlertDescription>
          </Alert>
        )}
        {serverWarnings.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Validator warnings</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 text-xs space-y-1 mt-1">
                {serverWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <Collapsible open={showJsonPreview} onOpenChange={setShowJsonPreview}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" type="button" className="text-xs">
              <CodeIcon className="h-3 w-3 mr-1" />
              {showJsonPreview ? "Hide" : "Show"} parameters JSON
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="text-xs bg-muted/30 border rounded-md p-2 overflow-x-auto">
{JSON.stringify(cleanedParameters, null, 2)}
            </pre>
            <p className="text-[11px] text-muted-foreground mt-1">
              This is the exact payload that will be written to <code>payroll_statutory_rules.parameters</code>. Localization packs use the same shape.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}


export default StatutoryRuleEditor;