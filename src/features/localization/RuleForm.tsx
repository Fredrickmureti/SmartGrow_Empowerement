import { normalizeError } from "@/services/resilience";
/**
 * RuleForm — schema-driven editor for a single payroll/statutory rule.
 * Picks computation_kind first, then renders the matching JSON Schema
 * via SchemaForm and runs server-side validation before save.
 *
 * Mode:
 *   admin  — edits a row in `localization_pack_payroll_templates`
 *   tenant — edits an override row in `payroll_statutory_rules`
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { SchemaForm } from "./SchemaForm";
import { RuleSimulator } from "./components/RuleSimulator";
import { useRuleSchema, useRuleSchemas, validatePayload } from "./hooks";
import type { EditorMode } from "./types";

function shallowEqualArr(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Props {
  mode: EditorMode;
  initial: {
    rule_type: string;
    rule_name: string;
    parameters: any;
    description?: string | null;
  };
  onSave: (next: { rule_type: string; rule_name: string; parameters: any; description: string | null }) => Promise<void> | void;
  onCancel?: () => void;
}

export function RuleForm({ mode, initial, onSave, onCancel }: Props) {
  const { data: allSchemas } = useRuleSchemas();
  const [rule_type, setRuleType] = useState(initial.rule_type);
  const [rule_name, setRuleName] = useState(initial.rule_name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [parameters, setParameters] = useState<any>(initial.parameters ?? { type: "" });
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const computation_kind = parameters?.type;
  const { schema } = useRuleSchema(rule_type, computation_kind);
  const uiSchema = useMemo(() => {
    const ui = (schema as any)?.ui_schema;
    return ui && typeof ui === "object" ? ui : null;
  }, [schema]);

  const ruleTypeOptions = useMemo(
    () => Array.from(new Set((allSchemas ?? []).map((s) => s.rule_type))),
    [allSchemas]
  );
  const computationOptions = useMemo(
    () => (allSchemas ?? []).filter((s) => s.rule_type === rule_type).map((s) => s.computation_kind),
    [allSchemas, rule_type]
  );

  const validate = async () => {
    const r = await validatePayload({ kind: "rule", rule_type, parameters });
    setErrors((prev) => (shallowEqualArr(prev, r.errors) ? prev : r.errors));
    setWarnings((prev) => (shallowEqualArr(prev, r.warnings) ? prev : r.warnings));
    return r.valid;
  };

  // Debounced live validation. Use deferred parameters so React batches
  // keystrokes and the effect doesn't fire on every character (which used
  // to amplify the perceived "form reload" symptom).
  const deferredParams = useDeferredValue(parameters);
  const lastValidatedRef = useRef<string>("");
  useEffect(() => {
    if (!schema) {
      setErrors((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const key = JSON.stringify(deferredParams) + "::" + rule_type + "::" + (schema?.id ?? "");
    if (key === lastValidatedRef.current) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await validatePayload({ kind: "rule", rule_type, parameters: deferredParams });
        if (cancelled) return;
        lastValidatedRef.current = key;
        setErrors((prev) => (shallowEqualArr(prev, r.errors) ? prev : r.errors));
        setWarnings((prev) => (shallowEqualArr(prev, r.warnings) ? prev : r.warnings));
      } catch { /* ignore live errors */ }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [deferredParams, rule_type, schema?.id]);

  const handleSave = async () => {
    setBusy(true);
    try {
      const valid = await validate();
      if (!valid) { toast.error("Fix validation errors before saving"); return; }
      await onSave({ rule_type, rule_name, parameters, description: description || null });
      toast.success("Rule saved");
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  };

  // Group errors by JSON path for the "Required fields" summary chip rail.
  // Validator emits messages like "$.period: required property missing" — we
  // peel the leading "$." so we render human chips like "period" / "tiers[0].name".
  const errorByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of errors) {
      const idx = e.indexOf(":");
      if (idx <= 0) continue;
      const rawPath = e.slice(0, idx).trim();
      const path = rawPath.startsWith("$.") ? rawPath.slice(2) : rawPath === "$" ? "" : rawPath;
      m.set(path, e.slice(idx + 1).trim());
    }
    return m;
  }, [errors]);

  const focusField = (path: string) => {
    // SchemaForm tags each input with data-schema-path="$.something" so the
    // chip click jumps straight to the offending field instead of leaving
    // the user scanning a 14-field form.
    const target = document.querySelector<HTMLElement>(`[data-schema-path="$.${path}"]`)
                ?? document.querySelector<HTMLElement>(`[data-schema-path-prefix="$.${path}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    const focusable = target.matches("input,select,button,textarea")
      ? target
      : target.querySelector<HTMLElement>("input,select,button,textarea");
    focusable?.focus({ preventScroll: true });
  };

  const handleRuleTypeChange = (next: string) => {
    if (next === rule_type) return;
    const hasContent = parameters && typeof parameters === "object" && Object.keys(parameters).filter(k => k !== "type").length > 0;
    if (hasContent) {
      const proceed = window.confirm(
        `Changing rule type will reset the parameters of this rule (currently ${Object.keys(parameters).length} field(s)). Continue?`,
      );
      if (!proceed) return;
    }
    setRuleType(next);
    setParameters({ type: "" });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          {mode === "admin" ? "Pack template — Rule" : "Tenant override — Rule"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Rule type</Label>
            <Select value={rule_type} onValueChange={handleRuleTypeChange}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {ruleTypeOptions.map((rt) => <SelectItem key={rt} value={rt}>{rt}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Computation kind</Label>
            <Select
              value={computation_kind ?? ""}
              onValueChange={(v) => setParameters({ ...(parameters ?? {}), type: v })}
              disabled={!rule_type}
            >
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {computationOptions.map((ck) => <SelectItem key={ck} value={ck}>{ck}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Rule name</Label>
            <Input value={rule_name} onChange={(e) => setRuleName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        {/* Required-fields summary pinned above the form so the user
            can see — and click straight to — every offending field. */}
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="space-y-2">
              <div className="font-medium">
                Fix {errors.length} issue{errors.length === 1 ? "" : "s"} before saving:
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(errorByPath.entries()).map(([path, msg]) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => focusField(path)}
                    className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs hover:bg-destructive/20 transition"
                    title={msg}
                  >
                    <code className="font-mono">{path || "(root)"}</code>
                    <span className="opacity-70">— {msg}</span>
                  </button>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {schema ? (
          <div className="border-t pt-3 grid grid-cols-1 lg:grid-cols-[1fr_minmax(280px,360px)] gap-4">
            <SchemaForm schema={schema.json_schema ?? schema} value={parameters} onChange={setParameters} errors={errors} uiSchema={uiSchema} />
            <RuleSimulator rule_type={rule_type} parameters={parameters} />
          </div>
        ) : computation_kind ? (
          <Alert variant="default">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              No schema registered for <code>{rule_type}/{computation_kind}</code>. The payload will save as
              <code className="mx-1">legacy_unvalidated</code> and will not be enforced until a schema is added.
            </AlertDescription>
          </Alert>
        ) : null}

        {warnings.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
          <Button onClick={handleSave} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save rule
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
