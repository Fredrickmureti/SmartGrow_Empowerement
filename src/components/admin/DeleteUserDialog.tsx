import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { user_id: string; email: string; full_name: string | null } | null;
  onDeleted?: () => void;
}

export function DeleteUserDialog({ open, onOpenChange, user, onDeleted }: Props) {
  const [confirmation, setConfirmation] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const expected = (user?.email ?? "").trim().toLowerCase();
  const matches = confirmation.trim().toLowerCase() === expected && expected.length > 0;

  const handleClose = (next: boolean) => {
    if (isDeleting) return;
    if (!next) setConfirmation("");
    onOpenChange(next);
  };

  const handleDelete = async () => {
    if (!user || !matches) return;
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke("platform-delete-user", {
        body: { user_id: user.user_id, confirmation: confirmation.trim() },
      });
      if (error) throw error;
      const result = data as {
        ok?: boolean;
        deleted_organizations?: string[];
        warnings?: string[];
        error?: string;
      };
      if (result?.error) throw new Error(result.error);

      const orgPart = result?.deleted_organizations?.length
        ? ` Deleted ${result.deleted_organizations.length} organization(s).`
        : "";
      toast.success(`User ${user.email} deleted.${orgPart}`);
      if (result?.warnings?.length) {
        toast.warning(`Completed with warnings: ${result.warnings.join("; ")}`);
      }
      setConfirmation("");
      onOpenChange(false);
      onDeleted?.();
    } catch (e: any) {
      console.error("[DeleteUserDialog] delete failed", e);
      const msg =
        e?.context?.error ||
        e?.message ||
        "Failed to delete user. Check the function logs.";
      toast.error(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Permanently delete user
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. The user, their profile, role
            memberships, and any organizations they own will be permanently
            removed.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {user && (
          <Alert variant="destructive">
            <AlertTitle className="text-sm">
              {user.full_name || "Unnamed user"}
            </AlertTitle>
            <AlertDescription className="text-xs break-all">
              {user.email}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="delete-user-confirm" className="text-sm">
            Type the user's email <span className="font-mono">{expected}</span> to confirm
          </Label>
          <Input
            id="delete-user-confirm"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={expected}
            autoComplete="off"
            disabled={isDeleting}
          />
        </div>

        <AlertDialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={!matches || isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting…
              </>
            ) : (
              "Delete user permanently"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}