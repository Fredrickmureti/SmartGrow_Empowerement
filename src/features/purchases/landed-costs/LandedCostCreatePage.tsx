/**
 * LandedCostCreatePage — `/purchases/landed-costs/new`.
 *
 * Authors a DRAFT voucher only. Charges are captured here; nothing is spread
 * over receipt lines, nothing touches inventory cost and nothing reaches the
 * ledger from this screen — allocation and posting are server commands
 * (`landed_cost_allocate_voucher` / `landed_cost_post_voucher`) run from the
 * record page once the draft is complete.
 *
 * Sources of truth consumed, never re-implemented here:
 *   charge catalogue  → `landed_cost_component_types` (capitalisable flag and
 *                       expense account come from the catalogue row)
 *   currency          → the canonical catalogue `public.currencies` via
 *                       `useCurrencies` + the shared `CurrencyCombobox`
 *   receipt scope     → completed `goods_receipts`
 *   FX rate           → resolved and STAMPED server-side on insert by
 *                       `fx_stamp_document` → `require_exchange_rate`. This
 *                       screen only *displays* `describe_exchange_rate`; it
 *                       never sends a rate and never converts an amount.
 *   totals / base amounts / voucher number → database triggers
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Search, Trash2 } from "lucide-react";

import { RecordFormShell } from "@/design-system/primitives/RecordFormShell";
import {
  FieldCell,
  FieldGrid,
  FieldGroup,
} from "@/design-system/primitives/FieldGrid";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";

import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrencies } from "@/hooks/useCurrencies";
import { useOrganization } from "@/hooks/useOrganization";
import { normalizeError } from "@/services/resilience";
import {
  useCompletedGoodsReceipts,
  useLandedCostComponentTypes,
  type LandedCostBasis,
} from "./useLandedCosts";

const BASES: { value: LandedCostBasis; label: string; hint: string }[] = [
  { value: "value", label: "By value", hint: "Pro-rata on received line value." },
  { value: "quantity", label: "By quantity", hint: "Pro-rata on received quantity." },
  { value: "manual", label: "Manual", hint: "Amounts entered per line after allocation." },
];



interface ChargeLine {
  key: string;
  componentTypeId: string;
  description: string;
  basis: LandedCostBasis | string;
  amount: number;
}

let seq = 0;
const newKey = () => `charge-${++seq}`;

export default function LandedCostCreatePage() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currencies, isLoading: currenciesLoading } = useCurrencies();
  const { types, loading: typesLoading } = useLandedCostComponentTypes();

  const baseCurrency = currentBusiness?.base_currency ?? "";

  const [voucherDate, setVoucherDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [currency, setCurrency] = useState("");
  const [defaultBasis, setDefaultBasis] = useState<LandedCostBasis>("value");
  const [shipmentReference, setShipmentReference] = useState("");
  const [notes, setNotes] = useState("");
  const [charges, setCharges] = useState<ChargeLine[]>([]);
  const [receiptIds, setReceiptIds] = useState<string[]>([]);
  const [receiptSearch, setReceiptSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { receipts, loading: receiptsLoading } =
    useCompletedGoodsReceipts(receiptSearch);

  // The default currency is the business base currency — the same canonical
  // context every other purchasing document uses. No module-specific default.
  useEffect(() => {
    if (!currency && baseCurrency) setCurrency(baseCurrency);
  }, [baseCurrency, currency]);

  // Display only, through the one shared FX seam. The authoritative rate is
  // resolved and stamped server-side on insert.
  const { missingRate } = useDescribedExchangeRate(currency, voucherDate);


  const addCharge = () => {
    const first = types[0];
    setCharges((rows) => [
      ...rows,
      {
        key: newKey(),
        componentTypeId: first?.id ?? "",
        description: "",
        basis: (first?.default_basis as LandedCostBasis) ?? defaultBasis,
        amount: 0,
      },
    ]);
  };

  const patchCharge = (key: string, patch: Partial<ChargeLine>) =>
    setCharges((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );

  const removeCharge = (key: string) =>
    setCharges((rows) => rows.filter((r) => r.key !== key));

  const toggleReceipt = (id: string) =>
    setReceiptIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );

  const chargeTotal = charges.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  const validCharges = charges.filter(
    (c) => c.componentTypeId && Number(c.amount) > 0,
  );

  const submitDisabled =
    submitting ||
    !currentOrg?.id ||
    !currentBusiness?.id ||
    !currency ||
    missingRate ||
    validCharges.length === 0 ||
    receiptIds.length === 0;


  const onSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    let voucherId: string | null = null;
    try {
      const { data: voucher, error: vErr } = await supabase
        .from("landed_cost_vouchers")
        .insert({
          organization_id: currentOrg!.id,
          business_id: currentBusiness!.id,
          status: "draft",
          voucher_date: voucherDate,
          // Currency is a canonical ISO code; the exchange rate and rate date
          // are stamped SERVER-side by `_landed_cost_voucher_fx_stamp`
          // (fx_stamp_document → require_exchange_rate). The browser never
          // supplies a booking rate.
          currency,
          default_basis: defaultBasis,

          shipment_reference: shipmentReference.trim() || null,
          notes: notes.trim() || null,
        } as never)
        .select("id")
        .single();
      if (vErr) throw vErr;
      voucherId = (voucher as { id: string }).id;

      const { error: cErr } = await supabase.from("landed_cost_components").insert(
        validCharges.map((c, i) => {
          const type = types.find((t) => t.id === c.componentTypeId);
          return {
            organization_id: currentOrg!.id,
            business_id: currentBusiness!.id,
            voucher_id: voucherId,
            component_type_id: c.componentTypeId,
            description: c.description.trim() || null,
            basis: c.basis,
            amount: Number(c.amount),
            // Capitalisation policy and the expense account are catalogue
            // facts — never typed in on this screen.
            is_capitalizable: type?.is_capitalizable ?? true,
            expense_account_id: type?.expense_account_id ?? null,
            sort_order: i,
          };
        }) as never,
      );
      if (cErr) throw cErr;

      const { error: rErr } = await supabase
        .from("landed_cost_voucher_receipts")
        .insert(
          receiptIds.map((id) => ({
            organization_id: currentOrg!.id,
            business_id: currentBusiness!.id,
            voucher_id: voucherId,
            goods_receipt_id: id,
          })) as never,
        );
      if (rErr) throw rErr;

      toast.success("Draft landed cost voucher created");
      navigate(`/purchases/landed-costs/${voucherId}`);
    } catch (error: unknown) {
      // A half-written draft is worse than none: roll the header back.
      if (voucherId) {
        await supabase.from("landed_cost_vouchers").delete().eq("id", voucherId);
      }
      toast.error("Could not create the voucher", {
        description: normalizeError(error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="landed cost voucher"
      cancelHref="/purchases/landed-costs"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit();
      }}
      isSubmitting={submitting}
      submitDisabled={submitDisabled}
      submitLabel="Create draft voucher"
      meta={
        <span className="text-xs text-muted-foreground">
          Charges are captured as a draft. Allocation to receipt lines and
          posting to the ledger happen on the voucher record.
        </span>
      }
    >
      <FieldGroup label="Voucher">
        <FieldGrid>
          <FieldCell>
            <Label htmlFor="lc-date">Voucher date</Label>
            <Input
              id="lc-date"
              type="date"
              value={voucherDate}
              onChange={(e) => setVoucherDate(e.target.value)}
            />
          </FieldCell>
          <FieldCell>
            <Label htmlFor="lc-currency">Charge currency</Label>
            <CurrencyCombobox
              currencies={currencies}
              value={currency}
              onValueChange={setCurrency}
              disabled={currenciesLoading}
            />
          </FieldCell>
          <FieldCell>
            <Label>Exchange rate</Label>
            <ExchangeRatePanel
              currency={currency}
              onDate={voucherDate}
              baseHint="Charges are already in the base currency — no conversion applies."
              missingHint="Publish or override a rate in the rate book before saving — the voucher cannot be valued at parity."
            />
          </FieldCell>


          <FieldCell>
            <Label>Default allocation basis</Label>
            <Select
              value={defaultBasis}
              onValueChange={(v) => setDefaultBasis(v as LandedCostBasis)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASES.map((b) => (
                  <SelectItem key={b.value} value={b.value}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {BASES.find((b) => b.value === defaultBasis)?.hint}
            </p>
          </FieldCell>
          <FieldCell>
            <Label htmlFor="lc-shipment">Shipment reference</Label>
            <Input
              id="lc-shipment"
              value={shipmentReference}
              onChange={(e) => setShipmentReference(e.target.value)}
              placeholder="B/L, container or clearing reference"
            />
          </FieldCell>
          <FieldCell span={3}>
            <Label htmlFor="lc-notes">Notes</Label>
            <Textarea
              id="lc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </FieldCell>
        </FieldGrid>
      </FieldGroup>

      <FieldGroup label="Charges">
        {typesLoading ? (
          <p className="text-sm text-muted-foreground">Loading charge types…</p>
        ) : types.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No landed cost charge types are configured for this business yet.
            Configure the catalogue before capturing charges.
          </p>
        ) : (
          <div className="space-y-3">
            {charges.map((c) => {
              const type = types.find((t) => t.id === c.componentTypeId);
              return (
                <div
                  key={c.key}
                  className="grid grid-cols-1 items-end gap-3 rounded-md border p-3 sm:grid-cols-12"
                >
                  <div className="sm:col-span-3">
                    <Label>Charge type</Label>
                    <Select
                      value={c.componentTypeId}
                      onValueChange={(v) => {
                        const t = types.find((x) => x.id === v);
                        patchCharge(c.key, {
                          componentTypeId: v,
                          basis: (t?.default_basis as LandedCostBasis) ?? c.basis,
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {types.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-3">
                    <Label>Description</Label>
                    <Input
                      value={c.description}
                      onChange={(e) =>
                        patchCharge(c.key, { description: e.target.value })
                      }
                      placeholder={type?.name ?? ""}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>Basis</Label>
                    <Select
                      value={String(c.basis)}
                      onValueChange={(v) => patchCharge(c.key, { basis: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BASES.map((b) => (
                          <SelectItem key={b.value} value={b.value}>
                            {b.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label>Amount ({currency})</Label>
                    <NumericInput
                      value={c.amount}
                      onValueChange={(v) => patchCharge(c.key, { amount: v ?? 0 })}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:col-span-2">
                    <Badge variant="secondary">
                      {type?.is_capitalizable ? "Capitalised" : "Expensed"}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCharge(c.key)}
                      aria-label="Remove charge"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}

            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" size="sm" onClick={addCharge}>
                <Plus className="mr-2 h-4 w-4" />
                Add charge
              </Button>
              <div className="text-right text-sm">
                <div className="font-medium">
                  {chargeTotal.toFixed(2)} {currency}
                </div>
                {currency !== baseCurrency && (
                  <div className="text-xs text-muted-foreground">
                    Base-currency value is stamped by the server on save.
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </FieldGroup>

      <FieldGroup label="Receipts to capitalise onto">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              value={receiptSearch}
              onChange={(e) => setReceiptSearch(e.target.value)}
              placeholder="Search by receipt or purchase order number"
            />
          </div>

          {receiptsLoading ? (
            <p className="text-sm text-muted-foreground">Loading receipts…</p>
          ) : receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No completed goods receipts match. Landed cost can only be
              capitalised onto stock that has actually been received.
            </p>
          ) : (
            <div className="max-h-80 divide-y overflow-auto rounded-md border">
              {receipts.map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-muted/50"
                >
                  <Checkbox
                    checked={receiptIds.includes(r.id)}
                    onCheckedChange={() => toggleReceipt(r.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{r.receipt_number}</span>
                    <span className="ml-2 text-muted-foreground">
                      {r.receipt_date}
                      {r.purchase_order?.po_number
                        ? ` · ${r.purchase_order.po_number}`
                        : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {receiptIds.length} receipt{receiptIds.length === 1 ? "" : "s"} selected.
            Only stock-tracked lines receive an uplift; service and non-stock
            lines are reported as skipped when the voucher is allocated.
          </p>
        </div>
      </FieldGroup>
    </RecordFormShell>
  );
}
