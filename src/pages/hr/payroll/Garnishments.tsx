/**
 * Legal Orders admin — manage `legal_orders_records`
 * (formerly `employee_garnishments`).
 *
 * Phase 2 (closed shallow gaps): status lifecycle, payee remittance,
 * document attachment, aggregate-cap exemption, per-order take-home floor,
 * audit-log + ledger drawers.
 */
import { useMemo, useState } from "react";
import { useGarnishments, useGarnishmentLifecycle, useResolvedGarnishmentKinds, useResolvedGarnishmentPolicy, type Garnishment, type GarnishmentKind, type GarnishmentCapRule, type GarnishmentStatus, type GarnishmentTransitionAction } from "@/hooks/useGarnishments";
import { useEmployees } from "@/hooks/useEmployees";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card, CardHeader, CardTitle, CardContent, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Scale, History, BookOpen, FileText, Workflow } from "lucide-react";
import { GarnishmentDashboard } from "@/components/payroll/GarnishmentDashboard";
import { AuthorityPicker } from "@/components/payroll/AuthorityPicker";
import { LegalOrderDocuments } from "@/components/payroll/LegalOrderDocuments";
import { useLegalOrder, useLegalOrders } from "@/hooks/useLegalOrders";
import { LinkRecipientDialog } from "@/components/hr/payroll/LinkRecipientDialog";

/**
 * Allowed FSM transitions per source status. Mirrors garnishment_transition()
 * in supabase migration P1. Keep in sync with the RPC.
 */
const ALLOWED_TRANSITIONS: Record<GarnishmentStatus, GarnishmentTransitionAction[]> = {
  draft: ["submit", "activate"],
  pending_approval: ["approve", "reject"],
  approved: ["activate"],
  active: ["suspend", "mark_satisfied", "release", "terminate_unsatisfied", "expire"],
  suspended: ["resume", "mark_satisfied", "release", "terminate_unsatisfied", "expire"],
  satisfied: [],
  released: [],
  expired: [],
  terminated_unsatisfied: [],
};

const ACTION_LABELS: Record<GarnishmentTransitionAction, string> = {
  submit: "Submit for approval",
  approve: "Approve",
  reject: "Reject",
  activate: "Activate",
  suspend: "Suspend",
  resume: "Resume",
  mark_satisfied: "Mark satisfied",
  release: "Release",
  expire: "Expire",
  terminate_unsatisfied: "Terminate (unsatisfied)",
  adjust_balance: "Adjust balance",
  attach_evidence: "Attach evidence",
  note: "Add note",
};

// Legacy fallback used only if the resolver returns no rows (e.g., during
// initial install before any pack/platform-default has been seeded for the org).
const FALLBACK_KINDS: GarnishmentKind[] = [
  "child_support", "tax_levy", "court_order", "student_loan",
  "creditor", "wage_assignment", "other",
];


const CAP_RULES: GarnishmentCapRule[] = [
  "fixed_amount", "percent_disposable", "lesser_of_fixed_or_pct",
];

const STATUS_VARIANT: Record<GarnishmentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  pending_approval: "secondary",
  approved: "secondary",
  active: "default",
  suspended: "secondary",
  satisfied: "outline",
  released: "outline",
  expired: "outline",
  terminated_unsatisfied: "destructive",
};

export default function GarnishmentsPage() {
  const { garnishments, isLoading, createGarnishment, updateGarnishment, deleteGarnishment, transitionGarnishment } = useGarnishments();
  const { data: resolvedKinds = [] } = useResolvedGarnishmentKinds();
  const { data: resolvedPolicy } = useResolvedGarnishmentPolicy();
  const kindOptions = resolvedKinds.length > 0
    ? resolvedKinds.map((k) => ({ value: k.kind, label: k.label || k.kind.replace(/_/g, " "), source: k.source }))
    : FALLBACK_KINDS.map((k) => ({ value: k, label: k.replace(/_/g, " "), source: "platform" as const }));
  const { employees } = useEmployees();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Garnishment | null>(null);
  const [historyFor, setHistoryFor] = useState<Garnishment | null>(null);
  const [ledgerFor, setLedgerFor] = useState<Garnishment | null>(null);
  const [lifecycleFor, setLifecycleFor] = useState<Garnishment | null>(null);
  const [linkContactFor, setLinkContactFor] = useState<Garnishment | null>(null);
  const qc = useQueryClient();

  const useAuthorityAsRecipient = async (orderId: string) => {
    const { error } = await (supabase as any).rpc(
      "legal_order_use_authority_as_recipient",
      { p_order_id: orderId },
    );
    if (error) {
      const msg = error.message ?? String(error);
      if (msg.includes("MERGE_REQUIRED")) {
        toast.error(
          "A different recipient is already linked to this authority — use \"click to link\" and pick that Contact instead.",
        );
      } else if (msg.includes("NO_AUTHORITY")) {
        toast.error("This order has no issuing authority set.");
      } else {
        toast.error(msg);
      }
      return;
    }
    toast.success("Issuing authority set as remittance recipient");
    qc.invalidateQueries({ queryKey: ["garnishments"] });
    qc.invalidateQueries({ queryKey: ["legal-orders"] });
    qc.invalidateQueries({ queryKey: ["legal-recipients"] });
  };

  const employeeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, `${e.first_name} ${e.last_name}`);
    return m;
  }, [employees]);

  // Resolved legal-order rows keyed by id — powers per-row compliance badges
  // (priority_class, always_first, evidence-missing) without a second query per row.
  const { data: legalOrderRows = [] } = useLegalOrders();
  const legalOrderById = useMemo(() => {
    const m = new Map<string, typeof legalOrderRows[number]>();
    for (const r of legalOrderRows) m.set(r.id, r);
    return m;
  }, [legalOrderRows]);
  const complianceCounts = useMemo(() => {
    let pending = 0, missingEvidence = 0, alwaysFirst = 0;
    for (const r of legalOrderRows) {
      if (r.status === "pending_approval") pending++;
      if ((r as any).priority_class === 1) alwaysFirst++;
      const req = (r.evidence_requirements as any)?.required_kinds;
      if (Array.isArray(req) && req.length > 0 && !r.document_url) missingEvidence++;
    }
    return { pending, missingEvidence, alwaysFirst };
  }, [legalOrderRows]);

  const empty = {
    employee_id: "",
    kind: "child_support" as GarnishmentKind,
    priority: 10,
    case_reference: "",
    authority_text: "",
    authority_id: null as string | null,
    authority_contact_id: null as string | null,
    cap_rule: "fixed_amount" as GarnishmentCapRule,
    fixed_amount: "",
    percent_of_disposable: "",
    total_owed: "",
    start_date: new Date().toISOString().slice(0, 10),
    end_date: "",
    status: "draft" as GarnishmentStatus,
    status_reason: "",
    payee_name: "",
    payee_account: "",
    payee_bank: "",
    payee_reference: "",
    document_url: "",
    document_filename: "",
    minimum_take_home_amount: "",
    aggregate_cap_exempt: false,
    notes: "",
  };
  const [form, setForm] = useState<typeof empty>(empty);
  // Resolved legal-order row (view) drives evidence gating in the docs panel.
  const { data: resolvedLegalOrder } = useLegalOrder(editing?.id ?? null);

  function openCreate() {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  }
  function openEdit(g: Garnishment) {
    setEditing(g);
    setForm({
      employee_id: g.employee_id,
      kind: g.kind,
      priority: g.priority,
      case_reference: g.case_reference ?? "",
      authority_text: "",
      authority_id: (g as any).authority_id ?? null,
      authority_contact_id: (g as any).authority_contact_id ?? null,
      fixed_amount: g.fixed_amount?.toString() ?? "",
      percent_of_disposable: g.percent_of_disposable?.toString() ?? "",
      total_owed: g.total_owed?.toString() ?? "",
      start_date: g.start_date,
      end_date: g.end_date ?? "",
      status: g.status ?? (g.is_active ? "active" : "suspended"),
      status_reason: g.status_reason ?? "",
      payee_name: g.payee_name ?? "",
      payee_account: g.payee_account ?? "",
      payee_bank: g.payee_bank ?? "",
      payee_reference: g.payee_reference ?? "",
      document_url: g.document_url ?? "",
      document_filename: g.document_filename ?? "",
      minimum_take_home_amount: g.minimum_take_home_amount?.toString() ?? "",
      aggregate_cap_exempt: !!g.aggregate_cap_exempt,
      notes: g.notes ?? "",
    });
    setOpen(true);
  }

  async function submit() {
    // Completion-rule gating (Step C, 2026-07-23): the resolved legal-order
    // kind determines which end-condition fields are mandatory. `by_date`
    // requires an end_date; `by_balance` (default) requires a total_owed.
    // `indefinite` / `manual_release_only` have no such requirement.
    const completionRule = (resolvedLegalOrder?.completion_rule as string | undefined) ?? null;
    if (completionRule === "until_end_date" && !form.end_date) {
      window.alert("This legal-order kind ends on a specific date — please set an End date before saving.");
      return;
    }
    if (completionRule === "until_total_owed_met" && !form.total_owed) {
      window.alert("This legal-order kind ends when a total is met — please set Total owed before saving.");
      return;
    }
    // Status is FSM-owned: never set directly here on existing rows.
    // New rows are created in 'draft' (DB default); status moves via transitionGarnishment.
    const base: any = {
      employee_id: form.employee_id,
      kind: form.kind,
      priority: form.priority,
      case_reference: form.case_reference || null,
      authority_id: form.authority_id,
      cap_rule: form.cap_rule,
      fixed_amount: form.fixed_amount ? Number(form.fixed_amount) : null,
      percent_of_disposable: form.percent_of_disposable ? Number(form.percent_of_disposable) : null,
      total_owed: form.total_owed ? Number(form.total_owed) : null,
      start_date: form.start_date,
      end_date: form.end_date || null,
      payee_name: form.payee_name || null,
      payee_account: form.payee_account || null,
      payee_bank: form.payee_bank || null,
      payee_reference: form.payee_reference || null,
      document_url: form.document_url || null,
      document_filename: form.document_filename || null,
      minimum_take_home_amount: form.minimum_take_home_amount ? Number(form.minimum_take_home_amount) : null,
      aggregate_cap_exempt: form.aggregate_cap_exempt,
      notes: form.notes || null,
    };
    if (editing) {
      await updateGarnishment.mutateAsync({ id: editing.id, patch: base });
    } else {
      await createGarnishment.mutateAsync({ ...base, status: "draft", is_active: false });
    }
    setOpen(false);
  }

  async function runAction(g: Garnishment, action: GarnishmentTransitionAction) {
    let reason: string | undefined;
    let evidence: string | undefined;
    if (action === "release") {
      if (!g.document_url) {
        evidence = window.prompt("Releasing an order requires evidence. Paste the release document URL:") || undefined;
        if (!evidence) return;
      }
      reason = window.prompt("Reason (e.g. 'court release 2026-06-10'):") || undefined;
    } else if (["suspend", "reject", "terminate_unsatisfied"].includes(action)) {
      reason = window.prompt(`Reason for ${action.replace(/_/g, " ")}:`) || undefined;
    }
    await transitionGarnishment.mutateAsync({
      id: g.id,
      action,
      reason_text: reason,
      evidence_url: evidence,
    });
  }

  return (
    <div className="space-y-4">
      <GarnishmentDashboard />
      {(complianceCounts.pending + complianceCounts.missingEvidence + complianceCounts.alwaysFirst) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span className="font-medium">Compliance:</span>
          {complianceCounts.pending > 0 && (
            <Badge variant="secondary" title="Orders awaiting a second approver (SoD).">
              {complianceCounts.pending} pending approval
            </Badge>
          )}
          {complianceCounts.missingEvidence > 0 && (
            <Badge variant="destructive" title="Orders whose resolved legal kind requires evidence that has not been attached.">
              {complianceCounts.missingEvidence} missing evidence
            </Badge>
          )}
          {complianceCounts.alwaysFirst > 0 && (
            <Badge variant="default" title="Statutory always-first orders (e.g. child support in many jurisdictions).">
              {complianceCounts.alwaysFirst} always-first
            </Badge>
          )}
        </div>
      )}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Scale className="h-5 w-5" /> Garnishments</CardTitle>
            <CardDescription>
              Court-ordered wage deductions. Engine enforces priority, per-order caps, organisation-wide
              aggregate cap (set in Payroll Settings) and a minimum take-home floor.
            </CardDescription>
          </div>
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Garnishment</Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : garnishments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No garnishments recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Pri</TableHead>
                  <TableHead>Cap</TableHead>
                  <TableHead>Owed / Paid</TableHead>
                  <TableHead>Payee</TableHead>
                  <TableHead>Window</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {garnishments.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>{employeeById.get(g.employee_id) ?? "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline">{g.kind.replace(/_/g, " ")}</Badge>
                        {g.aggregate_cap_exempt && (
                          <Badge variant="secondary" className="text-[10px]">cap-exempt</Badge>
                        )}
                        {(() => {
                          const lo = legalOrderById.get(g.id);
                          if (!lo) return null;
                          const req = (lo.evidence_requirements as any)?.required_kinds;
                          const evidenceMissing = Array.isArray(req) && req.length > 0 && !lo.document_url;
                          return (
                            <>
                              {lo.priority_class === 1 && (
                                <Badge variant="default" className="text-[10px]" title="Statutory always-first: pays before all other orders regardless of priority number.">always-first</Badge>
                              )}
                              {typeof lo.priority_class === "number" && lo.priority_class > 1 && (
                                <Badge variant="outline" className="text-[10px]" title="Statutory priority class from the resolved legal-behaviour pack.">class {lo.priority_class}</Badge>
                              )}
                              {evidenceMissing && (
                                <Badge variant="destructive" className="text-[10px]" title="Required evidence not yet attached — see the Evidence section in the editor.">no evidence</Badge>
                              )}
                              {lo.payee_unmapped && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => setLinkContactFor(g)}
                                    className="inline-flex"
                                    title="The third-party recipient (e.g. court, CSA, creditor) is stored as free text only. Click to pick a Contact and enable remittance payments. This is unrelated to PAYE tax."
                                  >
                                    <Badge variant="secondary" className="text-[10px] cursor-pointer hover:bg-secondary/70">
                                      recipient not linked — click to link
                                    </Badge>
                                  </button>
                                  {g.authority_id && (
                                    <button
                                      type="button"
                                      onClick={() => useAuthorityAsRecipient(g.id)}
                                      className="inline-flex"
                                      title="Use the issuing authority (court/agency) as the remittance recipient. The authority's linked Contact is stamped on the recipient and the order in one step, so accrual, statements, and bank-file generation are all ready — no separate Contact link needed."
                                    >
                                      <Badge variant="outline" className="text-[10px] cursor-pointer hover:bg-muted">
                                        use issuing authority as recipient
                                      </Badge>
                                    </button>
                                  )}
                                </>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>{g.priority}</TableCell>
                    <TableCell className="text-xs">
                      {g.cap_rule === "fixed_amount" && <>fixed {g.fixed_amount}</>}
                      {g.cap_rule === "percent_disposable" && <>{g.percent_of_disposable}% of disp.</>}
                      {g.cap_rule === "lesser_of_fixed_or_pct" && (
                        <>min({g.fixed_amount}, {g.percent_of_disposable}%)</>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {g.total_owed ?? "—"} / {g.total_paid}
                    </TableCell>
                    <TableCell className="text-xs">
                      {g.payee_name ? (
                        <div>
                          <div>{g.payee_name}</div>
                          {g.payee_account && <div className="text-muted-foreground">{g.payee_account}</div>}
                        </div>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {g.start_date} → {g.end_date ?? "open"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[g.status ?? (g.is_active ? "active" : "suspended")]}>
                        {g.status ?? (g.is_active ? "active" : "inactive")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {g.document_url && (
                        <Button size="sm" variant="ghost" asChild title="Open order document">
                          <a href={g.document_url} target="_blank" rel="noopener noreferrer">
                            <FileText className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setLedgerFor(g)} title="Payment ledger">
                        <BookOpen className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setHistoryFor(g)} title="Audit history">
                        <History className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setLifecycleFor(g)} title="Lifecycle & actions">
                        <Workflow className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(g)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm("Remove this garnishment? Engine history is preserved in the ledger.")) {
                            deleteGarnishment.mutate(g.id);
                          }
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Editor */}
      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit Garnishment" : "New Garnishment"}
        description="Court-ordered wage deduction. Engine enforces priority, per-order caps, the org aggregate cap and a minimum take-home floor."
        size="xl"
        preventAutoClose
        onAutoCloseAttempt={() => {
          // Enterprise form guard: outside-click / Esc must not silently
          // discard a legal order draft. Users close via Cancel/Save.
        }}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!form.employee_id}>
              {editing ? "Save changes" : "Create garnishment"}
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Order details" subtitle="Identity & priority of this garnishment order.">
          <WorkflowField label="Employee" required>
            <Select value={form.employee_id} onValueChange={(v) => setForm({ ...form, employee_id: v })}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Kind" hint={resolvedPolicy?.source_pack_id ? "Driven by your installed localization pack." : "Platform defaults — install a country pack for jurisdiction-specific kinds."}>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v as GarnishmentKind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {kindOptions.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label} {k.source === "pack" ? "(pack)" : k.source === "tenant" ? "(override)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>

              </Select>
            </WorkflowField>
            <WorkflowField label="Priority" hint="Lower priority runs first.">
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
            </WorkflowField>
            <WorkflowField label="Case reference">
              <Input value={form.case_reference} onChange={(e) => setForm({ ...form, case_reference: e.target.value })} />
            </WorkflowField>
            <WorkflowField label="Issuing authority" hint="Pick a curated authority to auto-populate payee defaults.">
              <AuthorityPicker
                value={form.authority_id}
                fallbackText={form.authority_text}
                onChange={({ authority_id, authority_text, picked }) =>
                  setForm({
                    ...form,
                    authority_id,
                    authority_text,
                    // Prefill payee defaults from the authority when the user hasn't set them.
                    payee_bank: form.payee_bank || picked?.default_payee_bank || "",
                    payee_account: form.payee_account || picked?.default_payee_account || "",
                  })
                }
              />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>

        <WorkflowSheetGrid>
          <WorkflowSheetSection number={2} title="Calculation" subtitle="How the deduction amount is computed each period.">
            {resolvedLegalOrder?.calc_model && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                Resolved calculation model from pack: <Badge variant="outline" className="text-[10px]">{String(resolvedLegalOrder.calc_model).replace(/_/g, " ")}</Badge>
                {typeof resolvedLegalOrder.priority_class === "number" && (
                  <span className="ml-2 text-muted-foreground">priority class {resolvedLegalOrder.priority_class}{resolvedLegalOrder.priority_class === 1 ? " (always-first)" : ""}</span>
                )}
              </div>
            )}
            <WorkflowField label="Cap rule">
              <Select value={form.cap_rule} onValueChange={(v) => setForm({ ...form, cap_rule: v as GarnishmentCapRule })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CAP_RULES.map((r) => <SelectItem key={r} value={r}>{r.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
            <div className="grid grid-cols-2 gap-3">
              {(form.cap_rule === "fixed_amount" || form.cap_rule === "lesser_of_fixed_or_pct") && (
                <WorkflowField label="Fixed amount" required={form.cap_rule === "fixed_amount"}>
                  <Input type="number" step="0.01" value={form.fixed_amount} onChange={(e) => setForm({ ...form, fixed_amount: e.target.value })} />
                </WorkflowField>
              )}
              {(form.cap_rule === "percent_disposable" || form.cap_rule === "lesser_of_fixed_or_pct") && (
                <WorkflowField label="% of disposable" hint="0.25 = 25%" required={form.cap_rule === "percent_disposable"}>
                  <Input type="number" step="0.0001" value={form.percent_of_disposable} onChange={(e) => setForm({ ...form, percent_of_disposable: e.target.value })} />
                </WorkflowField>
              )}
              <WorkflowField label="Total owed" hint="Order stops accruing once this cumulative amount has been withheld.">
                <Input type="number" step="0.01" value={form.total_owed} onChange={(e) => setForm({ ...form, total_owed: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Min take-home" hint="Per-order protected earnings floor (overrides org default when set).">
                <Input type="number" step="0.01" value={form.minimum_take_home_amount} onChange={(e) => setForm({ ...form, minimum_take_home_amount: e.target.value })} />
              </WorkflowField>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <Switch checked={form.aggregate_cap_exempt} onCheckedChange={(v) => setForm({ ...form, aggregate_cap_exempt: v })} />
              <Label className="!mt-0 text-xs">Exempt from aggregate cap (e.g. child support)</Label>
            </div>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={3} title="Effective window" subtitle="Start and optional end of garnishment.">
            {resolvedLegalOrder?.completion_rule && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                Completion rule: <Badge variant="outline" className="text-[10px]">{String(resolvedLegalOrder.completion_rule).replace(/_/g, " ")}</Badge>
                {resolvedLegalOrder.completion_rule === "until_end_date" && <span className="ml-2 text-muted-foreground">End date is required.</span>}
                {resolvedLegalOrder.completion_rule === "until_total_owed_met" && <span className="ml-2 text-muted-foreground">Total owed is required.</span>}
                {(resolvedLegalOrder.completion_rule === "manual_release_only" || resolvedLegalOrder.completion_rule === "until_authority_release") && (
                  <span className="ml-2 text-muted-foreground">Order runs until manually released — no end date needed.</span>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <WorkflowField label="Start date" required>
                <Input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </WorkflowField>
              <WorkflowField
                label="End date"
                required={resolvedLegalOrder?.completion_rule === "until_end_date"}
              >
                <Input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
              </WorkflowField>
            </div>
            {editing ? (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={STATUS_VARIANT[editing.status] ?? "outline"}>{editing.status}</Badge>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Status transitions are managed from the Lifecycle drawer (workflow icon in the row).
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                New orders start as <Badge variant="outline">draft</Badge>. Submit for approval or activate from the Lifecycle drawer once created.
              </p>
            )}
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetGrid>
          <WorkflowSheetSection number={4} title="Recipient & remittance" subtitle="Where the deducted amount is sent. This is the third party on the legal order (court, CSA, creditor) — not the tax authority.">
            <div className="grid grid-cols-2 gap-3">
              <WorkflowField label="Recipient name">
                <Input value={form.payee_name} onChange={(e) => setForm({ ...form, payee_name: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Recipient bank">
                <Input value={form.payee_bank} onChange={(e) => setForm({ ...form, payee_bank: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Recipient account">
                <Input value={form.payee_account} onChange={(e) => setForm({ ...form, payee_account: e.target.value })} />
              </WorkflowField>
              <WorkflowField label="Recipient reference">
                <Input value={form.payee_reference} onChange={(e) => setForm({ ...form, payee_reference: e.target.value })} />
              </WorkflowField>
            </div>
          </WorkflowSheetSection>

          <WorkflowSheetSection number={5} title="Evidence" subtitle="Versioned court order, amendments and release notices. Files live in the private legal-orders bucket.">
            <LegalOrderDocuments
              garnishmentId={editing?.id ?? null}
              evidenceRequirements={(resolvedLegalOrder?.evidence_requirements as any) ?? null}
            />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Legacy single-document link</summary>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <WorkflowField label="Document URL">
                  <Input value={form.document_url} onChange={(e) => setForm({ ...form, document_url: e.target.value })} placeholder="https://…" />
                </WorkflowField>
                <WorkflowField label="Document filename">
                  <Input value={form.document_filename} onChange={(e) => setForm({ ...form, document_filename: e.target.value })} />
                </WorkflowField>
              </div>
            </details>
          </WorkflowSheetSection>
        </WorkflowSheetGrid>

        <WorkflowSheetSection number={6} title="Notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Internal notes about this order…" />
        </WorkflowSheetSection>
      </WorkflowSheet>

      <LedgerSheet g={ledgerFor} onClose={() => setLedgerFor(null)} />
      <HistorySheet g={historyFor} onClose={() => setHistoryFor(null)} />
      <LifecycleSheet
        g={lifecycleFor}
        onClose={() => setLifecycleFor(null)}
        onAction={(action) => lifecycleFor && runAction(lifecycleFor, action)}
      />
      <LinkRecipientDialog
        open={!!linkContactFor}
        onOpenChange={(o) => !o && setLinkContactFor(null)}
        mode={
          linkContactFor
            ? {
                kind: "order",
                orderId: linkContactFor.id,
                orderLabel:
                  (linkContactFor.payee_name || linkContactFor.kind.replace(/_/g, " ")) +
                  ` (${employeeById.get(linkContactFor.employee_id) ?? "employee"})`,
              }
            : null
        }
      />
    </div>
  );
}

function LifecycleSheet({
  g,
  onClose,
  onAction,
}: {
  g: Garnishment | null;
  onClose: () => void;
  onAction: (action: GarnishmentTransitionAction) => void | Promise<void>;
}) {
  const { data: events = [], isLoading } = useGarnishmentLifecycle(g?.id ?? null);
  const allowed = g ? ALLOWED_TRANSITIONS[g.status] ?? [] : [];
  return (
    <Sheet open={!!g} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Order lifecycle</SheetTitle>
          <SheetDescription>
            Status-machine transitions. Every action writes an audited lifecycle event and enforces the allowed transitions defined in the database.
          </SheetDescription>
        </SheetHeader>
        {g && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Current status</span>
              <Badge variant={STATUS_VARIANT[g.status] ?? "outline"}>{g.status}</Badge>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Available actions</p>
              {allowed.length === 0 ? (
                <p className="text-sm text-muted-foreground">Terminal state — no further transitions.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allowed.map((a) => (
                    <Button key={a} size="sm" variant="outline" onClick={() => onAction(a)}>
                      {ACTION_LABELS[a]}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No lifecycle events yet.</p>
              ) : (
                <ol className="space-y-2 text-xs">
                  {events.map((e) => (
                    <li key={e.id} className="rounded border bg-muted/30 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{ACTION_LABELS[e.event] ?? e.event}</span>
                        <span className="text-muted-foreground">{new Date(e.effective_at).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {e.from_status ?? "∅"} → <Badge variant="outline" className="text-[10px]">{e.to_status}</Badge>
                        {e.reason_code && <span className="ml-2">[{e.reason_code}]</span>}
                      </div>
                      {e.reason_text && <div className="mt-1">{e.reason_text}</div>}
                      {e.evidence_document_url && (
                        <a className="mt-1 inline-block text-primary underline" href={e.evidence_document_url} target="_blank" rel="noopener noreferrer">
                          Evidence document
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function LedgerSheet({ g, onClose }: { g: Garnishment | null; onClose: () => void }) {
  const { data: lines = [], isLoading } = useQuery({
    queryKey: ["garnishment-ledger", g?.id],
    enabled: !!g?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("garnishment_ledger")
        .select("payment_date, pay_period_start, pay_period_end, amount, run_status")
        .eq("garnishment_id", g!.id)
        .order("pay_period_end", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  return (
    <Sheet open={!!g} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Payment ledger</SheetTitle>
          <SheetDescription>
            Every garnishment line cut for this order, derived live from posted payslips.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : lines.length === 0 ? <p className="text-sm text-muted-foreground">No payments yet.</p>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Paid on</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Run</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{l.pay_period_start} → {l.pay_period_end}</TableCell>
                      <TableCell className="text-xs">{l.payment_date ?? "—"}</TableCell>
                      <TableCell className="text-right">{Number(l.amount).toFixed(2)}</TableCell>
                      <TableCell><Badge variant="outline" className="text-[10px]">{l.run_status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HistorySheet({ g, onClose }: { g: Garnishment | null; onClose: () => void }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ["garnishment-audit", g?.id],
    enabled: !!g?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("garnishment_audit_log")
        .select("action, changed_at, changed_by, reason")
        .eq("garnishment_id", g!.id)
        .order("changed_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
  return (
    <Sheet open={!!g} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Audit history</SheetTitle>
          <SheetDescription>
            Every change to this garnishment — court orders are sensitive and every edit is logged.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
            : events.length === 0 ? <p className="text-sm text-muted-foreground">No events.</p>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{new Date(e.changed_at).toLocaleString()}</TableCell>
                      <TableCell><Badge variant="outline">{e.action}</Badge></TableCell>
                      <TableCell className="text-xs">{e.changed_by ? e.changed_by.slice(0, 8) : "system"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
