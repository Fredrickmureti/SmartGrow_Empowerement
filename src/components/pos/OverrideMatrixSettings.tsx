import { normalizeError } from "@/services/resilience";
/**
 * Stage 8.5: OverrideMatrixSettings
 *
 * Admin CRUD over `pos_override_matrix` — the single source of truth that
 * `assert_manager_override` reads at runtime to decide whether a void / refund
 * / cross-tender / cash-out / safe-drop / bank-deposit / shift-variance /
 * reopen / force-close action requires a manager PIN.
 *
 * The UI is intentionally thin (table + add row). RLS enforces that only
 * owner/admin/super_admin can write. No business logic lives here — server is
 * authoritative. This screen exists so admins don't need SQL access to tune
 * gates per business.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
// SCOPE-TRIGGER-EXEMPT: form selector for branch override matrix, not a scope switcher
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
import { Loader2, Plus, Trash2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

const ACTIONS = [
  "void_above_threshold",
  "refund",
  "cross_tender_refund",
  "discount_over_limit",
  "cash_out_above_threshold",
  "safe_drop",
  "bank_deposit",
  "shift_variance",
  "reopen_shift",
  "force_close_shift",
  "no_sale",
  "price_change",
  "manual_price",
  "delete_item",
] as const;

type MatrixRow = {
  id: string;
  organization_id: string;
  business_id: string | null;
  action: string;
  threshold_amount: number;
  require_pin: boolean;
  restricted_roles: string[];
  is_active: boolean;
};

export function OverrideMatrixSettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness, businesses } = useBusinesses();
  const qc = useQueryClient();
  const [draft, setDraft] = useState({
    action: "refund" as (typeof ACTIONS)[number],
    business_id: currentBusiness?.id ?? "",
    threshold_amount: "0",
    require_pin: true,
  });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["pos-override-matrix", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        // SCOPE-EXEMPT: org-wide override matrix; admin-only via RLS.
        .from("pos_override_matrix" as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("action");
      if (error) throw error;
      return (data ?? []) as unknown as MatrixRow[];
    },
    enabled: !!currentOrg?.id,
  });

  const businessLabel = (id: string | null) =>
    id ? businesses.find((b) => b.id === id)?.name ?? id.slice(0, 8) : "All companies";

  const update = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<MatrixRow> }) => {
      const { error } = await supabase
        .from("pos_override_matrix" as any)
        .update(input.patch as any)
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-override-matrix"] });
      toast.success("Override rule updated");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("pos_override_matrix" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-override-matrix"] });
      toast.success("Rule removed");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentOrg?.id) throw new Error("No organization");
      const { error } = await supabase.from("pos_override_matrix" as any).insert({
        organization_id: currentOrg.id,
        business_id: draft.business_id || null,
        action: draft.action,
        threshold_amount: Number(draft.threshold_amount) || 0,
        require_pin: draft.require_pin,
        restricted_roles: [],
        is_active: true,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pos-override-matrix"] });
      toast.success("Override rule added");
      setDraft((d) => ({ ...d, threshold_amount: "0" }));
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Manager Override Matrix
        </CardTitle>
        <CardDescription>
          Single source of truth for manager-PIN gates. Server-side
          (`assert_manager_override`) reads from this matrix on every gated
          action. Only owner / admin / super_admin can edit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Create row */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end p-3 rounded-lg border bg-muted/30">
          <div className="space-y-1.5">
            <Label className="text-xs">Action</Label>
            <Select
              value={draft.action}
              onValueChange={(v) => setDraft((d) => ({ ...d, action: v as any }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Scope</Label>
            <Select
              value={draft.business_id || "__all__"}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, business_id: v === "__all__" ? "" : v }))
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All companies</SelectItem>
                {businesses.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Threshold</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={draft.threshold_amount}
              onChange={(e) => setDraft((d) => ({ ...d, threshold_amount: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2 pt-5">
            <Switch
              checked={draft.require_pin}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, require_pin: v }))}
            />
            <Label className="text-xs">Always require PIN</Label>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Add rule
          </Button>
        </div>

        {/* Existing rows */}
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-6">
            No override rules configured. Server-side gates are no-ops until you add rows.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead className="text-right">Threshold</TableHead>
                <TableHead>Always require PIN</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Restricted roles</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="text-xs">{businessLabel(r.business_id)}</TableCell>
                  <TableCell className="text-right font-mono">
                    <Input
                      className="h-7 w-24 text-right text-xs ml-auto"
                      type="number"
                      step="0.01"
                      defaultValue={r.threshold_amount}
                      onBlur={(e) => {
                        const next = Number(e.target.value);
                        if (next !== r.threshold_amount) {
                          update.mutate({ id: r.id, patch: { threshold_amount: next } });
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={r.require_pin}
                      onCheckedChange={(v) => update.mutate({ id: r.id, patch: { require_pin: v } })}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={r.is_active}
                      onCheckedChange={(v) => update.mutate({ id: r.id, patch: { is_active: v } })}
                    />
                  </TableCell>
                  <TableCell>
                    {r.restricted_roles?.length ? (
                      <div className="flex gap-1 flex-wrap">
                        {r.restricted_roles.map((role) => (
                          <Badge key={role} variant="outline" className="text-xs">{role}</Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">any approver</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => remove.mutate(r.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
