/**
 * Scrap reasons — organization-scoped master data CRUD.
 *
 * Reasons drive: GL offset resolution, approval thresholds, whether
 * a supporting document is required, and downstream saga routing
 * (insurance, quality hold, regulatory reporting).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
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
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react";
import type { ScrapReason } from "@/hooks/useScrap";
import { scrapQueryKeys } from "@/hooks/useScrap";

type Draft = Partial<ScrapReason> & {
  code: string;
  label: string;
};

const emptyDraft = (): Draft => ({
  code: "",
  label: "",
  description: "",
  requires_attachment: false,
  requires_approval_above: 0,
  insurance_claim_flag: false,
  quality_hold_flag: false,
  regulatory_reporting_flag: false,
  sort_order: 100,
  is_active: true,
});

export default function ScrapReasons() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: reasons = [], isLoading } = useQuery({
    queryKey: ["scrap-reasons-all", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("scrap_reasons")
        .select("*")
        .eq("organization_id", currentOrg!.id)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ScrapReason[];
    },
  });

  const upsert = useMutation({
    mutationFn: async (d: Draft) => {
      if (!currentOrg?.id) throw new Error("No organization");
      const payload = {
        organization_id: currentOrg.id,
        business_id: currentBusiness?.id ?? null,
        code: d.code.trim().toLowerCase(),
        label: d.label.trim(),
        description: d.description ?? null,
        requires_attachment: !!d.requires_attachment,
        requires_approval_above: Number(d.requires_approval_above) || 0,
        insurance_claim_flag: !!d.insurance_claim_flag,
        quality_hold_flag: !!d.quality_hold_flag,
        regulatory_reporting_flag: !!d.regulatory_reporting_flag,
        sort_order: Number(d.sort_order) || 100,
        is_active: d.is_active !== false,
        offset_account_purpose: "shrinkage",
      };
      if (editingId) {
        const { error } = await (supabase as any)
          .from("scrap_reasons")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("scrap_reasons")
          .insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editingId ? "Reason updated" : "Reason added");
      qc.invalidateQueries({ queryKey: ["scrap-reasons-all"] });
      qc.invalidateQueries({ queryKey: scrapQueryKeys.reasons(currentOrg?.id) });
      setDialogOpen(false);
      setEditingId(null);
      setDraft(emptyDraft());
    },
    onError: (err: any) => toast.error(err?.message ?? String(err)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from("scrap_reasons")
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reason deactivated");
      qc.invalidateQueries({ queryKey: ["scrap-reasons-all"] });
      qc.invalidateQueries({ queryKey: scrapQueryKeys.reasons(currentOrg?.id) });
    },
    onError: (err: any) => toast.error(err?.message ?? String(err)),
  });

  const openCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setDialogOpen(true);
  };

  const openEdit = (r: ScrapReason) => {
    setEditingId(r.id);
    setDraft({ ...r });
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Scrap reasons</h1>
          <p className="text-sm text-muted-foreground">
            Master data driving GL routing, approval thresholds, mandatory
            attachments, and downstream saga handlers (insurance, quality
            hold, regulatory reporting) for every scrap document.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Add reason
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configured reasons</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reasons.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">
              No scrap reasons configured yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead className="text-right">Approval threshold</TableHead>
                  <TableHead className="text-right">Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {reasons.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.label}</div>
                      {r.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {r.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.requires_attachment && <Badge variant="secondary">Attachment</Badge>}
                        {r.insurance_claim_flag && <Badge variant="secondary">Insurance</Badge>}
                        {r.quality_hold_flag && <Badge variant="secondary">Quality</Badge>}
                        {r.regulatory_reporting_flag && <Badge variant="secondary">Regulatory</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.requires_approval_above > 0
                        ? r.requires_approval_above.toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">{r.sort_order}</TableCell>
                    <TableCell>
                      <Badge variant={r.is_active ? "default" : "outline"}>
                        {r.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" onClick={() => openEdit(r)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {r.is_active && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            if (confirm(`Deactivate "${r.label}"?`)) remove.mutate(r.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit scrap reason" : "New scrap reason"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input
                  value={draft.code}
                  disabled={!!editingId}
                  onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
                  placeholder="e.g. damaged"
                />
              </div>
              <div className="space-y-2">
                <Label>Label *</Label>
                <Input
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder="e.g. Damaged"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={draft.description ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Guidance shown to the user picking this reason."
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Approval threshold value</Label>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={draft.requires_approval_above ?? 0}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      requires_approval_above: parseFloat(e.target.value) || 0,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0 = always require approval per org policy.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Sort order</Label>
                <Input
                  type="number"
                  value={draft.sort_order ?? 100}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, sort_order: parseInt(e.target.value) || 100 }))
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Require attachment</Label>
                <Switch
                  checked={!!draft.requires_attachment}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, requires_attachment: v }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Eligible for insurance claim</Label>
                <Switch
                  checked={!!draft.insurance_claim_flag}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, insurance_claim_flag: v }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Route to quality hold</Label>
                <Switch
                  checked={!!draft.quality_hold_flag}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, quality_hold_flag: v }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Regulatory reporting</Label>
                <Switch
                  checked={!!draft.regulatory_reporting_flag}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({ ...d, regulatory_reporting_flag: v }))
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Active</Label>
                <Switch
                  checked={draft.is_active !== false}
                  onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => upsert.mutate(draft)}
              disabled={!draft.code.trim() || !draft.label.trim() || upsert.isPending}
            >
              {upsert.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingId ? "Save changes" : "Create reason"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
