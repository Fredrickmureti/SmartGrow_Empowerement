/**
 * Loan product version dialog (C4).
 *
 * Publishes a new immutable version and shows the frozen version history.
 * Publishing is the only way to change terms; existing versions are never
 * edited, so loans written on them keep their contractual terms.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState, StatusBadge } from "@/design-system";
import { Plus, Trash2 } from "lucide-react";
import {
  MF_FEE_BASES,
  MF_FEE_BASIS_LABELS,
  MF_FEE_COLLECTIONS,
  MF_FEE_COLLECTION_LABELS,
  MF_INTEREST_COLLECTION_HELP,
  MF_INTEREST_COLLECTION_LABELS,
  MF_INTEREST_METHODS,
  MF_INTEREST_METHOD_LABELS,
  MF_VALID_INTEREST_COLLECTIONS,
  MF_PENALTY_BASES,
  MF_PENALTY_BASIS_LABELS,
  MF_RATE_PERIOD_HELP,
  MF_RATE_PERIOD_LABELS,
  MF_REPAYMENT_FREQUENCIES,
  MF_VALID_RATE_PERIODS,

  useMfLoanProductVersions,
  type MfInterestCollection,
  type MfInterestMethod,
  type MfInterestRatePeriod,
  type MfLoanProduct,
  type MfPenaltyBasis,
  type MfProductFee,
  type MfRepaymentFrequency,
} from "@/hooks/useMfLoanProducts";


interface ProductVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: MfLoanProduct | null;
  businessId: string | undefined;
}

/** One fee row being edited. Values stay strings until publish. */
interface FeeDraft {
  name: string;
  basis: MfProductFee["basis"];
  value: string;
  collection: MfProductFee["collection"];
}

interface FormState {
  currency_code: string;
  min_amount: string;
  max_amount: string;
  min_term_installments: string;
  max_term_installments: string;
  repayment_frequency: MfRepaymentFrequency;
  interest_method: MfInterestMethod;
  interest_rate: string;
  interest_rate_period: MfInterestRatePeriod;
  interest_collection: MfInterestCollection;
  grace_period_installments: string;
  fees: FeeDraft[];
  penalty_rate: string;
  penalty_basis: MfPenaltyBasis;
  effective_from: string;
  min_completed_cycles: string;
  activate: boolean;
}

const EMPTY: FormState = {
  currency_code: "KES",
  min_amount: "5000",
  max_amount: "100000",
  min_term_installments: "4",
  max_term_installments: "24",
  repayment_frequency: "weekly",
  interest_method: "flat",
  interest_rate: "20",
  interest_rate_period: "per_annum",
  interest_collection: "with_installments",
  grace_period_installments: "0",
  fees: [],
  penalty_rate: "0",
  penalty_basis: "overdue_installment",
  effective_from: new Date().toISOString().slice(0, 10),
  min_completed_cycles: "0",
  activate: true,
};

const NEW_FEE: FeeDraft = {
  name: "Processing fee",
  basis: "fixed",
  value: "0",
  collection: "deducted_from_disbursement",
};


export function ProductVersionDialog({
  open,
  onOpenChange,
  product,
  businessId,
}: ProductVersionDialogProps) {
  const { versions, currentVersion, isLoading, publishVersion } =
    useMfLoanProductVersions(product?.id ?? null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);

  // Seed from the version actually in force today, not merely the newest row —
  // a future-dated version is scheduled, not the current price.
  const latest = currentVersion ?? versions[0] ?? null;

  useEffect(() => {
    if (!open) return;
    // Seed from the version in force so repricing is a small edit, not re-entry.
    setForm(
      latest
        ? {
            currency_code: latest.currency_code,
            min_amount: String(latest.min_amount),
            max_amount: String(latest.max_amount),
            min_term_installments: String(latest.min_term_installments),
            max_term_installments: String(latest.max_term_installments),
            repayment_frequency: latest.repayment_frequency,
            interest_method: latest.interest_method,
            interest_rate: String(latest.interest_rate),
            interest_rate_period: latest.interest_rate_period,
            interest_collection: latest.interest_collection ?? "with_installments",
            grace_period_installments: String(latest.grace_period_installments),
            fees: (latest.fees ?? []).map((f) => ({
              name: f.name ?? "",
              basis: f.basis ?? "fixed",
              value: String(f.value ?? 0),
              collection: f.collection ?? "deducted_from_disbursement",
            })),
            penalty_rate: String(latest.penalty_rate),

            penalty_basis: latest.penalty_basis,
            effective_from: new Date().toISOString().slice(0, 10),
            min_completed_cycles: String(latest.eligibility?.min_completed_cycles ?? 0),
            activate: true,
          }
        : EMPTY,
    );
  }, [open, latest]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setFee = (index: number, patch: Partial<FeeDraft>) =>
    setForm((prev) => ({
      ...prev,
      fees: prev.fees.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));

  const addFee = () => setForm((prev) => ({ ...prev, fees: [...prev.fees, { ...NEW_FEE }] }));

  const removeFee = (index: number) =>
    setForm((prev) => ({ ...prev, fees: prev.fees.filter((_, i) => i !== index) }));

  /** Bases the schedule engine will accept for the chosen interest method. */
  const allowedRatePeriods = MF_VALID_RATE_PERIODS[form.interest_method];

  /** Upfront collection is only priceable on a flat-interest product. */
  const allowedInterestCollections = MF_VALID_INTEREST_COLLECTIONS[form.interest_method];

  /** A basis only means something once a late charge is actually priced. */
  const penaltyEnabled = Number(form.penalty_rate) > 0;

  // Changing the method can strand an unsupported basis; fall back to per annum
  // rather than letting the database reject the publish.
  useEffect(() => {
    if (!allowedRatePeriods.includes(form.interest_rate_period)) {
      setForm((prev) => ({ ...prev, interest_rate_period: "per_annum" }));
    }
  }, [allowedRatePeriods, form.interest_rate_period]);

  // Likewise for interest collection: switching away from flat interest must
  // fall back to collecting interest with the installments.
  useEffect(() => {
    if (!allowedInterestCollections.includes(form.interest_collection)) {
      setForm((prev) => ({ ...prev, interest_collection: "with_installments" }));
    }
  }, [allowedInterestCollections, form.interest_collection]);

  const invalid = useMemo(() => {
    const min = Number(form.min_amount);
    const max = Number(form.max_amount);
    const minT = Number(form.min_term_installments);
    const maxT = Number(form.max_term_installments);
    const grace = Number(form.grace_period_installments);
    if (!(min > 0) || !(max >= min)) return "Amount band is invalid.";
    if (!(minT > 0) || !(maxT >= minT)) return "Term band is invalid.";
    if (Number(form.interest_rate) < 0) return "Interest rate cannot be negative.";
    if (!MF_VALID_RATE_PERIODS[form.interest_method].includes(form.interest_rate_period))
      return "That rate basis cannot be used with the selected interest method.";
    if (
      !MF_VALID_INTEREST_COLLECTIONS[form.interest_method].includes(form.interest_collection)
    )
      return "Interest can only be deducted upfront on a flat-interest product.";
    if (!(grace >= 0)) return "Grace installments cannot be negative.";
    if (grace >= minT)
      return "Grace installments must be fewer than the minimum number of installments.";
    if (Number(form.penalty_rate) < 0) return "Penalty rate cannot be negative.";
    let percentFees = 0;
    for (const fee of form.fees) {
      if (!fee.name.trim()) return "Every fee needs a name.";
      const value = Number(fee.value);
      if (!Number.isFinite(value) || value < 0) return `Fee "${fee.name}" has an invalid value.`;
      if (fee.basis === "percent_of_principal") {
        if (value >= 100) return `Fee "${fee.name}" cannot be 100% or more of principal.`;
        percentFees += value;
      }
    }
    if (percentFees >= 100)
      return "Percentage fees add up to 100% or more of the principal.";
    return null;
  }, [form]);


  const submit = async () => {
    if (!product || !businessId || invalid) return;
    setSaving(true);
    try {
      await publishVersion.mutateAsync({
        businessId,
        activateProduct: form.activate,
        version: {
          product_id: product.id,
          currency_code: form.currency_code.trim().toUpperCase(),
          min_amount: Number(form.min_amount),
          max_amount: Number(form.max_amount),
          min_term_installments: Number(form.min_term_installments),
          max_term_installments: Number(form.max_term_installments),
          repayment_frequency: form.repayment_frequency,
          interest_method: form.interest_method,
          interest_rate: Number(form.interest_rate),
          interest_rate_period: form.interest_rate_period,
          interest_collection: form.interest_collection,
          grace_period_installments: Number(form.grace_period_installments),
          fees: form.fees.map<MfProductFee>((f) => ({
            name: f.name.trim(),
            basis: f.basis,
            value: Number(f.value),
            collection: f.collection,
          })),
          penalty_rate: Number(form.penalty_rate),
          penalty_basis: form.penalty_basis,
          eligibility: { min_completed_cycles: Number(form.min_completed_cycles) },
          effective_from: form.effective_from,
        },
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {product ? `${product.code} — publish new version` : "Publish version"}
          </DialogTitle>
          <DialogDescription>
            Published terms are frozen. Loans already written on an earlier version keep
            their contractual terms.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="v-currency">Currency</Label>
              <Input id="v-currency" value={form.currency_code} readOnly disabled />
              <p className="text-xs text-muted-foreground">
                All lending is in Kenyan shillings.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="v-min-amount">Minimum amount</Label>
              <Input
                id="v-min-amount"
                type="number"
                value={form.min_amount}
                onChange={(e) => set("min_amount", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-max-amount">Maximum amount</Label>
              <Input
                id="v-max-amount"
                type="number"
                value={form.max_amount}
                onChange={(e) => set("max_amount", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="v-frequency">Repayment frequency</Label>
              <Select
                value={form.repayment_frequency}
                onValueChange={(v) => set("repayment_frequency", v as MfRepaymentFrequency)}
              >
                <SelectTrigger id="v-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_REPAYMENT_FREQUENCIES.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-min-term">Minimum installments</Label>
              <Input
                id="v-min-term"
                type="number"
                value={form.min_term_installments}
                onChange={(e) => set("min_term_installments", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-max-term">Maximum installments</Label>
              <Input
                id="v-max-term"
                type="number"
                value={form.max_term_installments}
                onChange={(e) => set("max_term_installments", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="v-method">Interest method</Label>
              <Select
                value={form.interest_method}
                onValueChange={(v) => set("interest_method", v as MfInterestMethod)}
              >
                <SelectTrigger id="v-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_INTEREST_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {MF_INTEREST_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-rate">Interest rate (%)</Label>
              <Input
                id="v-rate"
                type="number"
                step="0.01"
                value={form.interest_rate}
                onChange={(e) => set("interest_rate", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-rate-period">Rate basis</Label>
              <Select
                value={form.interest_rate_period}
                onValueChange={(v) =>
                  set("interest_rate_period", v as MfInterestRatePeriod)
                }
              >
                <SelectTrigger id="v-rate-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allowedRatePeriods.map((p) => (
                    <SelectItem key={p} value={p}>
                      {MF_RATE_PERIOD_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {MF_RATE_PERIOD_HELP[form.interest_rate_period]}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="v-interest-collection">Interest collection</Label>
              <Select
                value={form.interest_collection}
                onValueChange={(v) => set("interest_collection", v as MfInterestCollection)}
                disabled={allowedInterestCollections.length < 2}
              >
                <SelectTrigger id="v-interest-collection">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {allowedInterestCollections.map((c) => (
                    <SelectItem key={c} value={c}>
                      {MF_INTEREST_COLLECTION_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {allowedInterestCollections.length < 2
                  ? "Interest can only be deducted upfront on a flat-interest product."
                  : MF_INTEREST_COLLECTION_HELP[form.interest_collection]}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="v-grace">Grace installments</Label>
              <Input
                id="v-grace"
                type="number"
                min={0}
                value={form.grace_period_installments}
                onChange={(e) => set("grace_period_installments", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Opening installments that carry no principal. The loan is repaid over the
                remaining installments; nothing is waived and no date moves.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-penalty">Penalty rate (%)</Label>
              <Input
                id="v-penalty"
                type="number"
                step="0.01"
                min={0}
                value={form.penalty_rate}
                onChange={(e) => set("penalty_rate", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Charged only after an installment falls overdue — never part of the
                schedule at origination. Leave at 0 for no late charge.
              </p>
            </div>
            {penaltyEnabled ? (
              <div className="space-y-1.5">
                <Label htmlFor="v-penalty-basis">Penalty basis</Label>
                <Select
                  value={form.penalty_basis}
                  onValueChange={(v) => set("penalty_basis", v as MfPenaltyBasis)}
                >
                  <SelectTrigger id="v-penalty-basis">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MF_PENALTY_BASES.map((b) => (
                      <SelectItem key={b} value={b}>
                        {MF_PENALTY_BASIS_LABELS[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The amount the penalty percentage is charged on.
                </p>
              </div>
            ) : null}


            <div className="space-y-1.5">
              <Label htmlFor="v-effective">Effective from</Label>
              <Input
                id="v-effective"
                type="date"
                value={form.effective_from}
                onChange={(e) => set("effective_from", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-cycles">Minimum completed cycles</Label>
              <Input
                id="v-cycles"
                type="number"
                value={form.min_completed_cycles}
                onChange={(e) => set("min_completed_cycles", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Fees</p>
                <p className="text-xs text-muted-foreground">
                  Fee amounts are worked out on the server at disbursement. A fee is never
                  added to the principal.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addFee}>
                <Plus className="mr-1 h-4 w-4" />
                Add fee
              </Button>
            </div>

            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              <li>
                <span className="font-medium">Deducted from disbursement</span> — the client
                takes home less cash but still owes the full loan amount. On a 10,000 loan
                with a 500 fee they receive 9,500 and repay 10,000 plus interest.
              </li>
              <li>
                <span className="font-medium">Added to first installment</span> — the client
                takes home the full loan amount and the fee is collected with the first
                repayment. They receive 10,000 and repay 10,500 plus interest.
              </li>
              <li>
                <span className="font-medium">Paid by the client at disbursement</span> — the
                client hands the fee over in cash at the payout desk, so it is not taken off
                the payout. On a 10,000 loan with a 500 fee they pay 500 in, receive 10,000
                and repay 10,000 plus interest.
              </li>
            </ul>

            {form.fees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No fees on this version.</p>
            ) : (
              form.fees.map((fee, index) => (
                <div
                  key={index}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr_1fr_0.8fr_1.2fr_auto]"
                >
                  <Input
                    aria-label="Fee name"
                    placeholder="Fee name"
                    value={fee.name}
                    onChange={(e) => setFee(index, { name: e.target.value })}
                  />
                  <Select
                    value={fee.basis}
                    onValueChange={(v) => setFee(index, { basis: v as MfProductFee["basis"] })}
                  >
                    <SelectTrigger aria-label="Fee basis">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MF_FEE_BASES.map((b) => (
                        <SelectItem key={b} value={b}>
                          {MF_FEE_BASIS_LABELS[b]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label="Fee value"
                    type="number"
                    step="0.01"
                    value={fee.value}
                    onChange={(e) => setFee(index, { value: e.target.value })}
                  />
                  <Select
                    value={fee.collection}
                    onValueChange={(v) =>
                      setFee(index, { collection: v as MfProductFee["collection"] })
                    }
                  >
                    <SelectTrigger aria-label="Fee collection">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MF_FEE_COLLECTIONS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {MF_FEE_COLLECTION_LABELS[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove fee"
                    onClick={() => removeFee(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>



          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.activate}
              onCheckedChange={(v) => set("activate", v === true)}
            />
            Activate the product with this version
          </label>

          {invalid ? (
            <p className="text-sm text-destructive">{invalid}</p>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">Version history</p>
            {isLoading ? (
              <LoadingState />
            ) : versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No versions yet — publishing below creates version 1.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead>Amounts</TableHead>
                    <TableHead>Term</TableHead>
                    <TableHead>Interest</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-xs">v{v.version_no}</TableCell>
                      <TableCell>{v.effective_from}</TableCell>
                      <TableCell>
                        {v.currency_code} {v.min_amount}–{v.max_amount}
                      </TableCell>
                      <TableCell>
                        {v.min_term_installments}–{v.max_term_installments} ×{" "}
                        {v.repayment_frequency}
                      </TableCell>
                      <TableCell>
                        {v.interest_rate}% {v.interest_rate_period.replace(/_/g, " ")}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={v.is_published ? "success" : "neutral"}>
                          {v.is_published ? "frozen" : "draft"}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={submit} disabled={!!invalid || saving || !product}>
            Publish version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ProductVersionDialog;
