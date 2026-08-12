/**
 * Supplier 360 — commercial tabs.
 *
 * Operator surfaces for the master-data RPCs that previously had no UI:
 *   • Terms      → `update_supplier_terms` (+ `supplier_terms_changes` history)
 *   • Item terms → `supplier_item_terms` (read; maintained from the product)
 *   • ASL        → `add_supplier_to_asl` / `remove_supplier_from_asl`
 *   • Payments   → vendor payment history
 *   • Returns    → purchase return history
 *   • History    → `supplier_lifecycle_events` audit timeline
 *
 * Every write goes through a SECURITY DEFINER RPC wrapper — this file never
 * touches supplier tables directly.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TabsContent } from "@/components/ui/tabs";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, Section, StatusBadge } from "@/design-system";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

import type { SupplierRecord } from "./useSupplierRecord";
import { useSupplierCategories } from "./useSuppliers";
import {
  addSupplierToAsl,
  removeSupplierFromAsl,
  updateSupplierTerms,
} from "./supplierRpcs";

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

function diffKeys(
  oldV: Record<string, unknown> | null,
  newV: Record<string, unknown> | null,
) {
  const keys = new Set([...Object.keys(oldV ?? {}), ...Object.keys(newV ?? {})]);
  return Array.from(keys).filter(
    (k) => JSON.stringify(oldV?.[k]) !== JSON.stringify(newV?.[k]),
  );
}

interface TabProps {
  record: SupplierRecord;
  refresh: () => void;
}

/* ── Commercial terms ─────────────────────────────────────────────────── */
export function SupplierTermsTab({ record, refresh }: TabProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    defaultCurrency: record.default_currency ?? "",
    defaultIncoterms: record.default_incoterms ?? "",
    defaultLeadTimeDays: record.default_lead_time_days ?? null,
    minimumOrderValue: record.minimum_order_value ?? null,
    preferredRank: record.preferred_rank ?? null,
    reason: "",
  });

  const save = async () => {
    setBusy(true);
    try {
      await updateSupplierTerms(record.id, {
        defaultCurrency: form.defaultCurrency || null,
        defaultIncoterms: form.defaultIncoterms || null,
        defaultLeadTimeDays: form.defaultLeadTimeDays,
        minimumOrderValue: form.minimumOrderValue,
        preferredRank: form.preferredRank,
        reason: form.reason || undefined,
      });
      toast({ title: "Commercial terms updated" });
      setOpen(false);
      refresh();
    } catch (e) {
      toast({
        title: "Could not update terms",
        description: normalizeError(e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <TabsContent value="terms" className="mt-4 space-y-6">
      <Section
        title="Commercial terms"
        description="Defaults applied to new purchase documents for this supplier."
        actions={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Edit terms
          </Button>
        }
      >
        <div className="rounded-lg border bg-card">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="text-muted-foreground">Currency</TableCell>
                <TableCell>{record.default_currency ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">Incoterms</TableCell>
                <TableCell>{record.default_incoterms ?? "—"}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Lead time</TableCell>
                <TableCell>
                  {record.default_lead_time_days != null
                    ? `${record.default_lead_time_days} days`
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  Minimum order value
                </TableCell>
                <TableCell>
                  {money(record.minimum_order_value, record.default_currency)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">
                  Preferred rank
                </TableCell>
                <TableCell>{record.preferred_rank ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">Preferred</TableCell>
                <TableCell>{record.is_preferred ? "Yes" : "No"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section
        title="Change history"
        description="Every terms change is recorded with the reason given."
      >
        {record.terms_changes.length === 0 ? (
          <EmptyState
            title="No changes recorded"
            description="Terms changes appear here once terms are edited."
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Changed</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {record.terms_changes.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{new Date(c.created_at).toLocaleString()}</TableCell>
                    <TableCell className="text-sm">
                      {diffKeys(c.old_values, c.new_values).map((k) => (
                        <div key={k}>
                          <span className="text-muted-foreground">{k}: </span>
                          {String(c.old_values?.[k] ?? "—")} →{" "}
                          {String(c.new_values?.[k] ?? "—")}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell>{c.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit commercial terms</DialogTitle>
            <DialogDescription>
              Changes are change-logged against this supplier.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="terms-currency">Currency</Label>
                <CurrencyCombobox
                  currencies={currencies}
                  value={form.defaultCurrency}
                  onValueChange={(code) =>
                    setForm({ ...form, defaultCurrency: code })
                  }
                  placeholder="Select currency…"
                  disabled={currenciesLoading}
                />
              </div>
              <div>
                <Label htmlFor="terms-incoterms">Incoterms</Label>
                <Input
                  id="terms-incoterms"
                  value={form.defaultIncoterms}
                  onChange={(e) =>
                    setForm({ ...form, defaultIncoterms: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="terms-lead">Lead time (days)</Label>
                <Input
                  id="terms-lead"
                  type="number"
                  value={form.defaultLeadTimeDays ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      defaultLeadTimeDays:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <Label htmlFor="terms-mov">Minimum order value</Label>
                <Input
                  id="terms-mov"
                  type="number"
                  value={form.minimumOrderValue ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      minimumOrderValue:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
              <div>
                <Label htmlFor="terms-rank">Preferred rank</Label>
                <Input
                  id="terms-rank"
                  type="number"
                  value={form.preferredRank ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      preferredRank:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>
            <div>
              <Label htmlFor="terms-reason">Reason</Label>
              <Textarea
                id="terms-reason"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Why are these terms changing?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              Save terms
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabsContent>
  );
}

/* ── Item terms ───────────────────────────────────────────────────────── */
export function SupplierItemTermsTab({ record }: TabProps) {
  const navigate = useNavigate();
  return (
    <TabsContent value="item-terms" className="mt-4">
      {record.item_terms.length === 0 ? (
        <EmptyState
          title="No item terms"
          description="Vendor cost, minimum order quantity and lead time per product appear here."
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">MOQ</TableHead>
                <TableHead className="text-right">Lead time</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.item_terms.map((t) => (
                <TableRow
                  key={t.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/inventory/products/${t.product_id}`)}
                >
                  <TableCell className="font-medium">
                    {t.product?.name ?? "—"}
                    {t.product?.sku ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t.product.sku}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(t.unit_price, t.currency_code)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.min_order_qty ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.lead_time_days != null ? `${t.lead_time_days} d` : "—"}
                  </TableCell>
                  <TableCell>
                    {fmt(t.effective_from)} → {t.effective_to ? fmt(t.effective_to) : "open"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={t.is_active ? "success" : "neutral"}>
                      {t.is_active ? "active" : "inactive"}
                    </StatusBadge>
                    {(t.preferred_rank ?? 99) <= 1 && (
                      <StatusBadge tone="info" className="ml-2">
                        preferred
                      </StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}

/* ── Approved supplier list ───────────────────────────────────────────── */
export function SupplierAslTab({ record, refresh }: TabProps) {
  const { toast } = useToast();
  const categories = useSupplierCategories();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [categoryId, setCategoryId] = useState("");
  const [rank, setRank] = useState<number>(1);
  const [notes, setNotes] = useState("");

  const add = async () => {
    if (!categoryId) return;
    setBusy(true);
    try {
      await addSupplierToAsl(record.id, categoryId, { rank, notes: notes || undefined });
      toast({ title: "Added to approved supplier list" });
      setOpen(false);
      setCategoryId("");
      setNotes("");
      refresh();
    } catch (e) {
      toast({
        title: "Could not add to ASL",
        description: normalizeError(e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (catId: string) => {
    setBusy(true);
    try {
      await removeSupplierFromAsl(record.id, catId);
      toast({ title: "Removed from approved supplier list" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not remove from ASL",
        description: normalizeError(e as Error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <TabsContent value="asl" className="mt-4 space-y-4">
      <Section
        title="Approved supplier list"
        description="Categories this supplier is approved to source. Restricted categories reject purchase documents from suppliers that are not listed."
        actions={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add category
          </Button>
        }
      >
        {record.asl.length === 0 ? (
          <EmptyState
            title="Not on any approved list"
            description="Add a category to authorise sourcing from this supplier."
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Rank</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {record.asl.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">
                      {a.category?.name ?? a.category_id}
                      {a.category?.code ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {a.category.code}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.rank ?? "—"}
                    </TableCell>
                    <TableCell>
                      {fmt(a.effective_from)} → {a.effective_to ? fmt(a.effective_to) : "open"}
                    </TableCell>
                    <TableCell>{fmt(a.approved_at)}</TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove(a.category_id)}
                        aria-label="Remove from approved supplier list"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to approved supplier list</DialogTitle>
            <DialogDescription>
              Approval is recorded against your user for audit.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="asl-category">Category</Label>
              <select
                id="asl-category"
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">Select a category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="asl-rank">Rank</Label>
              <Input
                id="asl-rank"
                type="number"
                value={rank}
                onChange={(e) => setRank(Number(e.target.value) || 1)}
              />
            </div>
            <div>
              <Label htmlFor="asl-notes">Notes</Label>
              <Textarea
                id="asl-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={add} disabled={busy || !categoryId}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TabsContent>
  );
}

/* ── Payments ─────────────────────────────────────────────────────────── */
export function SupplierPaymentsTab({ record }: TabProps) {
  // No standalone payment detail page exists yet — rows stay read-only.
  return (
    <TabsContent value="payments" className="mt-4">
      {record.payments.length === 0 ? (
        <EmptyState
          title="No payments"
          description="Payments made to this supplier will appear here."
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{fmt(p.payment_date)}</TableCell>
                  <TableCell>{p.payment_method ?? "—"}</TableCell>
                  <TableCell>{p.reference ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge tone={p.status === "voided" ? "danger" : "info"}>
                      {p.status ?? "—"}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.amount, record.default_currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}

/* ── Returns ──────────────────────────────────────────────────────────── */
export function SupplierReturnsTab({ record }: TabProps) {
  const navigate = useNavigate();
  return (
    <TabsContent value="returns" className="mt-4">
      {record.returns.length === 0 ? (
        <EmptyState
          title="No returns"
          description="Goods returns and debit notes raised against this supplier appear here."
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Return #</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.returns.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/purchases/returns/${r.id}`)}
                >
                  <TableCell className="font-medium">
                    {r.return_number ?? "(draft)"}
                  </TableCell>
                  <TableCell>{r.return_kind ?? "goods"}</TableCell>
                  <TableCell>
                    <StatusBadge tone="info">{r.status}</StatusBadge>
                  </TableCell>
                  <TableCell>{fmt(r.return_date)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(r.total, r.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}

/* ── Lifecycle timeline ───────────────────────────────────────────────── */
export function SupplierHistoryTab({ record }: TabProps) {
  return (
    <TabsContent value="history" className="mt-4">
      {record.lifecycle_events.length === 0 ? (
        <EmptyState
          title="No lifecycle events"
          description="Approvals, suspensions, blocks and archives appear here in order."
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">#</TableHead>
                <TableHead>Transition</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {record.lifecycle_events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular-nums">{e.seq}</TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">
                      {e.from_state ?? "—"}
                    </span>{" "}
                    → <StatusBadge tone="info">{e.to_state}</StatusBadge>
                  </TableCell>
                  <TableCell>{e.reason ?? "—"}</TableCell>
                  <TableCell>{new Date(e.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </TabsContent>
  );
}
