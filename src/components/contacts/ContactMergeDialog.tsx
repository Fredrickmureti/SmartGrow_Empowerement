import { normalizeError } from "@/services/resilience";
/**
 * Phase 4a: Contact Merge/Dedupe Dialog
 * Select two contacts, preview merged record, and merge (reassign transactions).
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowRight, Merge } from "lucide-react";
import { type Contact } from "@/hooks/useContactsPaginated";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: Contact[];
  onMerged: () => void;
}

export function ContactMergeDialog({ open, onOpenChange, contacts, onMerged }: Props) {
  const [sourceId, setSourceId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  const [isMerging, setIsMerging] = useState(false);
  const { toast } = useToast();

  const source = contacts.find(c => c.id === sourceId);
  const target = contacts.find(c => c.id === targetId);

  const handleMerge = async () => {
    if (!sourceId || !targetId || sourceId === targetId) return;

    setIsMerging(true);
    try {
      // Reassign all transactions from source to target
      const tables = [
        "invoices", "bills", "payments", "bill_payments",
        "credit_notes", "sales_orders", "purchase_orders",
        "estimates", "expenses", "proforma_invoices",
      ];

      for (const table of tables) {
        const { error } = await supabase
          .from(table as any)
          .update({ contact_id: targetId } as any)
          .eq("contact_id", sourceId);
        
        // Silently skip tables that might not have contact_id
        if (error && !error.message.includes("column") && !error.message.includes("does not exist")) {
          console.warn(`Merge: failed to update ${table}:`, error.message);
        }
      }

      // Delete the source contact
      const { error: deleteError } = await supabase
        .from("contacts")
        .delete()
        .eq("id", sourceId);

      if (deleteError) throw deleteError;

      toast({
        title: "Contacts merged",
        description: `${source?.name} merged into ${target?.name}. All transactions reassigned.`,
      });

      setSourceId("");
      setTargetId("");
      onOpenChange(false);
      onMerged();
    } catch (error: any) {
      toast({
        title: "Merge failed",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="h-5 w-5" /> Merge Contacts
          </DialogTitle>
          <DialogDescription>
            Select a source contact to merge INTO a target. All transactions from the source will be reassigned to the target, then the source will be deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Source (will be deleted)</Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger>
                <SelectValue placeholder="Select source contact..." />
              </SelectTrigger>
              <SelectContent>
                {contacts.filter(c => c.id !== targetId).map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.type}) {c.email ? `— ${c.email}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-center">
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="space-y-2">
            <Label>Target (will be kept)</Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder="Select target contact..." />
              </SelectTrigger>
              <SelectContent>
                {contacts.filter(c => c.id !== sourceId).map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({c.type}) {c.email ? `— ${c.email}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {source && target && (
            <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
              <p className="text-sm font-medium">Preview</p>
              <p className="text-sm">
                <Badge variant="outline" className="mr-1">Source</Badge>
                <span className="text-destructive">{source.name}</span> will be deleted
              </p>
              <p className="text-sm">
                <Badge variant="outline" className="mr-1">Target</Badge>
                <span className="text-emerald-600">{target.name}</span> will keep all transactions
              </p>
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMerging}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleMerge}
              disabled={!sourceId || !targetId || sourceId === targetId || isMerging}
            >
              {isMerging && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Merge Contacts
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
