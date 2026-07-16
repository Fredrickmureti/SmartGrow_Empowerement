/**
 * PackEntityTabs — admin/tenant editing surface for a pack's child rows.
 *
 * Splits the pack into editable entity groups:
 *   - Rules        → localization_pack_payroll_templates  (admin)
 *                    payroll_statutory_rules               (tenant override)
 *   - Templates    → localization_pack_certificate_templates
 *                    localization_pack_return_templates
 *   - Reference    → tax / account / remittance master rows
 *                    (admin = full structured CRUD; tenant = read-only,
 *                    overrides happen via per-org tables not master rows)
 *
 * Every save round-trips through the existing schema/template validators
 * before touching the DB so corruption can't enter via the UI.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { LocalizationFormShell } from "./_shared/LocalizationFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, FileText, Calculator, BookOpen, Clock, Trash2, ShieldCheck, Tag } from "lucide-react";
import { toast } from "sonner";
import { RuleForm } from "../RuleForm";
import { ReturnTemplateEditor } from "./ReturnTemplateEditor";
import { CertificateTemplateEditor } from "./CertificateTemplateEditor";
import { TaxTemplatesEditor } from "./reference/TaxTemplatesEditor";
import { AccountTemplatesEditor } from "./reference/AccountTemplatesEditor";
import { RemittanceSchedulesEditor } from "./reference/RemittanceSchedulesEditor";
import { RuleHistoryDialog } from "./RuleHistoryDialog";
import { PublisherGovernanceEditor } from "./PublisherGovernanceEditor";
import { TokenRegistryEditor } from "./TokenRegistryEditor";
import { GarnishmentsEditor } from "./GarnishmentsEditor";
import { BankExportTemplatesEditor } from "./BankExportTemplatesEditor";
import { StatutoryAuthoritiesEditor } from "./StatutoryAuthoritiesEditor";
import { PackRequirementsEditor } from "./PackRequirementsEditor";
import type { EditorMode } from "../types";


interface Props {
  mode: EditorMode;
  packId: string;
}

type RuleRow = {
  id: string;
  pack_id: string;
  rule_type: string;
  rule_name: string;
  computation_method: string | null;
  parameters: any;
  description: string | null;
  sort_order: number | null;
};

type TemplateRow = {
  id: string;
  pack_id: string;
  code: string;
  display_name: string;
  description: string | null;
  body: any;
  layout: string | null;
  // First-class return-template metadata (Slice A). Present on
  // `localization_pack_return_templates`; absent for certificates.
  authority_id?: string | null;
  legal_reference?: string | null;
  regulation_citation?: string | null;
  effective_date?: string | null;
  sunset_date?: string | null;
  submission_channel?: string | null;
  submission_format?: any;
  digital_signature_spec?: any;
  acknowledgement_spec?: any;
  api_endpoint_spec?: any;
  approval_required?: boolean | null;
  // Certificate-only legal metadata (ADR 0060).
  revision_notes?: string | null;
  issued_to?: "employee" | "employer" | "both" | null;
};


// Templates that carry a JSONB `body` and are token-rendered.
const TEMPLATE_TABLES = [
  { table: "localization_pack_certificate_templates", label: "Certificates" },
  { table: "localization_pack_return_templates", label: "Returns" },
] as const;

export function PackEntityTabs({ mode, packId }: Props) {
  return (
    <Tabs defaultValue="rules">
      <TabsList>
        <TabsTrigger value="rules"><Calculator className="h-3.5 w-3.5 mr-1" />Rules</TabsTrigger>
        <TabsTrigger value="templates"><FileText className="h-3.5 w-3.5 mr-1" />Templates</TabsTrigger>
        <TabsTrigger value="reference"><BookOpen className="h-3.5 w-3.5 mr-1" />Reference data</TabsTrigger>
        {mode === "admin" && (
          <>
            <TabsTrigger value="tokens"><Tag className="h-3.5 w-3.5 mr-1" />Tokens</TabsTrigger>
            <TabsTrigger value="governance"><ShieldCheck className="h-3.5 w-3.5 mr-1" />Governance</TabsTrigger>
          </>
        )}
      </TabsList>

      <TabsContent value="rules" className="pt-3">
        <RulesTab mode={mode} packId={packId} />
      </TabsContent>

      <TabsContent value="templates" className="pt-3">
        <Accordion type="multiple" className="space-y-2">
          {TEMPLATE_TABLES.map((t) => (
            <AccordionItem
              key={t.table}
              value={t.table}
              className="border rounded-lg bg-card data-[state=open]:shadow-sm"
            >
              <AccordionTrigger className="px-4 py-3 hover:no-underline">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  {t.label}
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-4 pb-4 pt-0">
                <TemplatesTable mode={mode} packId={packId} table={t.table} label={t.label} embedded />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </TabsContent>

      <TabsContent value="reference" className="pt-3 space-y-3">
        {mode === "tenant" && (
          <div className="text-xs text-muted-foreground border rounded-md px-3 py-2 bg-muted/40">
            Reference data is managed at the platform level. To override these for your business, use the
            corresponding settings page (Chart of Accounts, Tax Rates, Remittance settings).
          </div>
        )}
        <Accordion type="multiple" className="space-y-2">
          <AccordionItem value="tax" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="flex items-center gap-2 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                Tax templates
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 pt-0">
              <TaxTemplatesEditor packId={packId} readOnly={mode === "tenant"} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="accounts" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="flex items-center gap-2 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                Account templates
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 pt-0">
              <AccountTemplatesEditor packId={packId} readOnly={mode === "tenant"} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="remittance" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
            <AccordionTrigger className="px-4 py-3 hover:no-underline">
              <span className="flex items-center gap-2 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                Remittance schedules
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-4 pt-0">
              <RemittanceSchedulesEditor packId={packId} readOnly={mode === "tenant"} />
            </AccordionContent>
          </AccordionItem>
          {mode === "admin" && (
            <>
              <AccordionItem value="garnishments" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    Garnishments
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-0">
                  <GarnishmentsEditor packId={packId} />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="bank-exports" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    Bank export templates
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-0">
                  <BankExportTemplatesEditor packId={packId} />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="authorities" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    Statutory authorities
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-0">
                  <StatutoryAuthoritiesEditor packId={packId} />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="requirements" className="border rounded-lg bg-card data-[state=open]:shadow-sm">
                <AccordionTrigger className="px-4 py-3 hover:no-underline">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    Onboarding &amp; payroll requirements
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 pt-0">
                  <PackRequirementsEditor packId={packId} />
                </AccordionContent>
              </AccordionItem>
            </>
          )}
        </Accordion>
      </TabsContent>


      {mode === "admin" && (
        <>
          <TabsContent value="tokens" className="pt-3">
            <TokenRegistryEditor packId={packId} />
          </TabsContent>
          <TabsContent value="governance" className="pt-3">
            <PublisherGovernanceEditor packId={packId} />
          </TabsContent>
        </>
      )}

    </Tabs>
  );
}

// ── Rules ─────────────────────────────────────────────────────────────────

function RulesTab({ mode, packId }: { mode: EditorMode; packId: string }) {
  const qc = useQueryClient();
  // Admin edits the pack template rows; tenant edits its own org's overrides.
  const table = mode === "admin" ? "localization_pack_payroll_templates" : "payroll_statutory_rules";

  const { data: rules, isLoading } = useQuery({
    queryKey: ["pack-rules", table, packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(table)
        .select("*")
        .eq("pack_id", packId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("rule_name");
      if (error) throw error;
      return (data ?? []) as RuleRow[];
    },
  });

  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);
  const [historyFor, setHistoryFor] = useState<{ code: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<RuleRow | null>(null);

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-rules", table, packId] });
      qc.invalidateQueries({ queryKey: ["pack-health", packId] });
      toast.success("Rule deleted");
      setDeleting(null);
    },
    onError: (e: any) => toast.error(e?.message || "Could not delete rule"),
  });

  const upsert = useMutation({
    mutationFn: async (input: { id?: string; rule_type: string; rule_name: string; parameters: any; description: string | null }) => {
      if (input.id) {
        const { error } = await (supabase as any).from(table).update({
          rule_type: input.rule_type,
          rule_name: input.rule_name,
          parameters: input.parameters,
          description: input.description,
        }).eq("id", input.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from(table).insert({
          pack_id: packId,
          rule_type: input.rule_type,
          rule_name: input.rule_name,
          parameters: input.parameters,
          description: input.description,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-rules", table, packId] });
      qc.invalidateQueries({ queryKey: ["pack-health", packId] });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">{mode === "admin" ? "Pack rules" : "Rule overrides"}</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5 mr-1" />New rule
        </Button>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (rules ?? []).length === 0 && (
          <div className="text-muted-foreground">No rules yet.</div>
        )}
        {(rules ?? []).map((r) => (
          <div key={r.id} className="flex items-center justify-between border-b last:border-0 py-1.5">
            <div className="min-w-0">
              <div className="font-medium truncate">{r.rule_name}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{r.rule_type}</Badge>
                {r.computation_method && <span>{r.computation_method}</span>}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                title="View history"
                onClick={() => setHistoryFor({ code: (r as any).rule_code ?? r.rule_name, name: r.rule_name })}
              >
                <Clock className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" title="Edit" onClick={() => setEditing(r)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleting(r)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      <LocalizationFormShell
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        entity="rule"
        mode={editing === "new" ? "create" : "edit"}
        title={editing === "new" || !editing ? "New rule" : `Edit rule — ${editing.rule_name}`}
        hideFooter
      >
        {editing && (
          <RuleForm
            mode={mode}
            initial={editing === "new"
              ? { rule_type: "", rule_name: "", parameters: { type: "" }, description: "" }
              : {
                  rule_type: editing.rule_type,
                  rule_name: editing.rule_name,
                  parameters: editing.parameters ?? { type: "" },
                  description: editing.description ?? "",
                }}
            onCancel={() => setEditing(null)}
            onSave={async (next) => {
              await upsert.mutateAsync({
                id: editing === "new" ? undefined : editing.id,
                ...next,
              });
              setEditing(null);
              toast.success("Saved");
            }}
          />
        )}
      </LocalizationFormShell>

      {historyFor && (
        <RuleHistoryDialog
          open={!!historyFor}
          onOpenChange={(o) => !o && setHistoryFor(null)}
          packId={packId}
          ruleCode={historyFor.code}
          ruleName={historyFor.name}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule {deleting?.rule_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the {mode === "admin" ? "pack rule template" : "rule override"}.
              Organizations that installed this pack will no longer get this rule on re-install
              and will need to reseed if they want it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); if (deleting) remove.mutate(deleting.id); }}
              disabled={remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── Templates with body ───────────────────────────────────────────────────

function TemplatesTable({ mode, packId, table, label, embedded = false }: { mode: EditorMode; packId: string; table: string; label: string; embedded?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["pack-templates", table, packId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from(table).select("*").eq("pack_id", packId).order("sort_order").order("display_name");
      if (error) throw error;
      return (data ?? []) as TemplateRow[];
    },
  });

  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pack-templates", table, packId] });
      toast.success("Template deleted");
      setDeleting(null);
    },
    onError: (e: any) => toast.error(e?.message || "Could not delete template"),
  });

  const update = useMutation({
    mutationFn: async (input: { id: string; body: any; layout: string | null; metadata?: Record<string, any> }) => {
      const patch: Record<string, any> = {
        body: input.body,
        layout: input.layout,
      };
      if (input.metadata) {
        // Only the columns first-class-promoted in Slice A. Unknown
        // fields are ignored so the editor can ship before the column
        // exists on a given table (e.g. certificates).
        for (const k of [
          "authority_id", "legal_reference", "regulation_citation",
          "effective_date", "sunset_date", "submission_channel",
          "submission_format", "digital_signature_spec",
          "acknowledgement_spec", "api_endpoint_spec", "approval_required",
          // Certificate-specific first-class metadata (ADR 0060).
          "revision_notes", "issued_to",
          // Pack-declared exports (ADR 0060 v2026.5.0 — migration 20260711232041).
          "outputs",
        ]) {
          if (k in input.metadata) patch[k] = (input.metadata as any)[k];
        }
      }
      const { error } = await (supabase as any).from(table).update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pack-templates", table, packId] }),
  });


  const create = useMutation({
    mutationFn: async (input: Record<string, any>) => {
      const { data, error } = await (supabase as any)
        .from(table)
        .insert({ pack_id: packId, ...input })
        .select("*")
        .single();
      if (error) throw error;
      return data as TemplateRow;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["pack-templates", table, packId] });
      toast.success("Template created");
      setCreating(false);
      setEditing(row); // jump straight into the body editor
    },
    onError: (e: any) => toast.error(e?.message || "Could not create template"),
  });

  const isReturns = table === "localization_pack_return_templates";
  const canCreate = mode === "admin";

  const body = (
    <>
      {!embedded && (
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">{label}</CardTitle>
          {canCreate && (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />New {isReturns ? "return" : "certificate"}
            </Button>
          )}
        </CardHeader>
      )}
      {embedded && canCreate && (
        <div className="flex justify-end mb-2">
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />New {isReturns ? "return" : "certificate"}
          </Button>
        </div>
      )}
      <div className={embedded ? "space-y-1 text-sm" : ""}>
        {!embedded ? (
          <CardContent className="space-y-1 text-sm">
            {renderRows()}
          </CardContent>
        ) : (
          renderRows()
        )}
      </div>
    </>
  );

  function renderRows() {
    return (
      <>
        {isLoading && <div className="text-muted-foreground">Loading…</div>}
        {!isLoading && (rows ?? []).length === 0 && (
          <div className="text-muted-foreground">No templates yet.</div>
        )}
        {(rows ?? []).map((r) => (
          <div key={r.id} className="flex items-center justify-between border-b last:border-0 py-1.5">
            <div className="min-w-0">
              <div className="font-medium truncate">{r.display_name}</div>
              <div className="text-xs text-muted-foreground"><code>{r.code}</code></div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                title="Edit"
                onClick={() => {
                  // Certificate + Return templates open on dedicated
                  // full-page routes — both are heavy authoring surfaces
                  // that need the whole viewport, not a right-side
                  // drawer. Tenant edits still open in the Sheet until
                  // tenant override routes land.
                  if (mode === "admin" && table === "localization_pack_certificate_templates") {
                    navigate(
                      `/admin-management/localization-packs/${packId}/certificates/${r.id}/edit`,
                    );
                    return;
                  }
                  if (mode === "admin" && table === "localization_pack_return_templates") {
                    navigate(
                      `/admin-management/localization-packs/${packId}/returns/${r.id}/edit`,
                    );
                    return;
                  }
                  setEditing(r);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleting(r)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      {embedded ? body : <Card>{body}</Card>}



      <LocalizationFormShell
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        entity="template"
        mode="edit"
        title={`Edit template${editing ? ` — ${editing.display_name}` : ""}`}
        // Certificate authoring is a design-driven surface — full viewport,
        // never a right-side drawer split three ways. Return templates keep
        // the wider drawer until they migrate to the same shell.
        size={table === "localization_pack_certificate_templates" ? "full" : undefined}
        hideFooter
      >
        {editing && (table === "localization_pack_return_templates" ? (
          <ReturnTemplateEditor
            mode={mode}
            packId={packId}
            templateCode={editing.code}
            initial={{
              template_code: editing.code,
              body: editing.body,
              layout: editing.layout,
              notes: null,
              // Slice B: surface first-class metadata to the publisher
              // editor when admin. Tenant mode ignores `metadata`
              // (operational-only overrides land in Slice C).
              metadata: mode === "admin" ? {
                authority_id: editing.authority_id ?? null,
                legal_reference: editing.legal_reference ?? null,
                regulation_citation: editing.regulation_citation ?? null,
                effective_date: editing.effective_date ?? null,
                sunset_date: editing.sunset_date ?? null,
                submission_channel: editing.submission_channel ?? null,
                submission_format: editing.submission_format ?? null,
                digital_signature_spec: editing.digital_signature_spec ?? null,
                acknowledgement_spec: editing.acknowledgement_spec ?? null,
                api_endpoint_spec: editing.api_endpoint_spec ?? null,
                approval_required: !!editing.approval_required,
                outputs: (editing as any).outputs ?? null,
              } : undefined,
            }}
            onCancel={() => setEditing(null)}
            onSave={async (next) => {
              await update.mutateAsync({
                id: editing.id,
                body: next.body,
                layout: next.layout,
                metadata: next.metadata as any,
              });
              setEditing(null);
              toast.success("Template saved");
            }}
          />

        ) : (
          <CertificateTemplateEditor
            mode={mode}
            packId={packId}
            templateCode={editing.code}
            initial={{
              template_code: editing.code,
              body: editing.body,
              layout: editing.layout,
              notes: null,
              // ADR 0060: surface first-class certificate metadata to
              // publisher editor in admin mode. Tenant overrides don't
              // touch legal metadata (immutable, mirrors returns).
              metadata: mode === "admin" ? {
                authority_id: editing.authority_id ?? null,
                legal_reference: editing.legal_reference ?? null,
                regulation_citation: editing.regulation_citation ?? null,
                effective_date: editing.effective_date ?? null,
                sunset_date: editing.sunset_date ?? null,
                revision_notes: editing.revision_notes ?? null,
                issued_to: editing.issued_to ?? "employee",
                approval_required: !!editing.approval_required,
                outputs: (editing as any).outputs ?? null,
              } : undefined,
            }}
            onCancel={() => setEditing(null)}
            onSave={async (next) => {
              await update.mutateAsync({
                id: editing.id,
                body: next.body,
                layout: next.layout,
                metadata: next.metadata as any,
              });
              setEditing(null);
              toast.success("Template saved");
            }}
          />
        ))}
      </LocalizationFormShell>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template {deleting?.display_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the template body and layout. Code: <code>{deleting?.code}</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); if (deleting) remove.mutate(deleting.id); }}
              disabled={remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CreateTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        kind={isReturns ? "return" : "certificate"}
        busy={create.isPending}
        onSubmit={(values) => create.mutate(values)}
      />
    </>

  );
}

// ── Create-template dialog ────────────────────────────────────────────────

function CreateTemplateDialog({
  open, onOpenChange, kind, busy, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: "certificate" | "return";
  busy: boolean;
  onSubmit: (values: Record<string, any>) => void;
}) {
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [period, setPeriod] = useState("annual");
  const [dueDay, setDueDay] = useState<string>("");
  const [dueMonthOffset, setDueMonthOffset] = useState<string>("");
  const [layout, setLayout] = useState("default");
  const [authority, setAuthority] = useState("");
  const [output, setOutput] = useState("pdf");

  useEffect(() => {
    if (open) {
      setCode(""); setDisplayName(""); setDescription("");
      setPeriod(kind === "certificate" ? "annual" : "monthly");
      setDueDay(""); setDueMonthOffset(""); setLayout("default");
      setAuthority(""); setOutput("pdf");
    }
  }, [open, kind]);

  const codeOk = /^[a-z0-9][a-z0-9_\-\.]{1,63}$/i.test(code);
  const canSubmit = codeOk && displayName.trim().length > 0 && !busy;

  const handle = () => {
    const base: Record<string, any> = {
      code: code.trim(),
      display_name: displayName.trim(),
      description: description.trim() || null,
      period,
      layout: layout || "default",
      due_day: dueDay ? Number(dueDay) : null,
      due_month_offset: dueMonthOffset ? Number(dueMonthOffset) : null,
      body: { blocks: [
        { id: "header", kind: "header", title: "Header", content: "" },
        { id: "body", kind: "body", title: "Body", content: "" },
        { id: "totals", kind: "totals", title: "Totals", content: "" },
        { id: "signature", kind: "signature", title: "Signature", content: "" },
      ]},
    };
    if (kind === "return") {
      base.authority_name = authority.trim() || null;
      // ADR 0060 — write the pack-declared exports array. The legacy
      // scalar `output` column was dropped 2026-07-12.
      base.outputs = [{ format: output, role: "primary" }];
    }
    onSubmit(base);
  };

  const label = kind === "certificate" ? "certificate" : "statutory return";

  return (
    <LocalizationFormShell
      open={open}
      onOpenChange={onOpenChange}
      entity={kind === "certificate" ? "certificate" : "return"}
      mode="create"
      title={`New ${label}`}
      description={`Define the ${label}'s metadata. After saving you'll be taken into the body editor to design the layout using tokens. Anything country-specific (e.g. P9 in Kenya, W-2 in the US, P60 in the UK) is just a code + display name here — the engine is country-agnostic.`}
      busy={busy}
      submitDisabled={!canSubmit}
      submitLabel="Create & design body"
      onSubmit={handle}
    >
      <WorkflowSheetSection number={1} title="Identity" subtitle="Code is the stable identifier used by the engine; display name is what users see.">
        <WorkflowSheetGrid>
          <WorkflowField label="Code" required hint={code && !codeOk ? "Letters, digits, underscore, hyphen or dot (2–64 chars)." : undefined}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={kind === "certificate" ? "e.g. p9, w2, p60" : "e.g. paye_monthly, vat_return"}
            />
          </WorkflowField>
          <WorkflowField label="Display name" required>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={kind === "certificate" ? "e.g. Tax Deduction Card (P9)" : "e.g. PAYE Monthly Return"}
            />
          </WorkflowField>
          <WorkflowField label="Description" className="lg:col-span-2">
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this issued for, and to whom?"
            />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Cadence & layout" subtitle="When this is issued and which layout template the renderer should use.">
        <WorkflowSheetGrid columns={4}>
          <WorkflowField label="Period">
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="annual">Annual</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="adhoc">Ad-hoc / on demand</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowField label="Layout">
            <Input value={layout} onChange={(e) => setLayout(e.target.value)} placeholder="default" />
          </WorkflowField>
          <WorkflowField label="Due day" hint="Day of month, 1–31.">
            <Input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="e.g. 9" />
          </WorkflowField>
          <WorkflowField label="Due month offset" hint="Months after period end.">
            <Input type="number" min={0} max={12} value={dueMonthOffset} onChange={(e) => setDueMonthOffset(e.target.value)} placeholder="e.g. 1" />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      {kind === "return" && (
        <WorkflowSheetSection number={3} title="Filing" subtitle="Who this return is filed with and in what format.">
          <WorkflowSheetGrid>
            <WorkflowField label="Authority">
              <Input value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. KRA, HMRC, IRS" />
            </WorkflowField>
            <WorkflowField label="Output format">
              <Select value={output} onValueChange={setOutput}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pdf">PDF</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="xml">XML</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
      )}
    </LocalizationFormShell>
  );
}

// (Round 8 removed the read-only ReferenceList — Round 10 deleted the dead helper.)
