import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
} from "@/components/ui/dialog";
import { Loader2, Plus, RotateCcw, ShieldAlert } from "lucide-react";
import { usePOSReturnReasons, POSReturnReason } from "@/hooks/pos/usePOSReturnReasons";

/**
 * Stage A — manage `pos_return_reasons`. RLS restricts inserts/updates to
 * admin / platform_admin; non-admin users see a read-only list. The picker
 * rendered inside `ReturnDialog` shares the same data via
 * `usePOSReturnReasons`. Per-reason `requires_manager_override` is enforced
 * server-side in `process_pos_return`.
 */
export function POSReturnReasonsCard() {
  const { data: reasons = [], isLoading, create, update } = usePOSReturnReasons({
    includeInactive: true,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<POSReturnReason | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [requiresNote, setRequiresNote] = useState(false);
  const [requiresOverride, setRequiresOverride] = useState(false);
  const [sortOrder, setSortOrder] = useState(0);

  const startCreate = () => {
    setEditing(null);
    setCode("");
    setLabel("");
    setDescription("");
    setRequiresNote(false);
    setRequiresOverride(false);
    setSortOrder(reasons.length * 10);
    setOpen(true);
  };

  const startEdit = (r: POSReturnReason) => {
    setEditing(r);
    setCode(r.code);
    setLabel(r.label);
    setDescription(r.description ?? "");
    setRequiresNote(r.requires_note);
    setRequiresOverride(r.requires_manager_override);
    setSortOrder(r.sort_order);
    setOpen(true);
  };

  const onSave = async () => {
    if (!code.trim() || !label.trim()) return;
    const trimmedDesc = description.trim() || null;
    if (editing) {
      await update.mutateAsync({
        id: editing.id,
        code: code.trim(),
        label: label.trim(),
        description: trimmedDesc,
        requires_note: requiresNote,
        requires_manager_override: requiresOverride,
        sort_order: sortOrder,
      });
    } else {
      await create.mutateAsync({
        code: code.trim(),
        label: label.trim(),
        description: trimmedDesc,
        requires_note: requiresNote,
        requires_manager_override: requiresOverride,
        sort_order: sortOrder,
        is_active: true,
      });
    }
    setOpen(false);
  };

  const toggleActive = async (r: POSReturnReason) => {
    await update.mutateAsync({ id: r.id, is_active: !r.is_active });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5" />
            Return Reasons
          </CardTitle>
          <CardDescription>
            Cashiers must pick one of these for every return line. Mark a
            reason "Requires manager override" to force a manager PIN
            approval regardless of refund amount. Admin-only edits.
          </CardDescription>
        </div>
        <Button size="sm" onClick={startCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Add Reason
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Override</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Active</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reasons.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{r.label}</span>
                      {r.description && (
                        <span className="text-xs text-muted-foreground">
                          {r.description}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{r.requires_note ? "Yes" : "No"}</TableCell>
                  <TableCell>
                    {r.requires_manager_override ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <ShieldAlert className="h-3.5 w-3.5" />
                        Required
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </TableCell>
                  <TableCell>{r.sort_order}</TableCell>
                  <TableCell>
                    <Switch
                      checked={r.is_active}
                      onCheckedChange={() => toggleActive(r)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(r)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {reasons.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-6">
                    No return reasons configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit return reason" : "New return reason"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Code</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. damaged_in_transit"
                  disabled={!!editing}
                />
              </div>
              <div className="space-y-1">
                <Label>Label</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Damaged in transit"
                />
              </div>
              <div className="space-y-1">
                <Label>Description (optional)</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Shown to cashiers as a help hint"
                  rows={2}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Requires note from cashier</Label>
                  <p className="text-xs text-muted-foreground">
                    Free-text explanation must be filled in.
                  </p>
                </div>
                <Switch checked={requiresNote} onCheckedChange={setRequiresNote} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Requires manager override</Label>
                  <p className="text-xs text-muted-foreground">
                    Forces manager PIN regardless of refund amount.
                  </p>
                </div>
                <Switch
                  checked={requiresOverride}
                  onCheckedChange={setRequiresOverride}
                />
              </div>
              <div className="space-y-1">
                <Label>Sort Order</Label>
                <Input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={onSave}
                disabled={
                  !code.trim() ||
                  !label.trim() ||
                  create.isPending ||
                  update.isPending
                }
              >
                {(create.isPending || update.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default POSReturnReasonsCard;