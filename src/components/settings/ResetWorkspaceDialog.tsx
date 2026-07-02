import { normalizeError } from "@/services/resilience";
/**
 * ResetWorkspaceDialog — Owner-only nuclear reset.
 *
 * Calls the `reset_my_workspace(org_id, confirmation_phrase)` RPC which:
 *  - asserts the caller is owner/super_admin of this workspace,
 *  - requires the workspace name typed verbatim as confirmation,
 *  - cascade-deletes the entire organization (companies, branches, books,
 *    contacts, users, everything),
 *  - writes an entry in `admin_audit_log`.
 *
 * After success the user is signed out and routed to /signup so they can
 * start fresh — exactly the workflow described in the architecture plan.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertOctagon, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

export function ResetWorkspaceDialog() {
  const { currentOrg, userRole } = useOrganization();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  if (!currentOrg) return null;
  const isOwner = userRole?.role === "owner" || userRole?.role === "super_admin";
  if (!isOwner) return null;

  const handleReset = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("reset_my_workspace", {
        org_id: currentOrg.id,
        confirmation_phrase: phrase,
      });
      if (error) throw error;
      const result = data as { success?: boolean; message?: string } | null;
      if (!result?.success) throw new Error(result?.message ?? "Reset failed");

      toast.success("Workspace reset. Signing you out…");
      // Hard reset: sign out and bounce to signup so a clean session is started.
      await supabase.auth.signOut();
      window.location.replace("/signup");
    } catch (err: any) {
      console.error("[ResetWorkspaceDialog]", err);
      toast.error(normalizeError(err).message || "Failed to reset workspace");
    } finally {
      setBusy(false);
      setOpen(false);
      setPhrase("");
    }
  };

  return (
    <Card className="border-destructive/50 mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <AlertOctagon className="h-5 w-5 text-destructive" />
          <CardTitle className="text-base text-destructive">
            Reset Workspace (Start Fresh)
          </CardTitle>
        </div>
        <CardDescription>
          Permanently delete <strong>this entire workspace</strong> — every
          company, branch, book, contact, product, document and user. The
          workspace owner will need to sign up again to create a new workspace.
          Used to clear test data during go-live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button
            variant="destructive"
            onClick={() => setOpen(true)}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Reset Entire Workspace
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertOctagon className="h-5 w-5 text-destructive" />
              Delete workspace "{currentOrg.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  This deletes the workspace and <strong>everything</strong>{" "}
                  inside it: companies, branches, accounting books, contacts,
                  products, invoices, payments, POS sessions, users and roles.
                  This cannot be undone.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="reset-confirm">
                    Type{" "}
                    <span className="font-mono font-bold bg-muted px-1.5 py-0.5 rounded">
                      {currentOrg.name}
                    </span>{" "}
                    to confirm:
                  </Label>
                  <Input
                    id="reset-confirm"
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    placeholder={currentOrg.name}
                    className="font-mono"
                    autoComplete="off"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleReset();
              }}
              disabled={busy || phrase !== currentOrg.name}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
