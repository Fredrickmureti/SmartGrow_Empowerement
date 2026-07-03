/**
 * PayrollSalaryStructuresPage — minimal read-only structures + components.
 *
 * Intentionally thin: the engine reads structures via salary_structure_id
 * on contracts; this page lets payroll admins inspect what's defined.
 * Editing happens via the existing salary structure form (reachable from
 * Employees → Contract). No new business logic.
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";

import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Loader2, Trash2, History, UploadCloud, Lock, Network, AlertCircle } from "lucide-react";
import { SalaryRuleGraphEditor } from "@/components/payroll/SalaryRuleGraphEditor";
import { WorkflowSheet, WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useSalaryStructures } from "@/hooks/useSalaryStructures";
import { usePublishRuleSet, useRuleSetVersions } from "@/hooks/payroll/useSalaryRuleSets";
import { RuleSetComponentsTable } from "@/components/payroll/PayrollRuleSetPanel";


type ComponentDraft = {
  name: string;
  code: string;
  component_type: "earning" | "deduction" | "employer_contribution";
  computation_type: "fixed" | "percentage" | "formula";
  computation_value: number;
  percentage_of: string | null;
  formula: string;
  is_taxable: boolean;
};

const PERCENT_BASES = [
  { value: "BASIC", label: "Basic salary" },
  { value: "GROSS", label: "Gross pay" },
  { value: "TAXABLE", label: "Taxable income" },
];


export function PayrollSalaryStructuresPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { createStructure } = useSalaryStructures();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", code: "", description: "" });
  const [components, setComponents] = useState<ComponentDraft[]>([]);

  const addComponent = () =>
    setComponents((c) => [
      ...c,
      {
        name: "",
        code: "",
        component_type: "earning",
        computation_type: "fixed",
        computation_value: 0,
        percentage_of: null,
        formula: "",
        is_taxable: true,
      },
    ]);

  const patchComponent = (i: number, patch: Partial<ComponentDraft>) =>
    setComponents((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const componentValidation = useMemo(
    () =>
      components.map((c) => {
        if (!c.name.trim()) return "Name is required.";
        if (!c.code.trim()) return "Code is required.";
        if (c.computation_type === "percentage" && !c.percentage_of) {
          return "Select what the percentage applies to (Basic, Gross, Taxable).";
        }
        if (
          c.computation_type === "percentage" &&
          (c.computation_value <= 0 || c.computation_value > 100)
        ) {
          return "Percentage must be between 0 and 100.";
        }
        if (c.computation_type === "fixed" && c.computation_value < 0) {
          return "Amount cannot be negative.";
        }
        return null;
      }),
    [components],
  );


  const hasComponentErrors = componentValidation.some(Boolean);

  const handleCreate = async () => {
    if (!form.name.trim() || hasComponentErrors) return;
    try {
      await createStructure.mutateAsync({
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        description: form.description,
        components: components.map((c, i) => ({
          name: c.name,
          code: c.code,
          component_type: c.component_type,
          computation_type: c.computation_type,
          // For formula rows the value is stored as 0; the expression lives
          // in the `formula` / `amount_expression` column downstream.
          computation_value: c.computation_type === "formula" ? 0 : c.computation_value,
          percentage_of: c.computation_type === "percentage" ? c.percentage_of : null,
          formula: c.computation_type === "formula" ? c.formula.trim() : null,
          is_taxable: c.is_taxable,
          sort_order: i,
          is_active: true,
          is_statutory: false,
          statutory_rule_type: null,
        })),
      });
      // The mutation invalidates ["salary-structures"] (a different hook's
      // key). This page owns its own query — invalidate it explicitly so the
      // new row appears without a page refresh.
      queryClient.invalidateQueries({ queryKey: ["payroll-salary-structures"] });
      setShowCreate(false);
      setForm({ name: "", code: "", description: "" });
      setComponents([]);
    } catch {
      // onError already toasted the actionable message; keep the dialog open.
    }
  };


  const { data, isLoading } = useQuery({
    queryKey: ["payroll-salary-structures", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data: structures = [], error } = await supabase
        .from("salary_structures")
        .select("id, name, code, country_code, is_active, description")
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("name");
      if (error) throw error;
      const ids = (structures as any[]).map((s) => s.id);
      const { data: components = [] } = ids.length
        ? await supabase
            .from("salary_components")
            .select("structure_id, code, name, component_type, computation_type, computation_value, is_taxable, sort_order")
            .in("structure_id", ids)
            .order("sort_order")
        : { data: [] as any[] };
      const { data: ruleSets = [] } = ids.length
        ? await supabase
            .from("salary_structure_rule_sets" as any)
            .select("structure_id, version, status")
            .in("structure_id", ids)
        : { data: [] as any[] };
      const byStructure = new Map<string, any[]>();
      for (const c of components as any[]) {
        const arr = byStructure.get(c.structure_id) ?? [];
        arr.push(c);
        byStructure.set(c.structure_id, arr);
      }
      const ruleStats = new Map<string, { active_version: number | null; total: number }>();
      for (const rs of ruleSets as any[]) {
        const cur = ruleStats.get(rs.structure_id) ?? { active_version: null, total: 0 };
        cur.total += 1;
        if (rs.status === "active") cur.active_version = rs.version;
        ruleStats.set(rs.structure_id, cur);
      }
      return (structures as any[]).map((s) => ({
        ...s,
        components: byStructure.get(s.id) ?? [],
        active_version: ruleStats.get(s.id)?.active_version ?? null,
        version_count: ruleStats.get(s.id)?.total ?? 0,
      }));
    },
  });

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Salary Structures</h1>
          <p className="text-sm text-muted-foreground">Earnings & deduction rule sets referenced by employee contracts.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-1" />New Structure</Button>
      </div>
      {isLoading ? (
        <p className="text-sm">Loading…</p>
      ) : (data ?? []).length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">No salary structures defined yet.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {data!.map((s: any) => (
            <StructureCard key={s.id} structure={s} />
          ))}
        </div>
      )}

      <WorkflowSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Salary Structure"
        description="Define a reusable compensation structure with earnings and deduction components."
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!form.name || hasComponentErrors || createStructure.isPending}>
              {createStructure.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Create
            </Button>

          </>
        }
      >
        <WorkflowSheetGrid>
          <WorkflowSheetSection number={1} title="Identity">
            <WorkflowField label="Name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Standard package" />
            </WorkflowField>
            <WorkflowField label="Code">
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} placeholder="e.g. STD-001" />
            </WorkflowField>
          </WorkflowSheetSection>
          <WorkflowSheetSection number={2} title="Description">
            <WorkflowField label="Description">
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
            </WorkflowField>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>
        <WorkflowSheetSection
          number={3}
          title="Components"
          fullWidth
          right={
            <Button type="button" variant="outline" size="sm" onClick={addComponent}>
              <Plus className="h-3 w-3 mr-1" />Add
            </Button>
          }
        >
          {components.length === 0 && (
            <p className="text-xs text-muted-foreground">No components yet. Add earnings and deductions that make up this structure.</p>
          )}
          {components.map((c, i) => {
            const err = componentValidation[i];
            return (
              <div key={i} className="border rounded-lg p-3 space-y-2">
                <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
                  <Input
                    placeholder="Name"
                    value={c.name}
                    onChange={(e) => patchComponent(i, { name: e.target.value })}
                  />
                  <Input
                    placeholder="Code (e.g. HRA)"
                    value={c.code}
                    onChange={(e) => patchComponent(i, { code: e.target.value.toUpperCase() })}
                  />
                  <Select
                    value={c.component_type}
                    onValueChange={(v) => patchComponent(i, { component_type: v as ComponentDraft["component_type"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="earning">Earning</SelectItem>
                      <SelectItem value="deduction">Deduction</SelectItem>
                      <SelectItem value="employer_contribution">Employer Contribution</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-start gap-2">
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-[180px_1fr_1fr] flex-1 min-w-0">
                    <Select
                      value={c.computation_type}
                      onValueChange={(v) =>
                        patchComponent(i, {
                          computation_type: v as ComponentDraft["computation_type"],
                          // Reset value semantics when switching modes so a
                          // "50" carried over from Fixed doesn't silently
                          // become "50 %" of BASIC.
                          computation_value: 0,
                          percentage_of: v === "percentage" ? c.percentage_of ?? "BASIC" : null,
                          formula: v === "formula" ? c.formula : "",
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fixed">Fixed Amount</SelectItem>
                        <SelectItem value="percentage">Percentage of…</SelectItem>
                        <SelectItem value="formula">Formula</SelectItem>
                      </SelectContent>
                    </Select>

                    {c.computation_type === "fixed" && (
                      <>
                        <div className="relative">
                          <NumericInput
                            placeholder="0.00"
                            value={c.computation_value || null}
                            onValueChange={(n) => patchComponent(i, { computation_value: n ?? 0 })}
                          />
                        </div>
                        <div className="text-xs text-muted-foreground self-center">
                          Paid as a flat amount every period.
                        </div>
                      </>
                    )}

                    {c.computation_type === "percentage" && (
                      <>
                        <div className="relative">
                          <NumericInput
                            placeholder="0"
                            value={c.computation_value || null}
                            onValueChange={(n) => patchComponent(i, { computation_value: n ?? 0 })}
                          />
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                            %
                          </span>
                        </div>
                        <Select
                          value={c.percentage_of ?? undefined}
                          onValueChange={(v) => patchComponent(i, { percentage_of: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="of…" />
                          </SelectTrigger>
                          <SelectContent>
                            {PERCENT_BASES.map((b) => (
                              <SelectItem key={b.value} value={b.value}>
                                {b.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </>
                    )}

                    {c.computation_type === "formula" && (
                      <div className="sm:col-span-2">
                        <Textarea
                          placeholder="e.g. min(GROSS * 0.05, 15000)"
                          value={c.formula}
                          onChange={(e) => patchComponent(i, { formula: e.target.value })}
                          rows={2}
                          className="font-mono text-xs"
                        />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Expressions may reference BASIC, GROSS, TAXABLE and other component codes. Helpers: min, max, round, if.
                        </p>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>

                {err && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {err}
                  </div>
                )}
              </div>
            );
          })}

        </WorkflowSheetSection>
      </WorkflowSheet>
    </div>
  );
}

interface StructureCardProps {
  structure: {
    id: string;
    name: string;
    code: string | null;
    country_code: string | null;
    is_active: boolean;
    components: any[];
    active_version: number | null;
    version_count: number;
  };
}

function StructureCard({ structure: s }: StructureCardProps) {
  const [showVersions, setShowVersions] = useState(false);
  const [showRuleGraph, setShowRuleGraph] = useState(false);
  const publish = usePublishRuleSet();
  const versions = useRuleSetVersions(showVersions ? s.id : undefined);
  const [expandedVersionId, setExpandedVersionId] = useState<string | null>(null);
  const isFrozen = s.version_count > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 gap-3">
        <div className="min-w-0">
          <CardTitle className="text-base flex items-center gap-2">
            {s.name}
            {isFrozen && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Components are frozen — published rule sets exist">
                <Lock className="h-3 w-3" /> frozen
              </span>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {s.code || "—"}{s.country_code ? ` · ${s.country_code}` : ""}
            {s.active_version != null && <> · active v{s.active_version}</>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={s.is_active ? "outline" : "secondary"}>{s.is_active ? "Active" : "Inactive"}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRuleGraph(true)}
            title="Edit Odoo-style rule graph (engine v2)"
          >
            <Network className="h-4 w-4 mr-1" />
            Rule graph
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowVersions(true)}
            disabled={s.version_count === 0}
            title={s.version_count === 0 ? "No versions published yet" : "View version history"}
          >
            <History className="h-4 w-4 mr-1" />
            Versions{s.version_count > 0 ? ` (${s.version_count})` : ""}
          </Button>
          <Button
            size="sm"
            onClick={() => publish.mutate({ structureId: s.id })}
            disabled={publish.isPending || s.components.length === 0}
            title={s.components.length === 0 ? "Add components first" : "Publish a new immutable version"}
          >
            {publish.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <UploadCloud className="h-4 w-4 mr-1" />}
            Publish version
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>Name</TableHead>
              <TableHead>Type</TableHead><TableHead>Computation</TableHead>
              <TableHead className="text-right">Value</TableHead><TableHead>Taxable</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.components.map((c: any) => (
              <TableRow key={c.code}>
                <TableCell className="font-mono text-xs">{c.code}</TableCell>
                <TableCell>{c.name}</TableCell>
                <TableCell><Badge variant="outline">{c.component_type}</Badge></TableCell>
                <TableCell className="text-xs">{c.computation_type}</TableCell>
                <TableCell className="text-right">{c.computation_value ?? "—"}</TableCell>
                <TableCell>{c.is_taxable ? "Yes" : "No"}</TableCell>
              </TableRow>
            ))}
            {s.components.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-4">No components.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Sheet open={showVersions} onOpenChange={setShowVersions}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{s.name} — Version history</SheetTitle>
            <SheetDescription>
              Each published version is an immutable snapshot of this structure's components. Past payslips remain locked to the version they were computed against.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {versions.isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
            )}
            {!versions.isLoading && (versions.data ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No versions published yet.</p>
            )}
            {(versions.data ?? []).map((v) => (
              <Card key={v.id}>
                <CardHeader
                  className="flex flex-row items-center justify-between space-y-0 cursor-pointer p-3"
                  onClick={() => setExpandedVersionId(expandedVersionId === v.id ? null : v.id)}
                >
                  <div>
                    <CardTitle className="text-sm">v{v.version} <span className="text-muted-foreground font-mono font-normal text-xs ml-1">{v.rule_hash.slice(0, 8)}</span></CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      effective {v.effective_from}
                      {v.effective_to ? ` → ${v.effective_to}` : ""} · {v.components.length} component{v.components.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Badge variant={v.status === "active" ? "outline" : "secondary"}>{v.status}</Badge>
                </CardHeader>
                {expandedVersionId === v.id && (
                  <CardContent className="p-0 border-t">
                    <RuleSetComponentsTable components={v.components} />
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {showRuleGraph && (
        <SalaryRuleGraphEditor
          open={showRuleGraph}
          onOpenChange={setShowRuleGraph}
          structureId={s.id}
          structureName={s.name}
        />
      )}
    </Card>
  );
}
