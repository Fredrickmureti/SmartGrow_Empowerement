/**
 * Expense categories — create, rename, retire.
 *
 * A category only carries a name, an optional note and the expense account it
 * should post to. Nothing here touches the ledger; the account is a default
 * that the posting engine uses when an expense does not name one.
 */
import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import type { ExpenseCategory } from "@/hooks/useExpenses";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
  onCreate: (input: {
    name: string;
    description: string | null;
    account_id: string | null;
    color: string;
    is_active: boolean;
    business_id?: string | null;
  }) => Promise<unknown>;
  onRetire: (id: string) => Promise<void>;
}

export function ExpenseCategoriesDialog({
  open,
  onOpenChange,
  categories,
  onCreate,
  onRetire,
}: Props) {
  const { accounts } = useAccounts();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || null,
        account_id: accountId || null,
        color: "#6366f1",
        is_active: true,
      });
      setName("");
      setDescription("");
      setAccountId("");
      toast({ title: "Category added" });
    } catch (error) {
      toast({
        title: "Could not add the category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: string) => {
    setBusy(true);
    try {
      await onRetire(id);
      toast({ title: "Category retired" });
    } catch (error) {
      toast({
        title: "Could not retire the category",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Expense categories</DialogTitle>
          <DialogDescription>
            Group expenses for reporting. The account you pick is the default
            the system posts to for that category.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              placeholder="e.g. Fuel and transport"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cat-note">Note (optional)</Label>
            <Input
              id="cat-note"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label>Default expense account (optional)</Label>
            <AccountCombobox
              accounts={accounts}
              value={accountId}
              onValueChange={(v) => setAccountId(v || "")}
              allowedTypes={["expense"]}
              placeholder="Select expense account..."
            />
          </div>
          <div className="sm:col-span-2">
            <Button onClick={add} disabled={!name.trim() || busy}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add category
            </Button>
          </div>
        </div>

        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
          {categories.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No categories yet.
            </p>
          ) : (
            categories.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted/50"
              >
                <div>
                  <p className="text-sm font-medium">{c.name}</p>
                  {c.description && (
                    <p className="text-xs text-muted-foreground">{c.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  onClick={() => retire(c.id)}
                  aria-label={`Retire ${c.name}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
