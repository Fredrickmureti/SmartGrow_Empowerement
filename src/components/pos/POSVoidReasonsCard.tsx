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
import { Loader2, Plus, Ban } from "lucide-react";
import { usePOSVoidReasons, POSVoidReason } from "@/hooks/pos/usePOSVoidReasons";

/**
 * Stage 5.1 polish — manage `pos_void_reasons`. Row-level security restricts
 * inserts/updates to admin / platform_admin; non-admin users see a read-only
 * list. The picker rendered inside `VoidTransactionDialog` shares the same
 * data via `usePOSVoidReasons`.
 */
export function POSVoidReasonsCard() {
  const { data: reasons = [], isLoading, create, update } = usePOSVoidReasons({
    includeInactive: true,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<POSVoidReason | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [requiresNote, setRequiresNote] = useState(false);
  const [sortOrder, setSortOrder] = useState(0);

  const startCreate = () => {
    setEditing(null);
    setCode("");
    setLabel("");
    setRequiresNote(false);
    setSortOrder(reasons.length * 10);
    setOpen(true);
  };

  const startEdit = (r: POSVoidReason) => {
    setEditing(r);
    setCode(r.code);
    setLabel(r.label);
    setRequiresNote(r.requires_note);
    setSortOrder(r.sort_order);
    setOpen(true);
  };

  const onSave = async () => {
    if (!code.trim() || !label.trim()) return;
    if (editing) {
      await update.mutateAsync({
        id: editing.id,
        code: code.trim(),
        label: label.trim(),
        requires_note: requiresNote,
        sort_order: sortOrder,
      });
    } else {
      await create.mutateAsync({
        code: code.trim(),
        label: label.trim(),
        requires_note: requiresNote,
        sort_order: sortOrder,
        is_active: true,
      });
    }
    setOpen(false);
  };

  const toggleActive = async (r: POSVoidReason) => {
    await update.mutateAsync({ id: r.id, is_active: !r.is_active });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5" />
            Void Reasons
          </CardTitle>
          <CardDescription>
            Cashiers must pick one of these when voiding a completed
            transaction. Admin-only edits.
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
                <TableHead>Requires Note</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Active</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reasons.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>{r.requires_note ? "Yes" : "No"}</TableCell>
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
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    No void reasons configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit void reason" : "New void reason"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Code</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. cashier_error"
                  disabled={!!editing}
                />
              </div>
              <div className="space-y-1">
                <Label>Label</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Cashier error"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>Requires note from cashier</Label>
                <Switch checked={requiresNote} onCheckedChange={setRequiresNote} />
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
                disabled={!code.trim() || !label.trim() || create.isPending || update.isPending}
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

export default POSVoidReasonsCard;