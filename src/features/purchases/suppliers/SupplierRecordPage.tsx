/**
 * SupplierRecordPage — Supplier 360 workbench.
 *
 * Enterprise record page for a supplier. Aggregates the full P1 view:
 *   • Overview + procurement defaults
 *   • Qualification cycles (lifecycle RPCs: submit / approve / reject)
 *   • Compliance checks (sanctions, tax, banking)
 *   • Bank accounts (with verification state)
 *   • Contracts (P2) and requisitions (P3) linked to this supplier
 *   • Purchase order + bill history (via legacy contact FK)
 *
 * All state transitions route through P1 SECURITY DEFINER RPCs so the
 * business_event_outbox stays authoritative. UI never writes lifecycle
 * columns directly.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  PauseCircle,
  PlayCircle,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import {
  PageBody,
  PageHeader,
  ActionBar,
  Section,
  StatusBadge,
  LoadingState,
  ErrorState,
  EmptyState,
  FieldGrid,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useSupplierRecord } from "./useSupplierRecord";
import { ContactCustomFieldsPanel } from "./ContactCustomFieldsPanel";
import {
  approveSupplierQualification,
  rejectSupplierQualification,
  reinstateSupplier,
  submitSupplierQualification,
  suspendSupplier,
} from "./supplierRpcs";


const LIFECYCLE_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  qualifying: "info",
  approved: "success",
  suspended: "warning",
  blocked: "danger",
  archived: "neutral",
};

const QUAL_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
  expired: "warning",
  withdrawn: "neutral",
};

function fmt(s: string | null | undefined) {
  return s ? new Date(s).toLocaleDateString() : "—";
}

function money(n: number | null | undefined, cur?: string | null) {
  if (n == null) return "—";
  return `${cur ?? ""} ${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`.trim();
}

/** Local label/value pair. Kept local since the design-system's FieldCell
 *  is a span-only wrapper; supplier record needs an inline label pattern. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm mt-1">{children}</div>
    </div>
  );
}


export default function SupplierRecordPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { record, loading, error, refresh } = useSupplierRecord(id);

  const [reviewOpen, setReviewOpen] = useState<
    | { mode: "approve" | "reject"; qualificationId: string }
    | null
  >(null);
  const [reviewScore, setReviewScore] = useState<string>("");
  const [reviewExpires, setReviewExpires] = useState<string>("");
  const [reviewNotes, setReviewNotes] = useState<string>("");
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) return <LoadingState />;
  if (error)
    return <ErrorState title="Failed to load supplier" description={error} />;
  if (!record)
    return <ErrorState title="Supplier not found" description="This supplier does not exist or you don't have access." />;

  const canSubmit =
    record.lifecycle_state === "draft" ||
    record.lifecycle_state === "qualifying" ||
    record.lifecycle_state === "approved";

  const activeQual = record.qualifications.find(
    (q) => q.state === "submitted",
  );
  const latestApproved = record.qualifications.find(
    (q) => q.state === "approved",
  );

  async function handleSubmit() {
    setBusy(true);
    try {
      await submitSupplierQualification(record.id);
      toast({ title: "Qualification submitted for review" });
      await refresh();
    } catch (e: any) {
      toast({
        title: "Submission failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleReviewConfirm() {
    if (!reviewOpen) return;
    setBusy(true);
    try {
      if (reviewOpen.mode === "approve") {
        await approveSupplierQualification(reviewOpen.qualificationId, {
          score: reviewScore ? Number(reviewScore) : undefined,
          expiresAt: reviewExpires || undefined,
          notes: reviewNotes || undefined,
        });
        toast({ title: "Qualification approved" });
      } else {
        if (!reviewNotes.trim()) {
          toast({
            title: "Rejection notes required",
            variant: "destructive",
          });
          setBusy(false);
          return;
        }
        await rejectSupplierQualification(
          reviewOpen.qualificationId,
          reviewNotes,
        );
        toast({ title: "Qualification rejected" });
      }
      setReviewOpen(null);
      setReviewScore("");
      setReviewExpires("");
      setReviewNotes("");
      await refresh();
    } catch (e: any) {
      toast({
        title: "Review failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSuspendConfirm() {
    if (!suspendReason.trim()) {
      toast({ title: "Reason required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await suspendSupplier(record.id, suspendReason);
      toast({ title: "Supplier suspended" });
      setSuspendOpen(false);
      setSuspendReason("");
      await refresh();
    } catch (e: any) {
      toast({
        title: "Suspend failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleReinstate() {
    setBusy(true);
    try {
      await reinstateSupplier(record.id);
      toast({ title: "Supplier reinstated" });
      await refresh();
    } catch (e: any) {
      toast({
        title: "Reinstate failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-2">
            Suppliers
            <StatusBadge tone={LIFECYCLE_TONE[record.lifecycle_state] ?? "neutral"}>
              {record.lifecycle_state.replace(/_/g, " ")}
            </StatusBadge>
            {record.is_preferred && (
              <StatusBadge tone="warning">
                Preferred #{record.preferred_rank ?? "?"}
              </StatusBadge>
            )}
          </span>
        }
        title={record.contact?.name ?? "(unnamed supplier)"}
        description={
          [
            record.supplier_code && `Code ${record.supplier_code}`,
            record.category?.name,
            record.contact?.email,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        actions={
          <ActionBar>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/purchases/suppliers")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            {record.lifecycle_state === "suspended" ? (
              <Button size="sm" onClick={handleReinstate} disabled={busy}>
                <PlayCircle className="mr-2 h-4 w-4" /> Reinstate
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSuspendOpen(true)}
                disabled={busy}
              >
                <PauseCircle className="mr-2 h-4 w-4" /> Suspend
              </Button>
            )}
            {canSubmit && !activeQual && (
              <Button size="sm" onClick={handleSubmit} disabled={busy}>
                <Send className="mr-2 h-4 w-4" /> Submit qualification
              </Button>
            )}
          </ActionBar>
        }
      />

      <PageBody>
        <Tabs defaultValue="overview" className="w-full">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="qualification">
              Qualification ({record.qualifications.length})
            </TabsTrigger>
            <TabsTrigger value="compliance">
              Compliance ({record.compliance.length})
            </TabsTrigger>
            <TabsTrigger value="banking">
              Banking ({record.bank_accounts.length})
            </TabsTrigger>
            <TabsTrigger value="contracts">
              Contracts ({record.contracts.length})
            </TabsTrigger>
            <TabsTrigger value="requisitions">
              Requisitions ({record.requisitions.length})
            </TabsTrigger>
            <TabsTrigger value="orders">
              Orders ({record.purchase_orders.length})
            </TabsTrigger>
            <TabsTrigger value="bills">
              Bills ({record.bills.length})
            </TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="mt-4 space-y-6">
            <Section title="Identity">
              <FieldGrid>
                <Field label="Legal name">{record.contact?.name ?? "—"}</Field>
                <Field label="Email">{record.contact?.email ?? "—"}</Field>
                <Field label="Phone">{record.contact?.phone ?? "—"}</Field>
                <Field label="Tax ID">{(record.contact as any)?.tax_id ?? "—"}</Field>
                <Field label="Category">{record.category?.name ?? "—"}</Field>
                <Field label="Supplier code">
                  {record.supplier_code ?? "—"}
                </Field>
              </FieldGrid>
            </Section>

            <Section title="Procurement defaults">
              <FieldGrid>
                <Field label="Default currency">
                  {record.default_currency ?? "—"}
                </Field>
                <Field label="Incoterms">
                  {record.default_incoterms ?? "—"}
                </Field>
                <Field label="Lead time (days)">
                  {record.default_lead_time_days ?? "—"}
                </Field>
                <Field label="Minimum order value">
                  {money(record.minimum_order_value, record.default_currency)}
                </Field>
              </FieldGrid>
            </Section>

            <Section
              title="Finance defaults"
              description="Sourced from the underlying Contact record (ADR-0079). Edit in the Contact profile."
            >
              <FieldGrid>
                <Field label="Payment terms">
                  {(record.contact as any)?.payment_term_id ? "Configured" : "—"}
                </Field>
                <Field label="Default payment method">
                  {(record.contact as any)?.default_payment_method_id ? "Configured" : "—"}
                </Field>
                <Field label="AP (payable) account">
                  {(record.contact as any)?.default_payable_account_id ? "Configured" : "Uses org default"}
                </Field>
                <Field label="Default expense account">
                  {(record.contact as any)?.default_expense_account_id ? "Configured" : "Uses org default"}
                </Field>
                <Field label="Default tax rate">
                  {(record.contact as any)?.default_tax_rate_id ? "Configured" : "—"}
                </Field>
                <Field label="Withholding tax rate">
                  {(record.contact as any)?.withholding_tax_rate != null
                    ? `${(record.contact as any).withholding_tax_rate}%`
                    : "—"}
                </Field>
                <Field label="Tax exemption #">
                  {(record.contact as any)?.tax_exemption_number ?? "—"}
                </Field>
                <Field label="Tax exemption expires">
                  {fmt((record.contact as any)?.tax_exemption_expiry)}
                </Field>
              </FieldGrid>
              {record.contact?.id && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/contacts/${record.contact!.id}/edit`)}
                  >
                    Edit finance defaults
                  </Button>
                </div>
              )}
            </Section>

            {record.contact?.id && (
              <Section
                title="Custom fields"
                description="Contact-scoped custom fields defined in Studio."
              >
                <ContactCustomFieldsPanel contactId={record.contact.id} />
              </Section>
            )}

            <Section title="Qualification summary">
              <FieldGrid>
                <Field label="Score">
                  {record.qualification_score != null
                    ? Number(record.qualification_score).toFixed(1)
                    : "—"}
                </Field>
                <Field label="Last qualified">
                  {fmt(record.last_qualified_at)}
                </Field>
                <Field label="Expires">
                  {fmt(record.qualification_expires_at)}
                </Field>
                <Field label="Hold reason">
                  {record.hold_reason ?? "—"}
                </Field>
              </FieldGrid>
            </Section>

          </TabsContent>

          {/* Qualification */}
          <TabsContent value="qualification" className="mt-4 space-y-4">
            {record.qualifications.length === 0 ? (
              <EmptyState
                title="No qualification cycles"
                description="Submit the first qualification to move this supplier out of draft state."
                action={
                  canSubmit ? (
                    <Button size="sm" onClick={handleSubmit} disabled={busy}>
                      <Send className="mr-2 h-4 w-4" /> Submit qualification
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cycle</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead>Reviewed</TableHead>
                      <TableHead className="text-right">Score</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>Documents</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.qualifications.map((q) => (
                      <TableRow key={q.id}>
                        <TableCell className="tabular-nums font-medium">
                          #{q.cycle_number}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone={QUAL_TONE[q.state] ?? "neutral"}>
                            {q.state}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>{fmt(q.submitted_at)}</TableCell>
                        <TableCell>{fmt(q.reviewed_at)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {q.score != null ? Number(q.score).toFixed(1) : "—"}
                        </TableCell>
                        <TableCell>{fmt(q.expires_at)}</TableCell>
                        <TableCell className="tabular-nums">
                          {q.documents?.length ?? 0}
                        </TableCell>
                        <TableCell className="text-right">
                          {q.state === "submitted" && (
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setReviewOpen({
                                    mode: "approve",
                                    qualificationId: q.id,
                                  });
                                  setReviewScore("");
                                  setReviewExpires("");
                                  setReviewNotes("");
                                }}
                              >
                                <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setReviewOpen({
                                    mode: "reject",
                                    qualificationId: q.id,
                                  });
                                  setReviewNotes("");
                                }}
                              >
                                <XCircle className="mr-1 h-4 w-4" /> Reject
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Compliance */}
          <TabsContent value="compliance" className="mt-4">
            {record.compliance.length === 0 ? (
              <EmptyState
                title="No compliance checks yet"
                description="Sanctions, tax, and banking verifications will appear here as they are run."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Checked</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.compliance.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.check_kind}</TableCell>
                        <TableCell>
                          <StatusBadge
                            tone={
                              c.outcome === "pass"
                                ? "success"
                                : c.outcome === "fail"
                                  ? "danger"
                                  : "info"
                            }
                          >
                            {c.outcome}
                          </StatusBadge>
                        </TableCell>
                        <TableCell>{fmt(c.checked_at)}</TableCell>
                        <TableCell>{fmt(c.expires_at)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.reference ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Banking */}
          <TabsContent value="banking" className="mt-4">
            {record.bank_accounts.length === 0 ? (
              <EmptyState
                title="No bank accounts on file"
                description="Bank accounts must be captured and verified before payments can be issued."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bank</TableHead>
                      <TableHead>Account name</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>IBAN / SWIFT</TableHead>
                      <TableHead>Currency</TableHead>
                      <TableHead>Verified</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.bank_accounts.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium">
                          {b.bank_name}
                          {b.is_primary && (
                            <StatusBadge tone="info" className="ml-2">
                              Primary
                            </StatusBadge>
                          )}
                        </TableCell>
                        <TableCell>{b.account_name}</TableCell>
                        <TableCell className="tabular-nums">
                          {b.account_number_masked}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {b.iban ?? "—"}
                          {b.swift_bic ? ` / ${b.swift_bic}` : ""}
                        </TableCell>
                        <TableCell>{b.currency ?? "—"}</TableCell>
                        <TableCell>
                          {b.is_verified ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600">
                              <ShieldCheck className="h-4 w-4" /> Verified
                            </span>
                          ) : (
                            <StatusBadge tone="warning">Pending</StatusBadge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Contracts */}
          <TabsContent value="contracts" className="mt-4">
            {record.contracts.length === 0 ? (
              <EmptyState
                title="No contracts"
                description="Framework agreements and blanket orders with this supplier appear here."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contract</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Ceiling</TableHead>
                      <TableHead className="text-right">Utilized</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.contracts.map((c) => (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate(`/purchases/contracts/${c.id}`)
                        }
                      >
                        <TableCell className="font-medium">
                          {c.contract_number}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone="info">{c.status}</StatusBadge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmt(c.start_date)} → {fmt(c.end_date)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(c.ceiling_value, c.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(c.utilized_value, c.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Requisitions */}
          <TabsContent value="requisitions" className="mt-4">
            {record.requisitions.length === 0 ? (
              <EmptyState
                title="No requisitions targeting this supplier"
                description="Requisition lines that suggest this supplier will appear here."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Requisition</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Need by</TableHead>
                      <TableHead className="text-right">Estimated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.requisitions.map((r) => (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate(`/purchases/requisitions/${r.id}`)
                        }
                      >
                        <TableCell className="font-medium">
                          {r.requisition_number}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone="info">{r.status}</StatusBadge>
                        </TableCell>
                        <TableCell>{fmt(r.need_by_date)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(r.estimated_total, r.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Orders */}
          <TabsContent value="orders" className="mt-4">
            {record.purchase_orders.length === 0 ? (
              <EmptyState
                title="No purchase orders"
                description="POs to this supplier will appear here once created."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Billing</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.purchase_orders.map((p) => (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer"
                        onClick={() =>
                          navigate(`/purchases/orders/${p.id}`)
                        }
                      >
                        <TableCell className="font-medium">{p.po_number}</TableCell>
                        <TableCell>
                          <StatusBadge tone="info">{p.status}</StatusBadge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {p.billing_status ?? "—"}
                        </TableCell>
                        <TableCell>{fmt(p.order_date)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(p.total, p.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Bills */}
          <TabsContent value="bills" className="mt-4">
            {record.bills.length === 0 ? (
              <EmptyState
                title="No bills"
                description="Vendor bills will appear here once recorded."
              />
            ) : (
              <div className="rounded-lg border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bill #</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {record.bills.map((b) => (
                      <TableRow
                        key={b.id}
                        className="cursor-pointer"
                        onClick={() => navigate(`/purchases/bills/${b.id}`)}
                      >
                        <TableCell className="font-medium">
                          <FileText className="mr-1 inline h-3.5 w-3.5 text-muted-foreground" />
                          {b.bill_number ?? "(draft)"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge tone="info">{b.status}</StatusBadge>
                        </TableCell>
                        <TableCell>{fmt(b.bill_date)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(b.total, b.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(b.amount_paid, b.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>

      {/* Review qualification dialog */}
      <Dialog
        open={!!reviewOpen}
        onOpenChange={(o) => !o && setReviewOpen(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewOpen?.mode === "approve"
                ? "Approve qualification"
                : "Reject qualification"}
            </DialogTitle>
            <DialogDescription>
              {reviewOpen?.mode === "approve"
                ? "Record the qualification score and expiry. The supplier becomes approved and eligible for procurement."
                : "Reject the current qualification cycle. The supplier returns to draft state."}
            </DialogDescription>
          </DialogHeader>
          {reviewOpen?.mode === "approve" && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="score">Score (0–100)</Label>
                <Input
                  id="score"
                  type="number"
                  min={0}
                  max={100}
                  value={reviewScore}
                  onChange={(e) => setReviewScore(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="expires">Expires on</Label>
                <Input
                  id="expires"
                  type="date"
                  value={reviewExpires}
                  onChange={(e) => setReviewExpires(e.target.value)}
                />
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="notes">
              Notes{reviewOpen?.mode === "reject" ? " *" : ""}
            </Label>
            <Textarea
              id="notes"
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReviewOpen(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={handleReviewConfirm} disabled={busy}>
              {busy
                ? "Working…"
                : reviewOpen?.mode === "approve"
                  ? "Approve"
                  : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suspend dialog */}
      <Dialog open={suspendOpen} onOpenChange={setSuspendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend supplier</DialogTitle>
            <DialogDescription>
              A suspended supplier cannot receive new POs. Reason is
              recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="reason">Reason *</Label>
            <Textarea
              id="reason"
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSuspendOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSuspendConfirm}
              disabled={busy}
            >
              {busy ? "Working…" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
