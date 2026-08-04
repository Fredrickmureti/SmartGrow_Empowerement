/**
 * Cross-dock qualification policy editor.
 *
 * The rule set is what turns cross-dock from a match log into an engine:
 * shelf life, lot/serial policy, QC requirement, quantity bounds, the
 * carrier cut-off window and the auto-approve score are all read by
 * `_wms_crossdock_detect` at detection time.
 *
 * Writes go through the crossdock aggregate wrapper (`useSaveCrossdockRule`).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { SlidersHorizontal } from "lucide-react";
import { useCrossdockRules, useSaveCrossdockRule, type CrossdockRule } from "./useCrossdock";

const BLANK: Partial<CrossdockRule> = {
  name: "Default cross-dock policy",
  is_active: true,
  priority: 100,
  min_shelf_life_days: 30,
  allow_lot_tracked: true,
  allow_serial_tracked: false,
  require_qc_pass: true,
  min_quantity: 1,
  max_quantity: null,
  min_hours_to_cutoff: 1,
  max_hours_to_cutoff: 48,
  require_full_line: false,
  auto_approve_score: null,
};

export function CrossdockRulesEditor({ businessId }: { businessId?: string }) {
  const { data: rules } = useCrossdockRules(businessId);
  const save = useSaveCrossdockRule(businessId);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<CrossdockRule>>(BLANK);

  const edit = (rule?: CrossdockRule) => {
    setDraft(rule ? { ...rule } : { ...BLANK });
    setOpen(true);
  };

  const num = (key: keyof CrossdockRule, label: string) => (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        value={(draft[key] as number | null) ?? ""}
        onChange={(e) =>
          setDraft((d) => ({
            ...d,
            [key]: e.target.value === "" ? null : Number(e.target.value),
          }))
        }
      />
    </div>
  );

  const toggle = (key: keyof CrossdockRule, label: string) => (
    <div className="flex items-center justify-between rounded-md border p-3">
      <Label className="font-normal">{label}</Label>
      <Switch
        checked={Boolean(draft[key])}
        onCheckedChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
      />
    </div>
  );

  return (
    <div className="mt-8 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Qualification policy</h2>
          <p className="text-xs text-muted-foreground">
            Rules decide which receipts may bypass storage, and which ones auto-approve.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => edit()}>
              <SlidersHorizontal className="h-4 w-4 mr-1" /> New rule
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{draft.id ? "Edit rule" : "New cross-dock rule"}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 @xl/page:grid-cols-2">
              <div className="@xl/page:col-span-2">
                <Label>Name</Label>
                <Input
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
              {num("priority", "Priority (lower wins)")}
              {num("min_shelf_life_days", "Min remaining shelf life (days)")}
              {num("min_quantity", "Min quantity")}
              {num("max_quantity", "Max quantity (blank = no cap)")}
              {num("min_hours_to_cutoff", "Min hours to carrier cut-off")}
              {num("max_hours_to_cutoff", "Max hours to carrier cut-off")}
              {num("auto_approve_score", "Auto-approve at score (blank = off)")}
              <div className="@xl/page:col-span-2 grid gap-2 @xl/page:grid-cols-2">
                {toggle("is_active", "Active")}
                {toggle("require_qc_pass", "Require QC pass")}
                {toggle("allow_lot_tracked", "Allow lot-tracked stock")}
                {toggle("allow_serial_tracked", "Allow serial-tracked stock")}
                {toggle("require_full_line", "Only when the full line can flow")}
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() =>
                  save.mutate(draft, { onSuccess: () => setOpen(false) })
                }
                disabled={save.isPending || !draft.name}
              >
                Save rule
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-3 space-y-2">
        {(rules ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">
            No policy yet — detection falls back to conservative defaults.
          </p>
        )}
        {(rules ?? []).map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => edit(r)}
            className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-2">
              <Badge variant={r.is_active ? "default" : "outline"}>
                {r.is_active ? "active" : "off"}
              </Badge>
              {r.name}
            </span>
            <span className="text-xs text-muted-foreground">
              shelf life {r.min_shelf_life_days ?? "n/a"}d · cut-off{" "}
              {r.min_hours_to_cutoff}–{r.max_hours_to_cutoff}h · auto-approve{" "}
              {r.auto_approve_score ?? "off"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default CrossdockRulesEditor;
