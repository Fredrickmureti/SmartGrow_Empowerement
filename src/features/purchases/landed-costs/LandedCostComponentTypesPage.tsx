/**
 * LandedCostComponentTypesPage — the charge catalog behind every voucher.
 *
 * A landed cost voucher never hardcodes what "freight" or "duty" means: each
 * charge line inherits its capitalisation treatment, default allocation basis
 * and expense account from a catalog row maintained here. The catalog is
 * country-agnostic — the expense account is chosen from the business chart of
 * accounts, never inferred from a tax regime.
 */
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus } from "lucide-react";

import {
  ActionBar,
  EmptyState,
  LoadingState,
  PageBody,
  PageHeader,
} from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { supabase } from "@/integrations/supabase/client";
import type { LandedCostBasis, LandedCostComponentType } from "./useLandedCosts";

const BASES: { value: LandedCostBasis; label: string; hint: string }[] = [
  { value: "value", label: "Receipt value", hint: "Spread in proportion to line value." },
  { value: "quantity", label: "Quantity", hint: "Spread per unit received." },
  {
    value: "weight",
    label: "Weight",
    hint: "Uses the weight captured under the product's physical attributes, at the packaging level received.",
  },
  {
    value: "volume",
    label: "Volume",
    hint: "Uses the volume captured under the product's physical attributes, at the packaging level received.",
  },
  { value: "manual", label: "Manual", hint: "Operator enters each line amount." },
];

interface DraftRow {
  id: string | null;
  code: string;
  name: string;
  description: string;
  default_basis: LandedCostBasis;
  is_capitalizable: boolean;
  is_active: boolean;
  sort_order: number;
  expense_account_id: string | null;
}

const EMPTY: DraftRow = {
  id: null,
  code: "",
  name: "",
  description: "",
  default_basis: "value",
  is_capitalizable: true,
  is_active: true,
  sort_order: 0,
  expense_account_id: null,
};

export default function LandedCostComponentTypesPage() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { accounts } = useAccounts();
  const { toast } = useToast();

  const [rows, setRows] = useState<LandedCostComponentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftRow | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useMemo(
    () => async () => {
      if (!currentBusiness?.id) {
        setRows([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      const { data, error } = await supabase
        .from("landed_cost_component_types")
        .select(
          "id, code, name, description, default_basis, is_capitalizable, is_active, sort_order, expense_account_id",
        )
        .eq("business_id", currentBusiness.id)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) {
        toast({
          title: "Could not load the charge catalog",
          description: normalizeError(error).message,
          variant: "destructive",
        });
      }
      setRows((data ?? []) as LandedCostComponentType[]);
      setLoading(false);
    },
    [currentBusiness?.id, toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const accountName = (id: string | null) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} · ${a.name}` : null;
  };

  const save = async () => {
    if (!draft || !currentOrg?.id || !currentBusiness?.id) return;
    const code = draft.code.trim().toUpperCase();
    const name = draft.name.trim();
    if (!code || !name) {
      toast({
        title: "Code and name are required",
        variant: "destructive",
      });
      return;
    }
    if (!draft.is_capitalizable && !draft.expense_account_id) {
      toast({
        title: "An expense account is required",
        description:
          "Charges that are not capitalised into stock must land somewhere in the profit and loss.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    const payload = {
      organization_id: currentOrg.id,
      business_id: currentBusiness.id,
      code,
      name,
      description: draft.description.trim() || null,
      default_basis: draft.default_basis,
      is_capitalizable: draft.is_capitalizable,
      is_active: draft.is_active,
      sort_order: Number.isFinite(draft.sort_order) ? draft.sort_order : 0,
      expense_account_id: draft.expense_account_id,
    };

    const { error } = draft.id
      ? await supabase
          .from("landed_cost_component_types")
          .update(payload)
          .eq("id", draft.id)
      : await supabase.from("landed_cost_component_types").insert(payload);

    setSaving(false);
    if (error) {
      toast({
        title: "Could not save the charge type",
        description: normalizeError(error).message,
        variant: "destructive",
      });
      return;
    }
    toast({ title: draft.id ? "Charge type updated" : "Charge type added" });
    setDraft(null);
    void load();
  };

  return (
    <PageBody>
      <PageHeader
        title="Landed cost charge types"
        description="Freight, duty, insurance, brokerage and handling — each with its own capitalisation treatment, default allocation basis and expense account."
        actions={
          <ActionBar>
            <Button onClick={() => setDraft({ ...EMPTY })}>
              <Plus className="mr-2 h-4 w-4" />
              New charge type
            </Button>
          </ActionBar>
        }
      />

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No charge types yet"
          description="Add the charges your shipments actually carry. Voucher lines inherit their treatment from this catalog."
          action={
            <Button onClick={() => setDraft({ ...EMPTY })}>
              <Plus className="mr-2 h-4 w-4" />
              New charge type
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Treatment</TableHead>
              <TableHead>Default basis</TableHead>
              <TableHead>Expense account</TableHead>
              <TableHead className="text-right">Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.code}</TableCell>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  {r.description ? (
                    <div className="text-muted-foreground text-xs">{r.description}</div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge variant={r.is_capitalizable ? "default" : "secondary"}>
                    {r.is_capitalizable ? "Capitalised into stock" : "Expensed"}
                  </Badge>
                </TableCell>
                <TableCell className="capitalize">
                  {BASES.find((b) => b.value === r.default_basis)?.label ?? r.default_basis}
                </TableCell>
                <TableCell className="text-sm">
                  {accountName(r.expense_account_id) ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant={r.is_active ? "outline" : "secondary"}>
                    {r.is_active ? "Active" : "Archived"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${r.name}`}
                    onClick={() =>
                      setDraft({
                        id: r.id,
                        code: r.code,
                        name: r.name,
                        description: r.description ?? "",
                        default_basis: (r.default_basis as LandedCostBasis) ?? "value",
                        is_capitalizable: r.is_capitalizable,
                        is_active: r.is_active,
                        sort_order: r.sort_order ?? 0,
                        expense_account_id: r.expense_account_id,
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={!!draft} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit charge type" : "New charge type"}</DialogTitle>
            <DialogDescription>
              Capitalised charges uplift the unit cost of the stock they are allocated to.
              Expensed charges post straight to the account chosen here.
            </DialogDescription>
          </DialogHeader>

          {draft ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="lct-code">Code</Label>
                  <Input
                    id="lct-code"
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    placeholder="FREIGHT"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lct-sort">Sort order</Label>
                  <Input
                    id="lct-sort"
                    type="number"
                    value={draft.sort_order}
                    onChange={(e) =>
                      setDraft({ ...draft, sort_order: Number(e.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="lct-name">Name</Label>
                <Input
                  id="lct-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Inbound freight"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="lct-desc">Description</Label>
                <Textarea
                  id="lct-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label>Default allocation basis</Label>
                <Select
                  value={draft.default_basis}
                  onValueChange={(v) =>
                    setDraft({ ...draft, default_basis: v as LandedCostBasis })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BASES.map((b) => (
                      <SelectItem key={b.value} value={b.value}>
                        {b.label} — {b.hint}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">Capitalise into inventory</div>
                  <div className="text-muted-foreground text-xs">
                    Off means the charge is expensed rather than added to stock value.
                  </div>
                </div>
                <Switch
                  checked={draft.is_capitalizable}
                  onCheckedChange={(v) => setDraft({ ...draft, is_capitalizable: v })}
                />
              </div>

              <div className="space-y-2">
                <Label>
                  Expense account
                  {draft.is_capitalizable ? " (fallback)" : ""}
                </Label>
                <AccountCombobox
                  accounts={accounts}
                  value={draft.expense_account_id ?? ""}
                  onValueChange={(v) =>
                    setDraft({ ...draft, expense_account_id: v || null })
                  }
                  allowedTypes={["expense"]}
                  placeholder="Select an expense account"
                />
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">Active</div>
                  <div className="text-muted-foreground text-xs">
                    Archived types stay on historic vouchers but cannot be chosen again.
                  </div>
                </div>
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}
