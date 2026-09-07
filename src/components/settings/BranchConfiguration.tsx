import { useMemo, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Loader2, Info, Pencil, RotateCcw, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

/**
 * Branch Configuration — per-branch hub showing the inheritance chain for
 * every whitelisted overridable setting.
 *
 * Architecture (Odoo res.company / res.branch parity):
 * - Whitelist of overridable keys lives in `branch_overridable_settings`.
 * - Tax / currency / journal / chart-of-accounts settings are deliberately
 *   NOT in the whitelist — they remain company-scoped for accounting safety.
 * - Resolution order (enforced by `resolve_branch_setting` RPC):
 *     branch_setting_overrides → business default → org default → none
 * - Writes go through `set_branch_setting` / `clear_branch_setting` which
 *   enforce whitelist + admin-only + audit-log on every change.
 */
interface BranchConfigurationProps {
  branchId: string;
  branchName: string;
  business: {
    id: string;
    logo_url?: string | null;
    address?: string | null;
    city?: string | null;
    country?: string | null;
    email?: string | null;
    phone?: string | null;
    receipt_settings?: { header?: string | null; footer?: string | null } | null;
  };

}

interface OverridableKey {
  setting_key: string;
  display_name: string;
  description: string | null;
  value_type: string; // 'text' | 'url' | 'number' | 'boolean' | 'json'
  category: string; // 'branding' | 'documents' | 'contact' | …
}

interface OverrideRow {
  setting_key: string;
  setting_value: any;
  updated_at: string;
}

interface ResolvedValue {
  value: any;
  source: "branch_override" | "inherited" | "none";
  is_overridden: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  branding: "Branding",
  documents: "Document numbering",
  contact: "Contact",
  other: "Other",
};

export function BranchConfiguration({ branchId, branchName, business }: BranchConfigurationProps) {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<OverridableKey | null>(null);
  const [clearingKey, setClearingKey] = useState<OverridableKey | null>(null);

  // 1) Whitelist (the contract).
  const { data: whitelist = [], isLoading: loadingWhitelist } = useQuery({
    queryKey: ["branch-overridable-settings"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("branch_overridable_settings")
        .select("setting_key, display_name, description, value_type, category")
        .order("category")
        .order("setting_key");
      if (error) throw error;
      return (data ?? []) as OverridableKey[];
    },
  });

  // 2) Active overrides for this branch (one query, indexed by key).
  const { data: overrides = {}, isLoading: loadingOverrides } = useQuery({
    queryKey: ["branch-setting-overrides", branchId],
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("branch_setting_overrides")
        .select("setting_key, setting_value, updated_at")
        .eq("branch_id", branchId);
      if (error) throw error;
      const map: Record<string, OverrideRow> = {};
      for (const row of (data ?? []) as OverrideRow[]) map[row.setting_key] = row;
      return map;
    },
  });

  // 3) Parent (business) values to display the inheritance source. We read
  //    the directly-mapped business columns where they exist; for keys that
  //    don't have a 1:1 column we display "(no business default)".
  const inheritedFromBusiness: Record<string, any> = useMemo(() => {
    return {
      document_logo_url: business.logo_url ?? null,
      document_address: [
        business.address,
        business.city,
        business.country,
      ].filter(Boolean).join(", ") || null,
      contact_email: business.email ?? null,
      contact_phone: business.phone ?? null,
      receipt_header: business.receipt_settings?.header ?? null,
      receipt_footer: business.receipt_settings?.footer ?? null,
    };
  }, [business]);

  const grouped = useMemo(() => {
    const out: Record<string, OverridableKey[]> = {};
    for (const k of whitelist) {
      const cat = k.category || "other";
      out[cat] = out[cat] || [];
      out[cat].push(k);
    }
    return out;
  }, [whitelist]);

  const setMutation = useMutation({
    mutationFn: async (input: { key: string; value: any; reason?: string }) => {
      const { data, error } = await (supabase as any).rpc("set_branch_setting", {
        p_branch_id: branchId,
        p_setting_key: input.key,
        p_setting_value: input.value,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Branch override saved");
      queryClient.invalidateQueries({ queryKey: ["branch-setting-overrides", branchId] });
      queryClient.invalidateQueries({ queryKey: ["document-branding"] });
    },
    onError: (err: any) => toast.error(normalizeError(err).message ?? "Failed to save override"),
  });

  const clearMutation = useMutation({
    mutationFn: async (input: { key: string; reason: string }) => {
      const { data, error } = await (supabase as any).rpc("clear_branch_setting", {
        p_branch_id: branchId,
        p_setting_key: input.key,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Override cleared — value now inherits from company");
      queryClient.invalidateQueries({ queryKey: ["branch-setting-overrides", branchId] });
      queryClient.invalidateQueries({ queryKey: ["document-branding"] });
    },
    onError: (err: any) => toast.error(normalizeError(err).message ?? "Failed to clear override"),
  });

  const isLoading = loadingWhitelist || loadingOverrides;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!whitelist.length) {
    return (
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription className="text-xs">
          No overridable settings are configured. Tax, currency, and accounting settings are intentionally
          company-scoped and cannot be overridden at the branch level.
        </AlertDescription>
      </Alert>
    );
  }

  const renderValue = (val: any, fallback = "—") => {
    if (val === null || val === undefined) return <span className="text-muted-foreground">{fallback}</span>;
    if (typeof val === "object") {
      if (val.value !== undefined) return renderValue(val.value, fallback);
      return <code className="text-xs">{JSON.stringify(val)}</code>;
    }
    return <span className="break-all">{String(val)}</span>;
  };

  return (
    <div className="space-y-4">
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertDescription className="text-xs">
          <strong>Inheritance chain:</strong> Branch override → Company default → Organization default. Tax,
          currency, journals, and chart of accounts are <em>not</em> branch-overridable by design — they
          stay company-scoped to keep accounting consistent.
        </AlertDescription>
      </Alert>

      {Object.entries(grouped).map(([category, keys]) => (
        <Card key={category}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{CATEGORY_LABEL[category] ?? category}</CardTitle>
            <CardDescription className="text-xs">
              {keys.length} {keys.length === 1 ? "setting" : "settings"} for{" "}
              <strong>{branchName}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]">Setting</TableHead>
                    <TableHead className="w-[24%]">Company default</TableHead>
                    <TableHead className="w-[24%]">Branch override</TableHead>
                    <TableHead className="w-[16%]">Effective</TableHead>
                    <TableHead className="w-[8%] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => {
                    const override = overrides[k.setting_key];
                    const overrideVal = override?.setting_value;
                    const inherited = inheritedFromBusiness[k.setting_key] ?? null;
                    const isOverridden = override !== undefined && overrideVal !== null;
                    const effective = isOverridden ? overrideVal : inherited;
                    return (
                      <TableRow key={k.setting_key}>
                        <TableCell>
                          <div className="font-medium text-sm">{k.display_name}</div>
                          {k.description && (
                            <div className="text-xs text-muted-foreground">{k.description}</div>
                          )}
                          <code className="text-[10px] text-muted-foreground">{k.setting_key}</code>
                        </TableCell>
                        <TableCell className="text-sm">
                          {renderValue(inherited, "(no company default)")}
                        </TableCell>
                        <TableCell className="text-sm">
                          {isOverridden ? (
                            <div className="space-y-1">
                              {renderValue(overrideVal)}
                              <Badge variant="outline" className="text-[10px]">
                                Overridden
                              </Badge>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">(inherits)</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {renderValue(effective, "—")}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditingKey(k)}
                              title="Set / change override"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {isOverridden && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setClearingKey(k)}
                                disabled={clearMutation.isPending}
                                title="Clear override (revert to company default)"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}

      <EditOverrideDialog
        keyDef={editingKey}
        currentValue={editingKey ? overrides[editingKey.setting_key]?.setting_value ?? "" : ""}
        inheritedValue={editingKey ? inheritedFromBusiness[editingKey.setting_key] : null}
        onClose={() => setEditingKey(null)}
        onSave={(value, reason) => {
          if (!editingKey) return;
          setMutation.mutate(
            { key: editingKey.setting_key, value, reason },
            { onSettled: () => setEditingKey(null) },
          );
        }}
        isSaving={setMutation.isPending}
      />
      <ClearOverrideDialog
        keyDef={clearingKey}
        onClose={() => setClearingKey(null)}
        onClear={(reason) => {
          if (!clearingKey) return;
          clearMutation.mutate(
            { key: clearingKey.setting_key, reason },
            { onSettled: () => setClearingKey(null) },
          );
        }}
        isClearing={clearMutation.isPending}
      />
    </div>
  );
}

interface EditOverrideDialogProps {
  keyDef: OverridableKey | null;
  currentValue: any;
  inheritedValue: any;
  onClose: () => void;
  onSave: (value: any, reason: string) => void;
  isSaving: boolean;
}

interface ClearOverrideDialogProps {
  keyDef: OverridableKey | null;
  onClose: () => void;
  onClear: (reason: string) => void;
  isClearing: boolean;
}

function ClearOverrideDialog({ keyDef, onClose, onClear, isClearing }: ClearOverrideDialogProps) {
  const [reason, setReason] = useState("");

  useMemo(() => {
    setReason("");
  }, [keyDef?.setting_key]);

  if (!keyDef) return null;

  const handleClear = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error("Reason required to clear an audited branch override.");
      return;
    }
    onClear(trimmed);
  };

  return (
    <Dialog open={!!keyDef} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clear "{keyDef.display_name}"?</DialogTitle>
          <DialogDescription className="text-xs">
            This branch will inherit the company default again. A reason is required for the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label>Reason</Label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Re-aligning branch with company defaults"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isClearing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleClear} disabled={isClearing}>
            {isClearing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Clear override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOverrideDialog({
  keyDef,
  currentValue,
  inheritedValue,
  onClose,
  onSave,
  isSaving,
}: EditOverrideDialogProps) {
  const [text, setText] = useState<string>(() => {
    if (currentValue === null || currentValue === undefined) return "";
    if (typeof currentValue === "object" && currentValue?.value !== undefined) {
      return String(currentValue.value);
    }
    return String(currentValue);
  });
  const [reason, setReason] = useState("");

  // Reset when key changes.
  useMemo(() => {
    if (currentValue === null || currentValue === undefined) {
      setText("");
    } else if (typeof currentValue === "object" && currentValue?.value !== undefined) {
      setText(String(currentValue.value));
    } else {
      setText(String(currentValue));
    }
    setReason("");
  }, [keyDef?.setting_key]);

  if (!keyDef) return null;

  const placeholder =
    inheritedValue !== null && inheritedValue !== undefined
      ? `Inherits: ${inheritedValue}`
      : "Set a branch-specific value";

  const isLong = keyDef.value_type === "text" && (text.length > 60 || text.includes("\n"));

  const handleSave = () => {
    const trimmed = text.trim();
    const trimmedReason = reason.trim();
    if (!trimmed) {
      toast.error("Value required. To remove the override, use the Clear button instead.");
      return;
    }
    if (!trimmedReason) {
      toast.error("Reason required for audited branch overrides.");
      return;
    }
    // Basic per-type validation. Server-side enforces the canonical contract.
    if (keyDef.value_type === "url" && !/^https?:\/\//i.test(trimmed)) {
      toast.error("URL must start with http:// or https://");
      return;
    }
    if (keyDef.value_type === "number" && Number.isNaN(Number(trimmed))) {
      toast.error("Value must be numeric");
      return;
    }
    const value =
      keyDef.value_type === "number" ? Number(trimmed) :
      keyDef.value_type === "boolean" ? trimmed === "true" :
      trimmed;
    onSave(value, trimmedReason);
  };

  return (
    <Dialog open={!!keyDef} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Override "{keyDef.display_name}"</DialogTitle>
          <DialogDescription className="text-xs">
            <code>{keyDef.setting_key}</code> · type {keyDef.value_type}
            {keyDef.description && <div className="mt-1">{keyDef.description}</div>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Branch value</Label>
            {isLong ? (
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={placeholder}
                rows={4}
              />
            ) : (
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={placeholder}
              />
            )}
            {inheritedValue !== null && inheritedValue !== undefined && (
              <p className="text-xs text-muted-foreground">
                Leaving this empty and clicking <em>Clear</em> in the table reverts to{" "}
                <strong>{String(inheritedValue)}</strong>.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Reason for override</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Branch operates in a different market"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
