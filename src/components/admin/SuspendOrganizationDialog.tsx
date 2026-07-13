// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, AlertTriangle } from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface SuspendOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: { id: string; name: string; is_suspended?: boolean } | null;
  onSuccess: () => void;
}

export function SuspendOrganizationDialog({
  open,
  onOpenChange,
  organization,
  onSuccess,
}: SuspendOrganizationDialogProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [reason, setReason] = useState("");

  const isSuspended = organization?.is_suspended;

  const handleAction = async () => {
    if (!organization) return;

    setIsSaving(true);
    try {
      if (isSuspended) {
        // Unsuspend
        const { error } = await supabase
          .from("organizations")
          .update({
            is_suspended: false,
            suspended_at: null,
            suspended_reason: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", organization.id);

        if (error) throw error;

        toast({
          title: "Organization unsuspended",
          description: `${organization.name} has been unsuspended and can now access the system.`,
        });
      } else {
        // Suspend
        if (!reason.trim()) {
          toast({
            title: "Reason required",
            description: "Please provide a reason for suspension.",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }

        const { error } = await supabase
          .from("organizations")
          .update({
            is_suspended: true,
            suspended_at: new Date().toISOString(),
            suspended_reason: reason.trim(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", organization.id);

        if (error) throw error;

        toast({
          title: "Organization suspended",
          description: `${organization.name} has been suspended and users will not be able to access the system.`,
        });
      }

      onSuccess();
      onOpenChange(false);
      setReason("");
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update organization status",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className={`h-5 w-5 ${isSuspended ? "text-green-500" : "text-destructive"}`} />
            {isSuspended ? "Unsuspend Organization" : "Suspend Organization"}
          </DialogTitle>
          <DialogDescription>
            {isSuspended
              ? `Unsuspend ${organization?.name} to restore access to the system.`
              : `Suspend ${organization?.name} to prevent all users from accessing the system.`}
          </DialogDescription>
        </DialogHeader>

        {!isSuspended && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="reason">Suspension Reason</Label>
              <Textarea
                id="reason"
                placeholder="Enter the reason for suspension (required)..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                This reason will be displayed to users when they try to access the system.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={isSuspended ? "default" : "destructive"}
            onClick={handleAction}
            disabled={isSaving}
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSuspended ? "Unsuspend" : "Suspend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
