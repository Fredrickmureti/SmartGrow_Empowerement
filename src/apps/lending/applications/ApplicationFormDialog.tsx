/**
 * Capture or amend a loan application (C5).
 *
 * Requested terms only. The approved amount and term are a separate, decided
 * fact recorded by an authorised officer in the decision dialog — the two are
 * never the same field.
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranches } from "@/hooks/useBranches";
import { useBranchOfficers } from "@/hooks/useBranchOfficers";
import { useMfClients } from "@/hooks/useMfClients";
import { useMfClientActiveGroup } from "@/hooks/useMfClientActiveGroup";
import { useMfLoanProducts, useMfLoanProductVersions } from "@/hooks/useMfLoanProducts";
import {
  type MfLoanApplication,
  type MfLoanApplicationInput,
} from "@/hooks/useMfApplications";

const NONE = "__none__";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: MfLoanApplication | null;
  onCreate: (input: MfLoanApplicationInput) => Promise<void>;
  onUpdate: (id: string, patch: Partial<MfLoanApplicationInput>) => Promise<void>;
}

export function ApplicationFormDialog({
  open,
  onOpenChange,
  application,
  onCreate,
  onUpdate,
}: Props) {
  const { branches } = useBranches();
  const { officers } = useBranchOfficers();
  const { clients } = useMfClients();
  const { products } = useMfLoanProducts({ status: "active" });

  const [form, setForm] = useState({
    application_number: "",
    branch_id: "",
    client_id: "",
    group_id: NONE,
    product_id: "",
    loan_officer_id: NONE,
    requested_amount: "",
    requested_term_installments: "",
    purpose: "",
  });
  const [saving, setSaving] = useState(false);

  const { currentVersion } = useMfLoanProductVersions(form.product_id || null);

  useEffect(() => {
    if (!open) return;
    if (application) {
      setForm({
        application_number: application.application_number,
        branch_id: application.branch_id,
        client_id: application.client_id,
        group_id: application.group_id ?? NONE,
        product_id: application.product_id,
        loan_officer_id: application.loan_officer_id ?? NONE,
        requested_amount: String(application.requested_amount),
        requested_term_installments: String(application.requested_term_installments),
        purpose: application.purpose ?? "",
      });
    } else {
      setForm({
        application_number: "",
        branch_id: "",
        client_id: "",
        group_id: NONE,
        product_id: "",
        loan_officer_id: NONE,
        requested_amount: "",
        requested_term_installments: "",
        purpose: "",
      });
    }
  }, [open, application, branches]);

  const set = (key: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));


  // The client is the meaningful business entity: the branch it is registered
  // in, and the group it is a member of, are facts the system already holds.
  // Neither is a free choice here — the database refuses any other combination.
  const { group: clientGroup, isLoading: groupLoading } = useMfClientActiveGroup(
    form.client_id || null,
  );

  const onClientChange = (clientId: string) => {
    const client = clients.find((c) => c.id === clientId);
    setForm((f) => ({
      ...f,
      client_id: clientId,
      branch_id: client?.branch_id ?? "",
      loan_officer_id: client?.loan_officer_id ?? NONE,
      group_id: NONE,
    }));
  };

  // The membership arrives a moment after the client is picked.
  useEffect(() => {
    if (!form.client_id) return;
    setForm((f) => {
      const next = clientGroup?.id ?? NONE;
      return f.group_id === next ? f : { ...f, group_id: next };
    });
  }, [clientGroup, form.client_id]);

  const branchName = useMemo(
    () => branches.find((b) => b.id === form.branch_id)?.name ?? "",
    [branches, form.branch_id],
  );

  /** Only staff actually assigned to the client's branch may own the case. */
  const branchOfficers = useMemo(
    () =>
      form.branch_id
        ? officers.filter((o) => o.branchIds.includes(form.branch_id))
        : [],
    [officers, form.branch_id],
  );

  const bandHint = useMemo(() => {
    if (!currentVersion) return null;
    const v = currentVersion;
    return `Version ${v.version_no} in force: ${v.currency_code} ${v.min_amount}–${v.max_amount} over ${v.min_term_installments}–${v.max_term_installments} ${v.repayment_frequency} installments`;
  }, [currentVersion]);

  const amount = Number(form.requested_amount);
  const term = Number(form.requested_term_installments);

  /**
   * A request outside the product band is a legitimate business fact — the
   * applicant asked for it — but it can only be approved down into the band,
   * so the officer is warned rather than blocked.
   */
  const outsideBand = useMemo(() => {
    if (!currentVersion) return null;
    const notes: string[] = [];
    if (Number.isFinite(amount) && amount > 0) {
      if (amount < currentVersion.min_amount || amount > currentVersion.max_amount) {
        notes.push(
          `amount is outside ${currentVersion.currency_code} ${currentVersion.min_amount}–${currentVersion.max_amount}`,
        );
      }
    }
    if (Number.isFinite(term) && term > 0) {
      if (
        term < currentVersion.min_term_installments ||
        term > currentVersion.max_term_installments
      ) {
        notes.push(
          `term is outside ${currentVersion.min_term_installments}–${currentVersion.max_term_installments} installments`,
        );
      }
    }
    return notes.length > 0 ? notes.join(" and ") : null;
  }, [currentVersion, amount, term]);

  const valid =
    form.branch_id !== "" &&
    form.client_id !== "" &&
    form.product_id !== "" &&
    Number.isInteger(term) &&
    term > 0 &&
    Number.isFinite(amount) &&
    amount > 0;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const payload: MfLoanApplicationInput = {
        branch_id: form.branch_id,
        client_id: form.client_id,
        group_id: form.group_id === NONE ? null : form.group_id,
        product_id: form.product_id,
        // The pricing version is resolved and pinned by the database — the
        // browser must never choose which version prices an application.
        loan_officer_id: form.loan_officer_id === NONE ? null : form.loan_officer_id,
        requested_amount: amount,
        requested_term_installments: term,
        purpose: form.purpose.trim() || null,
      };

      if (application) await onUpdate(application.id, payload);
      else await onCreate(payload);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{application ? "Edit application" : "New loan application"}</DialogTitle>
          <DialogDescription>
            Requested terms as stated by the applicant. Approval is a separate,
            attributable decision.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="application_number">Reference</Label>
            <Input
              id="application_number"
              value={application ? form.application_number : "Assigned automatically"}
              readOnly
              disabled
            />
          </div>
          <div className="space-y-1.5">
            <Label>Client</Label>
            <Select value={form.client_id} onValueChange={onClientChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.client_number} — {c.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Input
              value={branchName || (form.client_id ? "—" : "")}
              placeholder="Select a client first"
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              {form.client_id
                ? "Taken from the client's branch."
                : "Select a client first."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Loan officer</Label>
            <Select
              value={form.loan_officer_id}
              onValueChange={(v) => set("loan_officer_id", v)}
              disabled={!form.branch_id}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={form.client_id ? "Unassigned" : "Select a client first"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {branchOfficers.map((o) => (
                  <SelectItem key={o.user_id} value={o.user_id}>
                    {o.name}
                  </SelectItem>
                ))}
                {form.loan_officer_id !== NONE &&
                !branchOfficers.some((o) => o.user_id === form.loan_officer_id) ? (
                  <SelectItem value={form.loan_officer_id}>
                    Currently assigned officer
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {form.branch_id && branchOfficers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No staff are assigned to this branch.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Defaults to the client's own officer.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Loan product</Label>
            <Select value={form.product_id} onValueChange={(v) => set("product_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bandHint ? (
              <p className="text-xs text-muted-foreground">{bandHint}</p>
            ) : form.product_id ? (
              <p className="text-xs text-destructive">
                This product has no published version yet and cannot be lent on.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Group</Label>
            <Input
              value={
                clientGroup ? `${clientGroup.group_number} — ${clientGroup.name}` : ""
              }
              placeholder={
                !form.client_id
                  ? "Select a client first"
                  : groupLoading
                    ? "Checking membership…"
                    : "Not in a group"
              }
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              {!form.client_id
                ? "Select a client first."
                : groupLoading
                  ? "Checking this client's membership."
                  : clientGroup
                    ? "The client's active group. Membership is context only — liability stays individual."
                    : "This client is not in a group."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="requested_amount">
              Requested amount{currentVersion ? ` (${currentVersion.currency_code})` : ""}
            </Label>
            <Input
              id="requested_amount"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={form.requested_amount}
              onChange={(e) => set("requested_amount", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="requested_term">
              Requested term
              {currentVersion ? ` (${currentVersion.repayment_frequency} installments)` : " (installments)"}
            </Label>
            <Input
              id="requested_term"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={form.requested_term_installments}
              onChange={(e) => set("requested_term_installments", e.target.value)}
            />
          </div>
          {outsideBand ? (
            <p className="text-xs text-amber-600 sm:col-span-2 dark:text-amber-500">
              The requested {outsideBand}. That can be captured as the applicant's
              request, but approval must fall inside the product band.
            </p>
          ) : null}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="purpose">Purpose</Label>
            <Textarea
              id="purpose"
              rows={3}
              value={form.purpose}
              onChange={(e) => set("purpose", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || saving}>
            {application ? "Save changes" : "Create application"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ApplicationFormDialog;
